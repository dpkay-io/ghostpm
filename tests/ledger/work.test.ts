import { tempLedger, TempLedger, eventKinds } from './helpers';
import { write } from '../../src/ledger/db';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import * as path from 'path';
import { createTask, getTask, updateTask } from '../../src/ledger/tasks';
import { startSession, getSession } from '../../src/ledger/sessions';
import { trackWork, TrackWorkInput, REOPEN_PHASE, advancePhase, recordEvidence } from '../../src/ledger/work';
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

describe('advancePhase', () => {
    let ledger: TempLedger;
    let workspaceId: number;
    const HOUR_MS = 60 * 60 * 1000;
    const AUTOMATION = { source: SOURCE, human: false };

    const advance = (taskId: number, target: Phase, evidenceAt: string): boolean =>
        write(ledger.db, () => advancePhase(ledger.db, getTask(ledger.db, taskId)!, target, AUTOMATION, new Date().toISOString(), evidenceAt));

    beforeEach(() => {
        ledger = tempLedger();
        workspaceId = ensureWorkspace(ledger.db, ledger.dir).id;
    });

    afterEach(() => ledger.cleanup());

    it('blocks evidence older than the last human phase change, and lets newer evidence through', () => {
        const task = createTask(ledger.db, { title: 'Reviewed', phase: 'in_progress', workspaceId, origin: 'local', source: SOURCE });
        const human = updateTask(ledger.db, task.id, { phase: 'in_review' }, { source: SOURCE, human: true });
        const humanAt = Date.parse(human.human_phase_at!);

        expect(advance(task.id, 'done', new Date(humanAt - HOUR_MS).toISOString())).toBe(false);
        expect(getTask(ledger.db, task.id)!.phase).toBe('in_review');

        expect(advance(task.id, 'done', new Date(humanAt + HOUR_MS).toISOString())).toBe(true);
        expect(getTask(ledger.db, task.id)!.phase).toBe('done');
    });

    it('compares times, not their spelling', () => {
        // GitHub writes `…:00Z`, the ledger `…:00.000Z`: the same instant sorts differently as text.
        const task = createTask(ledger.db, { title: 'Same instant', phase: 'in_progress', workspaceId, origin: 'local', source: SOURCE });
        ledger.db.prepare('UPDATE tasks SET human_phase_at = ? WHERE id = ?').run('2026-09-20T10:00:00.000Z', task.id);
        expect(advance(task.id, 'done', '2026-09-20T10:00:00Z')).toBe(false);
    });

    it('never moves backwards, and never out of done or dropped', () => {
        const review = createTask(ledger.db, { title: 'Review', phase: 'in_review', workspaceId, origin: 'local', source: SOURCE });
        const dropped = createTask(ledger.db, { title: 'Dropped', phase: 'dropped', workspaceId, origin: 'local', source: SOURCE });
        const now = new Date().toISOString();
        expect(advance(review.id, 'in_progress', now)).toBe(false);
        expect(advance(dropped.id, 'done', now)).toBe(false);
        expect(eventKinds(ledger.db, review.id)).toEqual(['created']);
    });
});

describe('recordEvidence: which files count as phase evidence', () => {
    let ledger: TempLedger;
    let workspaceId: number;
    let root: string;
    const OUTSIDE = path.resolve(path.join('..', 'elsewhere', 'plans', 'plan-mode.md'));

    const record = (phase: Phase, files: string[]): Phase => {
        const task = createTask(ledger.db, { title: 'Evidence', phase, workspaceId, origin: 'local', source: SOURCE });
        return recordEvidence(ledger.db, {
            taskId: task.id, sessionId: SESSION_ID, source: SOURCE, workspaceId, cwd: root,
            files, committed: false, prUrls: [],
        }).phase;
    };

    beforeEach(() => {
        ledger = tempLedger();
        root = ledger.dir;
        workspaceId = ensureWorkspace(ledger.db, root).id;
    });

    afterEach(() => ledger.cleanup());

    it.each<Phase>(['brainstorming', 'planned'])('keeps %s when the only edit is outside the workspace', phase => {
        expect(record(phase, [OUTSIDE])).toBe(phase);
    });

    it('still records the outside file as progress', () => {
        const task = createTask(ledger.db, { title: 'Progress', phase: 'planned', workspaceId, origin: 'local', source: SOURCE });
        recordEvidence(ledger.db, { taskId: task.id, sessionId: SESSION_ID, source: SOURCE, workspaceId, cwd: root, files: [OUTSIDE], committed: false, prUrls: [] });
        expect(eventKinds(ledger.db, task.id)).toEqual(['created', 'progress']);
    });

    it('moves to in_progress when an outside edit comes with an in-workspace non-plan edit', () => {
        expect(record('planned', [OUTSIDE, path.join(root, 'src', 'login.ts')])).toBe('in_progress');
    });

    it('treats an in-root name starting with two dots as inside the workspace', () => {
        expect(record('planned', [path.join('..notes', 'plan.md')])).toBe('in_progress');
        expect(record('brainstorming', ['..foo.md'])).toBe('in_progress');
    });
});
