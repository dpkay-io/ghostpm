import * as fs from 'fs';
import * as path from 'path';
import { tempLedger, TempLedger, clonedRepo } from '../ledger/helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask } from '../../src/ledger/tasks';
import { getSession } from '../../src/ledger/sessions';
import { taskBranchName } from '../../src/ledger/branch';
import { Phase, TaskRow } from '../../src/ledger/types';
import { readPayload } from '../../src/hook/payload';
import { handleWith, HookOptions, HOOK_CLIENT } from '../../src/hook/handlers';
import {
    deleteSetting, setSetting, setWorkspaceSetting, SETTING_LAST_SYNC, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO, SYNC_POLICY_OFF,
} from '../../src/ledger/settings';
import { acquireLease } from '../../src/sync/lease';

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

    describe('starting a background sync (spec §8.1)', () => {
        let started: number;
        let widgets: string;
        let originalHome: string | undefined;
        const startSync = (): void => { started++; };
        const sessionStartIn = (cwd: string, options: HookOptions): string | null => handleWith(
            ledger.db,
            readPayload(JSON.stringify({ hook_event_name: 'SessionStart', session_id: SESSION_ID, cwd }), 'SessionStart'),
            options,
        );
        const queuePush = (workspaceId: number): void => {
            const queued = createTask(ledger.db, { title: 'Queued', phase: 'planned', workspaceId, origin: 'local', source: 'test' });
            ledger.db.prepare("INSERT INTO outbox (task_id, op, status, next_attempt_at) VALUES (?, 'create', 'pending', ?)")
                .run(queued.id, new Date(0).toISOString());
        };

        beforeEach(() => {
            started = 0;
            // The global default is off; these tests are about workspaces that opted in.
            setSetting(ledger.db, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);
            widgets = clonedRepo(ledger.dir, 'widgets');
            // A failed spawn is logged: keep hook.log in the temp dir.
            originalHome = process.env.GHOSTPM_HOME;
            process.env.GHOSTPM_HOME = ledger.dir;
        });

        afterEach(() => {
            if (originalHome !== undefined) process.env.GHOSTPM_HOME = originalHome;
            else delete process.env.GHOSTPM_HOME;
        });

        it('starts one when a pull is due and nobody holds the sync lease', () => {
            sessionStartIn(widgets, { startSync });
            expect(started).toBe(1);
        });

        it('leaves it to the live lease holder', () => {
            acquireLease(ledger.db, 'pid:mcp-server');
            sessionStartIn(widgets, { startSync });
            expect(started).toBe(0);
        });

        it('starts one for queued pushes even when no pull is due', () => {
            const workspaceId = ensureWorkspace(ledger.db, widgets).id;
            setWorkspaceSetting(ledger.db, workspaceId, SETTING_LAST_SYNC, new Date().toISOString());
            sessionStartIn(widgets, { startSync });
            expect(started).toBe(0);

            queuePush(workspaceId);
            sessionStartIn(widgets, { startSync });
            expect(started).toBe(1);
        });

        it('starts nothing for a folder with no vendor and nothing queued', () => {
            sessionStartIn(repo, { startSync });
            expect(started).toBe(0);
        });

        it('starts nothing in a workspace whose sync_policy is off, by default or by choice, even with work due (ruling 4)', () => {
            const workspaceId = ensureWorkspace(ledger.db, widgets).id;
            queuePush(workspaceId);   // queued before sync was switched off; a pull is due as well

            deleteSetting(ledger.db, SETTING_SYNC_POLICY);
            sessionStartIn(widgets, { startSync });
            expect(started).toBe(0);

            setSetting(ledger.db, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);
            setWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY, SYNC_POLICY_OFF);
            sessionStartIn(widgets, { startSync });
            expect(started).toBe(0);
        });

        it('keeps the resume line when starting the sync fails', () => {
            // T<id> branch refs resolve machine-wide, so the task may live in another workspace.
            const resuming = task('Login fix');
            fs.writeFileSync(path.join(widgets, '.git', 'HEAD'), `ref: refs/heads/${taskBranchName(resuming.id)}\n`, 'utf8');
            const text = sessionStartIn(widgets, { startSync: () => { throw new Error('spawn EPERM'); } });
            expect(text).toContain(`Resuming T${resuming.id}`);
        });
    });
});
