import { tempLedger, TempLedger, clonedRepo, outboxRows } from '../ledger/helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { getTask, getVendorLink, insertVendorLink, updateTask } from '../../src/ledger/tasks';
import { trackWork } from '../../src/ledger/work';
import {
    getWorkspaceSetting, setWorkspaceSetting, SETTING_LABEL_PREFIX, SETTING_PHASE_LABEL_MAP, SETTING_RETIRED_PHASE_LABELS,
    SETTING_SYNC_POLICY, SYNC_POLICY_AUTO, readSetting,
} from '../../src/ledger/settings';
import { TaskRow, WorkspaceRow } from '../../src/ledger/types';
import { CliArg, Runner } from '../../src/cli';
import { runConfigCommand } from '../../src/config-cli';
import { pushDue, PushDeps } from '../../src/sync/push';
import { adapterFor } from '../../src/sync/runner';
import { pullWorkspace } from '../../src/sync/pull';
import { RetiredLabels, labelClash, labelNames, phaseLabelsFor, phaseLabelsFrom } from '../../src/sync/phase-labels';

const SESSION = 'labels-session';
const SOURCE = 'mcp:test';
const HOLDER = 'pid:labels-test';

const words = (args: CliArg[]): string => args.slice(0, 2).map(arg => (typeof arg === 'string' ? arg : arg.freeText)).join(' ');
const textOf = (arg: CliArg): string => (typeof arg === 'string' ? arg : arg.freeText);

/** A gh that keeps one repo's issues: enough for create, view and edit with labels. */
class FakeGh {
    readonly labels = new Map<string, string[]>();
    /** When each issue last changed; a person's edit moves it on. */
    readonly updated = new Map<string, string>();
    readonly closed = new Map<string, string>();
    readonly created: string[] = [];
    readonly calls: string[][] = [];
    constructor(readonly repo: string) {}

    /** A person's edit on GitHub: new labels, or a close, at a later time than anything stored. */
    personEdits(id: string, change: { labels?: string[]; closedAs?: string }): void {
        if (change.labels !== undefined) this.labels.set(id, change.labels);
        if (change.closedAs !== undefined) this.closed.set(id, change.closedAs);
        this.updated.set(id, new Date(Date.now() + 1000).toISOString());
    }

    private issue(id: string): object {
        const reason = this.closed.get(id);
        return {
            number: Number(id), title: `Issue ${id}`, body: '', state: reason === undefined ? 'OPEN' : 'CLOSED', stateReason: reason ?? null,
            labels: (this.labels.get(id) ?? []).map(name => ({ name })), assignees: [], milestone: null,
            updatedAt: this.updated.get(id) ?? new Date().toISOString(), url: `https://github.com/${this.repo}/issues/${id}`,
        };
    }

    run: Runner = async (_command, args) => {
        this.calls.push(args.map(textOf));
        const at = (flag: string): string[] => args.flatMap((arg, index) => (arg === flag ? [textOf(args[index + 1])] : []));
        switch (words(args)) {
            case 'label create':
                this.created.push(textOf(args[2]));
                return '';
            case 'issue edit': {
                const id = textOf(args[2]);
                const removed = at('--remove-label').map(label => label.toLowerCase());
                const kept = (this.labels.get(id) ?? []).filter(label => removed.indexOf(label.toLowerCase()) < 0);
                this.labels.set(id, kept.concat(at('--add-label')));
                return '';
            }
            case 'issue view':
                return JSON.stringify(this.issue(textOf(args[2])));
            case 'issue list':
                return JSON.stringify(Array.from(this.labels.keys()).map(id => this.issue(id)));
            case 'api user':
                return 'octocat\n';
            default:
                return '';
        }
    };
}

