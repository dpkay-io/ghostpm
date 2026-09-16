import * as fs from 'fs';
import * as path from 'path';
import { tempLedger, TempLedger } from '../ledger/helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask } from '../../src/ledger/tasks';
import { getSession } from '../../src/ledger/sessions';
import { taskBranchName } from '../../src/ledger/branch';
import { Phase, TaskRow } from '../../src/ledger/types';
import { readPayload } from '../../src/hook/payload';
import { handleWith, HOOK_CLIENT } from '../../src/hook/handlers';

const SESSION_ID = 'claude-abc123';

describe('SessionStart handler', () => {
    let ledger: TempLedger;
    let repo: string;
    let workspaceId: number;

    const onBranch = (branch: string): void => {
        const gitDir = path.join(repo, '.git');
        fs.mkdirSync(gitDir, { recursive: true });
        fs.writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`, 'utf8');
    };

    const task = (title: string, phase: Phase = 'in_progress'): TaskRow =>
        createTask(ledger.db, { title, phase, workspaceId, origin: 'local', source: 'test' });

    const sessionStart = (sessionId: string = SESSION_ID): string | null =>
        handleWith(ledger.db, readPayload(JSON.stringify({
            hook_event_name: 'SessionStart', session_id: sessionId, cwd: repo,
        }), 'SessionStart'));

    beforeEach(() => {
        ledger = tempLedger();
        repo = path.join(ledger.dir, 'repo');
        fs.mkdirSync(repo, { recursive: true });
        workspaceId = ensureWorkspace(ledger.db, repo).id;
    });

    afterEach(() => {
        ledger.cleanup();
    });

    it('registers the session against the workspace', () => {
        sessionStart();
        const session = getSession(ledger.db, SESSION_ID);
        expect(session).toMatchObject({ id: SESSION_ID, client: HOOK_CLIENT, workspace_id: workspaceId });
        expect(session!.ended_at).toBeNull();
    });

    it('injects the task named by the branch, with its phase', () => {
        const resuming = task('Login fix');
        onBranch(taskBranchName(resuming.id));

        const text = sessionStart();

        expect(text).toContain(`T${resuming.id}`);
        expect(text).toContain('Login fix');
        expect(text).toContain('in_progress');
    });

    it('injects nothing when the branch names no task', () => {
        task('Login fix');
        onBranch('master');
        expect(sessionStart()).toBeNull();
    });

    it('injects nothing outside a repository', () => {
        task('Login fix');
        expect(sessionStart()).toBeNull();
    });

    it('still registers the session when the branch task was deleted', () => {
        onBranch('task/T999');
        expect(sessionStart()).toBeNull();
        expect(getSession(ledger.db, SESSION_ID)).toBeDefined();
    });

    it('ignores an event it has no handler for', () => {
        const payload = readPayload(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SESSION_ID, cwd: repo }), 'PreToolUse');
        expect(handleWith(ledger.db, payload)).toBeNull();
    });

    it('does not register a session when the payload carries no session id', () => {
        // A payload with no session_id cannot be correlated later; recording it would
        // create a row keyed on the empty string that every such hook would then share.
        expect(sessionStart('')).toBeNull();
        expect(getSession(ledger.db, '')).toBeUndefined();
    });
});
