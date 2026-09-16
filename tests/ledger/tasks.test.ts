import * as fs from 'fs';
import * as path from 'path';
import { tempLedger, TempLedger } from './helpers';
import { write } from '../../src/ledger/db';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import {
    createTask, updateTask, resolveTaskRef, listTasks, insertVendorLink, getVendorLink,
    NewTask, ChangeContext,
} from '../../src/ledger/tasks';
import { EventRow } from '../../src/ledger/types';

const SOURCE = 'test';
const HUMAN: ChangeContext = { source: SOURCE, human: true };
const AUTOMATION: ChangeContext = { source: SOURCE, human: false };
const MISSING_TASK_ID = 404;

describe('tasks', () => {
    let ledger: TempLedger;
    let workspaceId: number;

    const newTask = (overrides: Partial<NewTask> = {}): NewTask => ({
        title: 'Login fix', phase: 'planned', workspaceId, origin: 'local', source: SOURCE, ...overrides,
    });
    const eventsFor = (taskId: number): EventRow[] =>
        ledger.db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY seq').all(taskId) as EventRow[];

    beforeEach(() => {
        ledger = tempLedger();
        workspaceId = ensureWorkspace(ledger.db, ledger.dir).id;
    });

    afterEach(() => ledger.cleanup());

    it('creates a task together with its created event', () => {
        const task = createTask(ledger.db, newTask({ body: 'details', assignee: 'dpk', milestone: 'Sprint 1' }));
        expect(task).toMatchObject({
            title: 'Login fix', phase: 'planned', workspace_id: workspaceId, origin: 'local',
            body: 'details', assignee: 'dpk', milestone: 'Sprint 1', rev: 0, human_phase_at: null,
        });
        const events = eventsFor(task.id);
        expect(events.map(e => e.kind)).toEqual(['created']);
        expect(JSON.parse(events[0].payload!)).toEqual({ title: 'Login fix', phase: 'planned' });
        expect(events[0].at).toBe(task.created_at);
    });

    it('leaves neither task nor event when the surrounding write fails', () => {
        expect(() => write(ledger.db, () => {
            createTask(ledger.db, newTask());
            throw new Error('boom');
        })).toThrow('boom');
        expect(ledger.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });
        expect(ledger.db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
    });

    describe('updateTask', () => {
        it('renames, changes phase and comments with one event each and one revision bump', () => {
            const task = createTask(ledger.db, newTask());
            const updated = updateTask(ledger.db, task.id, { title: 'Login token fix', phase: 'in_review', comment: 'PR opened' }, AUTOMATION);
            expect(updated).toMatchObject({ title: 'Login token fix', phase: 'in_review', rev: 1, human_phase_at: null });
            const events = eventsFor(task.id);
            expect(events.map(e => e.kind)).toEqual(['created', 'renamed', 'phase', 'comment']);
            expect(JSON.parse(events[1].payload!)).toEqual({ from: 'Login fix', to: 'Login token fix' });
            expect(JSON.parse(events[2].payload!)).toEqual({ from: 'planned', to: 'in_review' });
            expect(JSON.parse(events[3].payload!)).toEqual({ text: 'PR opened' });
        });

        it('stamps human_phase_at on human phase changes', () => {
            const task = createTask(ledger.db, newTask());
            const updated = updateTask(ledger.db, task.id, { phase: 'done' }, HUMAN);
            expect(updated.human_phase_at).toBe(updated.updated_at);
        });

        it('keeps the previous human_phase_at on automated phase changes', () => {
            const task = createTask(ledger.db, newTask());
            const human = updateTask(ledger.db, task.id, { phase: 'in_progress' }, HUMAN);
            const automated = updateTask(ledger.db, task.id, { phase: 'in_review' }, AUTOMATION);
            expect(automated.human_phase_at).toBe(human.human_phase_at);
        });

        it('writes nothing when values are unchanged', () => {
            const task = createTask(ledger.db, newTask());
            const same = updateTask(ledger.db, task.id, { title: task.title, phase: task.phase }, HUMAN);
            expect(same.rev).toBe(0);
            expect(eventsFor(task.id)).toHaveLength(1);
        });

        it('throws for an unknown task', () => {
            expect(() => updateTask(ledger.db, MISSING_TASK_ID, { phase: 'done' }, HUMAN))
                .toThrow(`Task T${MISSING_TASK_ID} not found`);
        });
    });

    describe('resolveTaskRef', () => {
        it('resolves T-prefixed references as local ids, case-insensitively', () => {
            const task = createTask(ledger.db, newTask());
            expect(resolveTaskRef(ledger.db, `T${task.id}`, workspaceId)?.id).toBe(task.id);
            expect(resolveTaskRef(ledger.db, ` t${task.id} `, null)?.id).toBe(task.id);
        });

        it('prefers the vendor link in the current workspace for #n and bare n', () => {
            const localOnly = createTask(ledger.db, newTask({ title: 'Local only' }));
            const linked = createTask(ledger.db, newTask({ title: 'Imported issue', origin: 'vendor' }));
            insertVendorLink(ledger.db, { taskId: linked.id, vendor: 'github', remoteId: String(localOnly.id) });
            expect(resolveTaskRef(ledger.db, `#${localOnly.id}`, workspaceId)?.id).toBe(linked.id);
            expect(resolveTaskRef(ledger.db, String(localOnly.id), workspaceId)?.id).toBe(linked.id);
        });

        it('falls back to the local id when no vendor link matches', () => {
            const task = createTask(ledger.db, newTask());
            expect(resolveTaskRef(ledger.db, `#${task.id}`, workspaceId)?.id).toBe(task.id);
            expect(resolveTaskRef(ledger.db, String(task.id), null)?.id).toBe(task.id);
        });

        it('ignores vendor links that belong to other workspaces', () => {
            const otherDir = path.join(ledger.dir, 'other');
            fs.mkdirSync(otherDir);
            const otherWorkspaceId = ensureWorkspace(ledger.db, otherDir).id;
            const foreign = createTask(ledger.db, newTask({ workspaceId: otherWorkspaceId, origin: 'vendor' }));
            insertVendorLink(ledger.db, { taskId: foreign.id, vendor: 'github', remoteId: '777' });
            expect(resolveTaskRef(ledger.db, '#777', workspaceId)).toBeUndefined();
            expect(resolveTaskRef(ledger.db, '#777', otherWorkspaceId)?.id).toBe(foreign.id);
        });

        it('does not fall back to a local id owned by another workspace', () => {
            const otherDir = path.join(ledger.dir, 'other-fallback');
            fs.mkdirSync(otherDir);
            const otherWorkspaceId = ensureWorkspace(ledger.db, otherDir).id;
            const foreign = createTask(ledger.db, newTask({ workspaceId: otherWorkspaceId }));
            expect(resolveTaskRef(ledger.db, `#${foreign.id}`, workspaceId)).toBeUndefined();
            expect(resolveTaskRef(ledger.db, String(foreign.id), workspaceId)).toBeUndefined();
            // T-form stays machine-global: it is the explicit "this ledger id" handle.
            expect(resolveTaskRef(ledger.db, `T${foreign.id}`, workspaceId)?.id).toBe(foreign.id);
        });

        it('returns undefined for unrecognised references', () => {
            expect(resolveTaskRef(ledger.db, 'login', workspaceId)).toBeUndefined();
        });
    });

    it('lists tasks filtered by workspace, milestone, assignee and phase, newest first', () => {
        const a = createTask(ledger.db, newTask({ title: 'A', milestone: 'S1', assignee: 'dpk' }));
        const b = createTask(ledger.db, newTask({ title: 'B', milestone: 'S2', assignee: 'dpk', phase: 'done' }));
        createTask(ledger.db, newTask({ title: 'C', milestone: 'S1', assignee: 'someone' }));
        expect(listTasks(ledger.db, { workspaceId }).map(t => t.title)).toEqual(['C', 'B', 'A']);
        expect(listTasks(ledger.db, { milestone: 'S1', assignee: 'dpk' }).map(t => t.id)).toEqual([a.id]);
        expect(listTasks(ledger.db, { phases: ['done'] }).map(t => t.id)).toEqual([b.id]);
    });

    it('stores and reads a vendor link', () => {
        const task = createTask(ledger.db, newTask({ origin: 'vendor' }));
        expect(getVendorLink(ledger.db, task.id)).toBeUndefined();
        insertVendorLink(ledger.db, {
            taskId: task.id, vendor: 'github', remoteId: '42',
            remoteUrl: 'https://github.com/acme/app/issues/42', remoteState: 'open', labels: '["bug"]',
        });
        expect(getVendorLink(ledger.db, task.id)).toMatchObject({
            vendor: 'github', remote_id: '42', remote_url: 'https://github.com/acme/app/issues/42',
            remote_state: 'open', labels: '["bug"]', remote_updated_at: null,
        });
    });
});