describe('phase labels', () => {
    let ledger: TempLedger;
    let repo: string;
    let workspace: WorkspaceRow;
    let gh: FakeGh;
    let deps: PushDeps;

    const config = (...argv: string[]): string => runConfigCommand(ledger.db, argv, repo);
    const track = (title = 'Login fix'): TaskRow =>
        trackWork(ledger.db, { sessionId: SESSION, source: SOURCE, workspaceId: workspace.id, title, intent: 'implement' }).task;
    /** A task linked to issue `id`, pushed as it is: nothing queued. */
    const linked = (id: string, phase: TaskRow['phase'], labels: string[]): TaskRow => {
        const task = track(`Issue ${id}`);
        updateTask(ledger.db, task.id, { phase }, { source: SOURCE, human: true });
        insertVendorLink(ledger.db, {
            taskId: task.id, vendor: 'github', remoteId: id, remoteState: 'open', labels: JSON.stringify(labels),
            remoteTitle: `Issue ${id}`, lastPushedRev: getTask(ledger.db, task.id)!.rev, remoteUpdatedAt: '2026-01-01T00:00:00Z',
        });
        ledger.db.prepare('DELETE FROM outbox WHERE task_id = ?').run(task.id);
        gh.labels.set(id, labels);
        return getTask(ledger.db, task.id)!;
    };

    beforeEach(() => {
        ledger = tempLedger();
        repo = clonedRepo(ledger.dir, 'repo', `https://github.com/acme/labels-${Date.now()}-${Math.random().toString(16).slice(2)}.git`);
        workspace = ensureWorkspace(ledger.db, repo);
        setWorkspaceSetting(ledger.db, workspace.id, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);
        gh = new FakeGh(workspace.git_remote!.replace('https://github.com/', '').replace(/\.git$/, ''));
        deps = { holder: HOLDER, now: () => Date.now(), adapterFor: (ws, guard) => adapterFor(ledger.db, ws, guard(gh.run)) };
    });

    afterEach(() => ledger.cleanup());

    describe('settings', () => {
        it('defaults to ghostpm:<phase>', () => {
            expect(config('get', 'label_prefix')).toBe('label_prefix = "ghostpm:" (default)');
            expect(labelNames('ghostpm:', {})).toEqual({
                brainstorming: 'ghostpm:brainstorming', planned: 'ghostpm:planned', in_progress: 'ghostpm:in_progress', in_review: 'ghostpm:in_review',
            });
        });

        it('takes any prefix, the empty one included, and refuses what gh would misread', () => {
            expect(config('set', 'label_prefix', 'status: ')).toBe('label_prefix = "status: " (global)');
            expect(config('set', 'label_prefix', '')).toBe('label_prefix = "" (global)');
            expect(() => config('set', 'label_prefix', 'a,b')).toThrow('comma');
            expect(() => config('set', 'label_prefix', ' lead')).toThrow('start or end with a space');
            expect(() => config('set', 'label_prefix', 'x'.repeat(40))).toThrow('at most 37 characters');
        });

        it('merges phase_label_map pairs, removes one with phase=, and refuses closed phases', () => {
            expect(config('set', 'phase_label_map', 'in_progress=In progress', '--workspace', repo)).toContain('{"in_progress":"In progress"}');
            expect(config('set', 'phase_label_map', 'in_review=Review', '--workspace', repo)).toContain('{"in_progress":"In progress","in_review":"Review"}');
            expect(config('set', 'phase_label_map', 'in_progress=', '--workspace', repo)).toContain('{"in_review":"Review"}');
            expect(config('set', 'phase_label_map', 'in_review=', '--workspace', repo)).toContain('phase_label_map unset');
            expect(() => config('set', 'phase_label_map', 'done=Shipped')).toThrow('phases are brainstorming, planned, in_progress, in_review');
            expect(() => config('set', 'phase_label_map', 'planned=a,b')).toThrow('comma');
        });

        it('rolls back a change that would give two phases one label', () => {
            config('set', 'label_prefix', '', '--workspace', repo);
            expect(() => config('set', 'phase_label_map', 'planned=IN_PROGRESS', '--workspace', repo))
                .toThrow('Not changed: planned and in_progress would both be labelled');
            expect(readSetting(ledger.db, workspace.id, SETTING_PHASE_LABEL_MAP)).toEqual({});
            expect(labelClash(labelNames('', { planned: 'In_Progress' }))).toEqual(['planned', 'in_progress']);
        });

        it('merges phase_state_map pairs instead of dropping the other phases', () => {
            config('set', 'phase_state_map', 'planned=New', 'in_progress=Active', 'done=Closed', '--workspace', repo);
            expect(config('set', 'phase_state_map', 'done=Done', '--workspace', repo))
                .toContain('{"planned":"New","in_progress":"Active","done":"Done"}');
        });
    });

    describe('pulling', () => {
        const pull = () => pullWorkspace(ledger.db, workspace, deps);

        it("reads a person's move to a custom label as their phase change, and leaves the label as they set it", async () => {
            config('set', 'label_prefix', '', '--workspace', repo);
            config('set', 'phase_label_map', 'in_review=Ready for review', '--workspace', repo);
            const task = linked('11', 'in_progress', ['bug', 'in_progress']);
            gh.updated.set('11', '2026-01-01T00:00:00Z');
            gh.personEdits('11', { labels: ['bug', 'Ready for review'] });

            const summary = await pull();

            expect(summary.humanEdits).toBe(1);
            expect(getTask(ledger.db, task.id)).toMatchObject({ phase: 'in_review' });
            expect(getTask(ledger.db, task.id)!.human_phase_at).not.toBeNull();
            await pushDue(ledger.db, deps);
            expect(gh.labels.get('11')).toEqual(['bug', 'Ready for review']);
        });

        it('reads a close on GitHub (a merged "Fixes #N", or a person) as done, and tidies the custom label', async () => {
            config('set', 'label_prefix', 'status: ', '--workspace', repo);
            const task = linked('12', 'in_review', ['status: in_review']);
            gh.updated.set('12', '2026-01-01T00:00:00Z');
            gh.personEdits('12', { closedAs: 'COMPLETED' });

            await pull();
            expect(getTask(ledger.db, task.id)!.phase).toBe('done');
            await pushDue(ledger.db, deps);

            expect(gh.labels.get('12')).toEqual([]);
            expect(gh.calls.some(call => call[0] === 'issue' && (call[1] === 'close' || call[1] === 'reopen'))).toBe(false);
        });
    });

    describe('relabelling', () => {
        it('moves open issues to the new labels on the next sync, leaving their other labels and closed work alone', async () => {
            const open = linked('7', 'in_progress', ['bug', 'ghostpm:in_progress']);
            const done = linked('8', 'done', ['bug']);

            expect(config('set', 'label_prefix', '', '--workspace', repo)).toContain('1 open issue will be relabelled on the next sync.');
            // The defaults need no remembering: they always read as their phase.
            expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_RETIRED_PHASE_LABELS)).toBeUndefined();
            expect(phaseLabelsFor(ledger.db, workspace.id).phaseOf('ghostpm:in_progress')).toBe('in_progress');
            expect(outboxRows(ledger.db, done.id)).toEqual([]);

            const summary = await pushDue(ledger.db, deps);

            expect(summary.failed).toBe(0);
            expect(gh.labels.get('7')).toEqual(['bug', 'in_progress']);
            expect(gh.created).toEqual(['in_progress']);
            expect(getTask(ledger.db, open.id)!.phase).toBe('in_progress');   // our relabel is not a person's edit
            expect(getVendorLink(ledger.db, open.id)!.last_pushed_rev).toBe(getTask(ledger.db, open.id)!.rev);
        });

        it('replaces the label of a custom prefix that is retired again, and keeps reading it until then', async () => {
            config('set', 'label_prefix', 'wip-', '--workspace', repo);
            linked('9', 'in_review', ['wip-in_review']);
            config('set', 'phase_label_map', 'in_review=Ready for review', '--workspace', repo);
            const labels = phaseLabelsFor(ledger.db, workspace.id);
            expect(labels.phaseOf('wip-in_review')).toBe('in_review');
            expect(labels.label('in_review')).toBe('Ready for review');

            await pushDue(ledger.db, deps);

            expect(gh.labels.get('9')).toEqual(['Ready for review']);
        });

        it('queues nothing while sync is off, but still retires the old labels for the next push', () => {
            linked('5', 'planned', ['ghostpm:planned']);
            setWorkspaceSetting(ledger.db, workspace.id, SETTING_SYNC_POLICY, 'off');
            expect(config('set', 'label_prefix', 'x:', '--workspace', repo)).toBe(`label_prefix = "x:" (workspace ${workspace.path})`);
            expect(phaseLabelsFor(ledger.db, workspace.id).isOurs('ghostpm:planned')).toBe(true);
        });

        it('a global change moves only the workspaces without their own value', () => {
            const other = ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'other', 'https://github.com/acme/other.git'));
            setWorkspaceSetting(ledger.db, other.id, SETTING_LABEL_PREFIX, 'mine:');
            expect(config('set', 'label_prefix', 'team:')).toBe('label_prefix = "team:" (global)');
            expect(phaseLabelsFor(ledger.db, workspace.id).label('planned')).toBe('team:planned');
            expect(phaseLabelsFor(ledger.db, other.id).label('planned')).toBe('mine:planned');
            expect(getWorkspaceSetting(ledger.db, other.id, SETTING_RETIRED_PHASE_LABELS)).toBeUndefined();
        });

        it('a label back in use is current, not retired', () => {
            config('set', 'label_prefix', 'x:', '--workspace', repo);
            config('unset', 'label_prefix', '--workspace', repo);
            const retired = getWorkspaceSetting<RetiredLabels>(ledger.db, workspace.id, SETTING_RETIRED_PHASE_LABELS)!;
            expect(Object.keys(retired)).toEqual(['x:brainstorming', 'x:planned', 'x:in_progress', 'x:in_review']);
            expect(phaseLabelsFrom('ghostpm:', {}, retired).label('planned')).toBe('ghostpm:planned');
        });
    });
});
