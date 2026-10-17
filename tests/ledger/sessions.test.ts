import { tempLedger, TempLedger } from './helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask } from '../../src/ledger/tasks';
import {
    startSession, touchSession, getSession, setSessionTask, endSession, listLiveSessions,
    mcpSessionId, MCP_CLIENT, SessionInput, currentSessionOf, seeSession,
} from '../../src/ledger/sessions';

const SESSION_ID = 'session-1';
const STALE_MINUTES = 10;
const MINUTE_MS = 60 * 1000;
const T0 = '2026-09-16T10:00:00.000Z';
const T1 = '2026-09-16T10:01:00.000Z';
const T2 = '2026-09-16T10:05:00.000Z';
const T3 = '2026-09-16T11:00:00.000Z';
const CLAUDE_PID = 4242;

describe('sessions', () => {
    let ledger: TempLedger;
    let workspaceId: number;
    const input = (overrides: Partial<SessionInput> = {}): SessionInput =>
        ({ id: SESSION_ID, client: 'claude-code', cwd: ledger.dir, workspaceId, ...overrides });

    beforeEach(() => {
        ledger = tempLedger();
        workspaceId = ensureWorkspace(ledger.db, ledger.dir).id;
    });

    afterEach(() => ledger.cleanup());

    it('builds MCP session ids from the process id', () => {
        expect(mcpSessionId(1234)).toBe(`${MCP_CLIENT}:1234`);
    });

    it('returns undefined for an unknown session', () => {
        expect(getSession(ledger.db, 'missing')).toBeUndefined();
    });

    it('refreshes the heartbeat without touching the start time or task', () => {
        startSession(ledger.db, input(), T0);
        const task = createTask(ledger.db, { title: 'x', phase: 'planned', workspaceId, origin: 'local', source: 'test' });
        setSessionTask(ledger.db, SESSION_ID, task.id, T1);
        expect(touchSession(ledger.db, input(), T2)).toMatchObject({
            started_at: T0, last_seen_at: T2, task_id: task.id, ended_at: null,
        });
    });

    it('clears the previous task when a session id is started again (reused pid)', () => {
        startSession(ledger.db, input(), T0);
        setSessionTask(ledger.db, SESSION_ID, 7, T1);
        endSession(ledger.db, SESSION_ID, T2);
        expect(startSession(ledger.db, input(), T3)).toMatchObject({ task_id: null, started_at: T3, last_seen_at: T3, ended_at: null });
    });

    it('keeps the client process id when a heartbeat does not carry one', () => {
        startSession(ledger.db, input({ clientPid: CLAUDE_PID }), T0);
        expect(touchSession(ledger.db, input(), T1).client_pid).toBe(CLAUDE_PID);
    });

    describe('seeSession: a heartbeat from a process that does not own the row', () => {
        it("moves only last_seen_at, keeping the owner's cwd, workspace, task, process id and end", () => {
            startSession(ledger.db, input({ cwd: 'C:/repo/packages/app', clientPid: CLAUDE_PID }), T0);
            setSessionTask(ledger.db, SESSION_ID, 7, T0);
            endSession(ledger.db, SESSION_ID, T1);
            const other = ensureWorkspace(ledger.db, `${ledger.dir}-other`).id;
            expect(seeSession(ledger.db, input({ cwd: 'C:/repo', workspaceId: other }), T2)).toMatchObject({
                cwd: 'C:/repo/packages/app', workspace_id: workspaceId, task_id: 7, client_pid: CLAUDE_PID,
                started_at: T0, last_seen_at: T2, ended_at: T1,
            });
        });

        it('creates the row when its owner has not yet', () => {
            expect(seeSession(ledger.db, input(), T1)).toMatchObject({ id: SESSION_ID, cwd: ledger.dir, started_at: T1, last_seen_at: T1 });
        });
    });

    describe('currentSessionOf', () => {
        it('follows a session to the newest one of the same client process (/clear starts another)', () => {
            startSession(ledger.db, input({ clientPid: CLAUDE_PID }), T0);
            endSession(ledger.db, SESSION_ID, T1);
            startSession(ledger.db, input({ id: 'after-clear', clientPid: CLAUDE_PID }), T1);
            startSession(ledger.db, input({ id: 'other-process', clientPid: CLAUDE_PID + 1 }), T2);
            expect(currentSessionOf(ledger.db, SESSION_ID)).toBe('after-clear');
        });

        it('picks the open conversation when /clear lands in the same millisecond as the one it ended', () => {
            // Every write at one instant: last_seen_at alone ties, and SQLite may then answer either row.
            startSession(ledger.db, input({ clientPid: CLAUDE_PID }), T0);
            endSession(ledger.db, SESSION_ID, T0);
            startSession(ledger.db, input({ id: 'after-clear', clientPid: CLAUDE_PID }), T0);
            expect(currentSessionOf(ledger.db, SESSION_ID)).toBe('after-clear');
        });

        it('is the session itself when no client process id is known, or the session is unknown', () => {
            startSession(ledger.db, input(), T0);
            startSession(ledger.db, input({ id: 'unrelated' }), T1);
            expect(currentSessionOf(ledger.db, SESSION_ID)).toBe(SESSION_ID);
            expect(currentSessionOf(ledger.db, 'never-seen')).toBe('never-seen');
        });
    });

    it('lists only sessions that are not ended and were seen within the stale window', () => {
        const now = Date.parse(T3);
        const minutesAgo = (m: number) => new Date(now - m * MINUTE_MS).toISOString();
        startSession(ledger.db, input({ id: 'fresh' }), minutesAgo(1));
        startSession(ledger.db, input({ id: 'stale' }), minutesAgo(STALE_MINUTES + 1));
        startSession(ledger.db, input({ id: 'ended' }), minutesAgo(1));
        endSession(ledger.db, 'ended', minutesAgo(0));
        expect(listLiveSessions(ledger.db, STALE_MINUTES, now).map(s => s.id)).toEqual(['fresh']);
    });
});
