import { tempLedger, TempLedger, eventKinds } from './helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask, updateTask, insertVendorLink, getVendorLink, ChangeContext } from '../../src/ledger/tasks';
import { startSession, setSessionTask, getSession } from '../../src/ledger/sessions';
import { mergeTask } from '../../src/ledger/work';
import { Phase } from '../../src/ledger/types';

const SESSION_ID = 'session-1';
const SOURCE = 'mcp:test';
const AUTOMATION: ChangeContext = { source: SOURCE, human: false };

describe('mergeTask', () => {
    let ledger: TempLedger;
    let workspaceId: number;

    const task = (title: string, phase: Phase = 'planned') =>
        createTask(ledger.db, { title, phase, workspaceId, origin: 'local', source: SOURCE });
    const merge = (fromRef: string, intoRef: string) =>
        mergeTask(ledger.db, { fromRef, intoRef, workspaceId, source: SOURCE, sessionId: SESSION_ID });

    beforeEach(() => {
        ledger = tempLedger();
        workspaceId = ensureWorkspace(ledger.db, ledger.dir).id;
        startSession(ledger.db, { id: SESSION_ID, client: 'mcp', cwd: ledger.dir, workspaceId });
    });

    afterEach(() => ledger.cleanup());

    it('moves history, vendor link and sessions to the kept task and drops the merged one', () => {
        const duplicate = task('Login bug again');
        const kept = task('Login bug');
        updateTask(ledger.db, duplicate.id, { comment: 'repro steps' }, AUTOMATION);
        insertVendorLink(ledger.db, { taskId: duplicate.id, vendor: 'github', remoteId: '51' });
        setSessionTask(ledger.db, SESSION_ID, duplicate.id);

        const result = merge(`T${duplicate.id}`, `T${kept.id}`);

        expect(result.from).toMatchObject({ id: duplicate.id, phase: 'dropped' });
        expect(result.from.human_phase_at).not.toBeNull();
        expect(result.into.rev).toBe(1);
        expect(getVendorLink(ledger.db, kept.id)?.remote_id).toBe('51');
        expect(getSession(ledger.db, SESSION_ID)?.task_id).toBe(kept.id);
        expect(eventKinds(ledger.db, kept.id)).toEqual(['created', 'created', 'comment', 'merged']);
        expect(eventKinds(ledger.db, duplicate.id)).toEqual(['phase', 'merged']);
    });

    it('leaves a colliding vendor link on the merged task for Phase 3 to close', () => {
        const duplicate = task('Dup');
        const kept = task('Kept');
        insertVendorLink(ledger.db, { taskId: duplicate.id, vendor: 'github', remoteId: '51' });
        insertVendorLink(ledger.db, { taskId: kept.id, vendor: 'github', remoteId: '50' });

        merge(`T${duplicate.id}`, `T${kept.id}`);

        expect(getVendorLink(ledger.db, kept.id)?.remote_id).toBe('50');
        expect(getVendorLink(ledger.db, duplicate.id)?.remote_id).toBe('51');
    });

    it('rejects merging a task into itself and unknown references', () => {
        const only = task('Only');
        expect(() => merge(`T${only.id}`, `T${only.id}`)).toThrow('Cannot merge a task into itself');
        expect(() => merge('T999', `T${only.id}`)).toThrow('Task T999 not found');
        expect(() => merge(`T${only.id}`, 'T998')).toThrow('Task T998 not found');
    });
});
