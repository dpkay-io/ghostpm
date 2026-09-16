import { tempLedger, TempLedger, eventKinds } from './helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask } from '../../src/ledger/tasks';
import { startSession, getSession } from '../../src/ledger/sessions';
import { trackWork, TrackWorkInput, REOPEN_PHASE } from '../../src/ledger/work';
import { Intent, Phase } from '../../src/ledger/types';

const SESSION_ID = 'session-1';
const SOURCE = 'mcp:test';
const INTENT_CASES: [Intent, Phase][] = [
    ['brainstorm', 'brainstorming'],
    ['plan', 'planned'],
    ['implement', 'planned'],
    ['fix', 'planned'],
];
const CLOSED_CASES: Phase[] = ['done', 'dropped'];

describe('trackWork', () => {
    let ledger: TempLedger;
    let workspaceId: number;

    const kinds = (taskId: number): string[] => eventKinds(ledger.db, taskId);
    const eventCount = () => ledger.db.prepare('SELECT COUNT(*) AS n FROM events').get();
    const track = (overrides: Partial<TrackWorkInput> = {}) =>
        trackWork(ledger.db, { sessionId: SESSION_ID, source: SOURCE, workspaceId, title: 'Login fix', intent: 'implement', ...overrides });

    beforeEach(() => {
        ledger = tempLedger();
        workspaceId = ensureWorkspace(ledger.db, ledger.dir).id;
        startSession(ledger.db, { id: SESSION_ID, client: 'mcp', cwd: ledger.dir, workspaceId });
    });

    afterEach(() => ledger.cleanup());

    it.each(INTENT_CASES)('creates a local task for intent %s in phase %s and links the session', (intent, phase) => {
        const result = track({ intent });
        expect(result).toMatchObject({ created: true, reopened: false });
        expect(result.task).toMatchObject({ title: 'Login fix', phase, origin: 'local', workspace_id: workspaceId });
        expect(getSession(ledger.db, SESSION_ID)?.task_id).toBe(result.task.id);
        expect(kinds(result.task.id)).toEqual(['created']);
    });

    it('attaches to an existing task, moves its phase forward and records progress', () => {
        const idea = track({ intent: 'brainstorm', title: 'Ledger idea' }).task;
        const result = track({ intent: 'plan', title: 'Write plan', taskRef: `T${idea.id}` });
        expect(result).toMatchObject({ created: false, reopened: false });
        expect(result.task).toMatchObject({ id: idea.id, title: 'Ledger idea', phase: 'planned', rev: 1 });
        expect(kinds(idea.id)).toEqual(['created', 'phase', 'progress']);
    });

    it('never moves a task backwards', () => {
        const task = createTask(ledger.db, { title: 'Review me', phase: 'in_review', workspaceId, origin: 'local', source: SOURCE });
        const result = track({ intent: 'brainstorm', taskRef: `T${task.id}` });
        expect(result.task.phase).toBe('in_review');
        expect(kinds(task.id)).toEqual(['created', 'progress']);
        expect(getSession(ledger.db, SESSION_ID)?.task_id).toBe(task.id);
    });

    it.each(CLOSED_CASES)('reopens a %s task as automation, not as a human change', closed => {
        const task = createTask(ledger.db, { title: 'Closed', phase: closed, workspaceId, origin: 'local', source: SOURCE });
        const result = track({ taskRef: `T${task.id}` });
        expect(result).toMatchObject({ created: false, reopened: true });
        expect(result.task.phase).toBe(REOPEN_PHASE);
        expect(result.task.human_phase_at).toBeNull();
    });

    it('treats a blank task reference as a new task', () => {
        expect(track({ taskRef: '   ' }).created).toBe(true);
    });

    it('throws for an unknown task reference without writing anything', () => {
        const before = eventCount();
        expect(() => track({ taskRef: 'T999' })).toThrow('Task T999 not found');
        expect(eventCount()).toEqual(before);
    });
});
