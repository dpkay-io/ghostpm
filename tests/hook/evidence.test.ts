import * as fs from 'fs';
import * as path from 'path';
import { tempLedger, TempLedger } from '../ledger/helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask, getTask } from '../../src/ledger/tasks';
import { listEvents } from '../../src/ledger/events';
import { startSession, setSessionTask } from '../../src/ledger/sessions';
import { setSetting, SETTING_PLAN_GLOBS } from '../../src/ledger/settings';
import { EventKind, Phase, TaskRow } from '../../src/ledger/types';
import { readPayload, ToolCall } from '../../src/hook/payload';
import { handleWith, HOOK_CLIENT } from '../../src/hook/handlers';

const SESSION_ID = 'claude-evidence';

describe('PostToolBatch evidence', () => {
    let ledger: TempLedger;
    let repo: string;
    let workspaceId: number;
    let active: TaskRow;

    const batch = (...toolCalls: ToolCall[]): string | null =>
        handleWith(ledger.db, readPayload(JSON.stringify({
            hook_event_name: 'PostToolBatch', session_id: SESSION_ID, cwd: repo, tool_calls: toolCalls,
        }), 'PostToolBatch'));

    const kindsFor = (taskId: number): EventKind[] =>
        listEvents(ledger.db, { taskId }).map(entry => entry.kind);

    const payloadsOf = (taskId: number, kind: EventKind): any[] =>
        listEvents(ledger.db, { taskId, kinds: [kind] })
            .map(entry => (entry.payload === null ? null : JSON.parse(entry.payload)));

    beforeEach(() => {
        ledger = tempLedger();
        repo = path.join(ledger.dir, 'repo');
        fs.mkdirSync(repo, { recursive: true });
        workspaceId = ensureWorkspace(ledger.db, repo).id;
        active = createTask(ledger.db, { title: 'Login fix', phase: 'in_progress', workspaceId, origin: 'local', source: 'test' });
        startSession(ledger.db, { id: SESSION_ID, client: HOOK_CLIENT, cwd: repo, workspaceId });
        setSessionTask(ledger.db, SESSION_ID, active.id);
    });

    afterEach(() => {
        ledger.cleanup();
    });

    it('records the files touched by Write and Edit in one event per batch, injecting nothing', () => {
        const injected = batch(
            { tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } },
            { tool_name: 'Edit', tool_input: { file_path: 'src/b.ts' } },
        );

        // Asserting null only means something next to proof the handler ran: alone it
        // passes whether or not PostToolBatch is handled at all.
        expect(injected).toBeNull();
        const progress = payloadsOf(active.id, 'progress');
        expect(progress).toHaveLength(1);
        expect(progress[0].files).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('lists each touched file once however many times it was edited', () => {
        batch(
            { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } },
            { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } },
        );

        expect(payloadsOf(active.id, 'progress')[0].files).toEqual(['src/a.ts']);
    });

    it('records a commit event when a Bash call commits', () => {
        batch({ tool_name: 'Bash', tool_input: { command: 'git commit -m "fix upload"' } });

        expect(kindsFor(active.id)).toContain('commit');
    });

    it("records a commit and a pr made through Claude Code's PowerShell tool, as through Bash", () => {
        // The payload shape Claude Code 2.1.302 sends for its PowerShell tool (captured from a real PostToolBatch).
        batch(
            { tool_name: 'PowerShell', tool_input: { command: 'git commit --allow-empty -m probe' }, tool_response: '[master 1e2b438] probe' },
            { tool_name: 'PowerShell', tool_input: { command: 'gh pr create --fill' }, tool_response: 'https://github.com/acme/app/pull/44\n' },
        );

        expect(kindsFor(active.id)).toContain('commit');
        expect(payloadsOf(active.id, 'pr').map(pr => pr.url)).toEqual(['https://github.com/acme/app/pull/44']);
    });

    it.each([
        'git -C "C:\\my repo" commit -m "fix upload"',
        "git -C '/tmp/my repo' commit -m x",
        'git -c user.name=Probe -c user.email=p@x commit --allow-empty -m probe',
        'git --no-pager commit -m x',
        'git --git-dir=.git --work-tree=. commit -m x',
        'cd app && git -C . commit -am x',
    ])('records a commit with git options before the subcommand: %s', command => {
        batch({ tool_name: 'Bash', tool_input: { command } });

        expect(kindsFor(active.id)).toContain('commit');
    });

    it.each([
        'git status',
        'git -C repo log --grep commit',
        'git -c core.pager=less show HEAD',
        'echo commit',
    ])('does not treat every git command as a commit: %s', command => {
        batch({ tool_name: 'Bash', tool_input: { command } });

        expect(kindsFor(active.id)).not.toContain('commit');
    });

    it('records a pr event with the URL a pr create prints', () => {
        batch({
            tool_name: 'Bash',
            tool_input: { command: 'gh pr create --fill' },
            tool_response: 'https://github.com/acme/app/pull/42\n',
        });

        const prs = payloadsOf(active.id, 'pr');
        expect(prs).toHaveLength(1);
        expect(prs[0].url).toBe('https://github.com/acme/app/pull/42');
    });

    it("records the pull request's URL, never the /pull/new/<branch> hint git push prints before it (F9)", () => {
        batch({
            tool_name: 'Bash',
            tool_input: { command: 'git push -u origin feature && gh pr create --fill' },
            tool_response: "remote: Create a pull request for 'feature' on GitHub by visiting:\n"
                + 'remote:      https://github.com/acme/app/pull/new/feature\n'
                + '{"see":"https://github.com/acme/app","pr":"https://github.com/acme/app/pull/43"}\n',
        });

        expect(payloadsOf(active.id, 'pr').map(pr => pr.url)).toEqual(['https://github.com/acme/app/pull/43']);
    });

    it('records an Azure DevOps pull request URL (F9)', () => {
        batch({
            tool_name: 'Bash',
            tool_input: { command: 'az repos pr create --open' },
            tool_response: 'Opening https://dev.azure.com/acme/Widgets/_git/web/pullrequest/34 in a browser\n',
        });

        expect(payloadsOf(active.id, 'pr').map(pr => pr.url)).toEqual(['https://dev.azure.com/acme/Widgets/_git/web/pullrequest/34']);
    });

    it('records no pr when a pr create prints no pull request URL (F9)', () => {
        batch({
            tool_name: 'Bash',
            tool_input: { command: 'gh pr create --fill' },
            tool_response: 'pull request create failed: see https://docs.github.com/rest\n',
        });

        expect(kindsFor(active.id)).not.toContain('pr');
    });

    it('records nothing at all when the session has no task', () => {
        setSessionTask(ledger.db, SESSION_ID, null);

        batch({ tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } });

        expect(kindsFor(active.id)).toEqual(['created']);
    });

    it('records nothing for a batch with no evidence in it', () => {
        batch({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } });

        expect(kindsFor(active.id)).toEqual(['created']);
    });

    describe('moves the phase forward (spec §7.3)', () => {
        const attachNew = (phase: Phase): TaskRow => {
            const task = createTask(ledger.db, { title: 'Phase task', phase, workspaceId, origin: 'local', source: 'test' });
            setSessionTask(ledger.db, SESSION_ID, task.id);
            return task;
        };
        const phaseNow = (task: TaskRow): Phase => getTask(ledger.db, task.id)!.phase;
        const write = (file: string): ToolCall => ({ tool_name: 'Write', tool_input: { file_path: file } });
        const planFile = (): string => path.join(repo, 'docs', 'superpowers', 'plans', 'login.md');

        it('moves a brainstorm to planned when a plan file is written', () => {
            const task = attachNew('brainstorming');
            batch(write(planFile()));
            expect(phaseNow(task)).toBe('planned');
        });

        it('matches a relative tool path against the session folder', () => {
            const task = attachNew('brainstorming');
            batch(write('docs/specs/login.md'));
            expect(phaseNow(task)).toBe('planned');
        });

        it('moves to in_progress on the first edit outside the plan files', () => {
            const task = attachNew('planned');
            batch(write(planFile()), { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src', 'login.ts') } });
            expect(phaseNow(task)).toBe('in_progress');
        });

        it('moves to in_progress on a commit', () => {
            const task = attachNew('planned');
            batch({ tool_name: 'Bash', tool_input: { command: 'git commit -m "login"' } });
            expect(phaseNow(task)).toBe('in_progress');
        });

        it('moves to in_review when a PR is created', () => {
            const task = attachNew('in_progress');
            batch({ tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' }, tool_response: 'https://github.com/acme/app/pull/7\n' });
            expect(phaseNow(task)).toBe('in_review');
        });

        it('does not move work backwards when a plan file is touched later', () => {
            const task = attachNew('in_review');
            batch(write(planFile()));
            expect(phaseNow(task)).toBe('in_review');
        });

        it('leaves a done task done: only track_work reopens', () => {
            const task = attachNew('done');
            batch(write(path.join(repo, 'src', 'login.ts')));
            expect(phaseNow(task)).toBe('done');
        });

        it('uses the plan_globs setting', () => {
            setSetting(ledger.db, SETTING_PLAN_GLOBS, ['notes/*.md']);
            const task = attachNew('brainstorming');
            batch(write(path.join(repo, 'notes', 'idea.md')));
            expect(phaseNow(task)).toBe('planned');
            batch(write(planFile()));
            expect(phaseNow(task)).toBe('in_progress');
        });
    });
});
