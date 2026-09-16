import * as fs from 'fs';
import * as path from 'path';
import { tempLedger, TempLedger } from '../ledger/helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask } from '../../src/ledger/tasks';
import { getSession, startSession, setSessionTask } from '../../src/ledger/sessions';
import { taskBranchName } from '../../src/ledger/branch';
import { Phase, TaskRow } from '../../src/ledger/types';
import { readPayload } from '../../src/hook/payload';
import { handleWith, HOOK_CLIENT } from '../../src/hook/handlers';

const SESSION_ID = 'claude-prompt';

describe('UserPromptSubmit handler', () => {
    let ledger: TempLedger;
    let repo: string;
    let workspaceId: number;

    const task = (title: string, phase: Phase = 'in_progress'): TaskRow =>
        createTask(ledger.db, { title, phase, workspaceId, origin: 'local', source: 'test' });

    const onBranch = (branch: string): void => {
        const gitDir = path.join(repo, '.git');
        fs.mkdirSync(gitDir, { recursive: true });
        fs.writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`, 'utf8');
    };

    const promptSubmit = (prompt = 'add a retry to the upload'): string | null =>
        handleWith(ledger.db, readPayload(JSON.stringify({
            hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, cwd: repo, prompt,
        }), 'UserPromptSubmit'));

    beforeEach(() => {
        ledger = tempLedger();
        repo = path.join(ledger.dir, 'repo');
        fs.mkdirSync(repo, { recursive: true });
        workspaceId = ensureWorkspace(ledger.db, repo).id;
    });

    afterEach(() => {
        ledger.cleanup();
    });

    it('reports the attached task tersely, without a candidate list', () => {
        const active = task('Login fix');
        task('Something else');
        startSession(ledger.db, { id: SESSION_ID, client: HOOK_CLIENT, cwd: repo, workspaceId });
        setSessionTask(ledger.db, SESSION_ID, active.id);

        const text = promptSubmit()!;

        expect(text).toContain(`T${active.id}`);
        expect(text).toContain('in_progress');
        expect(text).not.toContain('Something else');
        expect(text).not.toContain('track_work');
    });

    it('injects the instruction and candidates when no task is attached', () => {
        const candidate = task('Upload retry');
        startSession(ledger.db, { id: SESSION_ID, client: HOOK_CLIENT, cwd: repo, workspaceId });

        const text = promptSubmit()!;

        expect(text).toContain('track_work');
        expect(text).toContain(`T${candidate.id}`);
        expect(text).toContain('Upload retry');
    });

    it('still instructs the model when there is nothing to suggest', () => {
        startSession(ledger.db, { id: SESSION_ID, client: HOOK_CLIENT, cwd: repo, workspaceId });
        expect(promptSubmit()).toContain('track_work');
    });

    it('prefers the branch task over other candidates', () => {
        const branchTask = task('On the branch');
        task('Not on the branch');
        onBranch(taskBranchName(branchTask.id));
        startSession(ledger.db, { id: SESSION_ID, client: HOOK_CLIENT, cwd: repo, workspaceId });

        const text = promptSubmit()!;

        expect(text.indexOf(`T${branchTask.id}`)).toBeGreaterThan(-1);
        expect(text.indexOf(`T${branchTask.id}`)).toBeLessThan(text.indexOf('Not on the branch'));
    });

    it('heartbeats the session without detaching its task', () => {
        // touchSession, not startSession: a prompt is not a new session, and restarting
        // one clears task_id, which would drop the attachment on every single prompt.
        const active = task('Login fix');
        startSession(ledger.db, { id: SESSION_ID, client: HOOK_CLIENT, cwd: repo, workspaceId });
        setSessionTask(ledger.db, SESSION_ID, active.id);
        const before = getSession(ledger.db, SESSION_ID)!;

        const text = promptSubmit();

        // Asserting the handler actually ran matters: without this the rest of the
        // expectations hold trivially when nothing happens at all.
        expect(text).toContain(`T${active.id}`);
        const after = getSession(ledger.db, SESSION_ID)!;
        expect(after.task_id).toBe(active.id);
        expect(after.started_at).toBe(before.started_at);
        expect(after.last_seen_at >= before.last_seen_at).toBe(true);
    });

    it('registers a session that SessionStart never recorded', () => {
        // SessionEnd is not guaranteed to fire and neither is SessionStart reaching us
        // first; a prompt must still be attributable to a session row.
        expect(promptSubmit()).toContain('track_work');
        expect(getSession(ledger.db, SESSION_ID)).toMatchObject({ id: SESSION_ID, workspace_id: workspaceId });
    });
});
