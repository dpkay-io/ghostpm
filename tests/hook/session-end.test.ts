import * as fs from 'fs';
import * as path from 'path';
import { tempLedger, TempLedger } from '../ledger/helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask } from '../../src/ledger/tasks';
import {
    getSession, startSession, setSessionTask, listLiveSessions, DEFAULT_STALE_SESSION_MINUTES,
} from '../../src/ledger/sessions';
import { TaskRow } from '../../src/ledger/types';
import { readPayload } from '../../src/hook/payload';
import { handleWith, HOOK_CLIENT } from '../../src/hook/handlers';

const SESSION_ID = 'claude-ending';
const MS_PER_MINUTE = 60 * 1000;

describe('SessionEnd handler', () => {
    let ledger: TempLedger;
    let repo: string;
    let workspaceId: number;
    let active: TaskRow;

    const sessionEnd = (sessionId: string = SESSION_ID): string | null =>
        handleWith(ledger.db, readPayload(JSON.stringify({
            hook_event_name: 'SessionEnd', session_id: sessionId, cwd: repo,
        }), 'SessionEnd'));

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

    it('marks the session ended, keeps its task, and injects nothing', () => {
        // ended_at is the assertion that can actually fail here; the other two would
        // hold trivially if nothing happened at all, so they ride along with it.
        const injected = sessionEnd();

        const session = getSession(ledger.db, SESSION_ID)!;
        expect(session.ended_at).not.toBeNull();
        expect(session.task_id).toBe(active.id);
        expect(injected).toBeNull();
    });

    it('leaves a session it never saw alone', () => {
        sessionEnd('some-other-session');

        expect(getSession(ledger.db, 'some-other-session')).toBeUndefined();
        expect(getSession(ledger.db, SESSION_ID)!.ended_at).toBeNull();
    });

    it('drops out of live sessions once stale, even when SessionEnd never fires', () => {
        // SessionEnd is not guaranteed on Ctrl+C, a crash or a closed terminal, so
        // last_seen_at staleness is the real mechanism and this is its guard.
        const stale = new Date(Date.now() - (DEFAULT_STALE_SESSION_MINUTES + 1) * MS_PER_MINUTE).toISOString();
        ledger.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(stale, SESSION_ID);

        expect(listLiveSessions(ledger.db).map(s => s.id)).not.toContain(SESSION_ID);
    });
});
