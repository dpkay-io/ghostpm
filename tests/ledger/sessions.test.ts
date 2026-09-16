import { tempLedger, TempLedger } from './helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask } from '../../src/ledger/tasks';
import {
    startSession, touchSession, getSession, setSessionTask, endSession, listLiveSessions,
    mcpSessionId, MCP_CLIENT, SessionInput,
} from '../../src/ledger/sessions';

const SESSION_ID = 'session-1';
const STALE_MINUTES = 10;
const MINUTE_MS = 60 * 1000;
const T0 = '2026-09-16T10:00:00.000Z';
const T1 = '2026-09-16T10:01:00.000Z';
const T2 = '2026-09-16T10:05:00.000Z';
const T3 = '2026-09-16T11:00:00.000Z';

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
