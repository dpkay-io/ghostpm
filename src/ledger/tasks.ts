import { Ledger, Where, write, nowIso } from './db';
import { recordEvent } from './events';
import { Origin, Phase, TaskRow, Vendor, VendorLinkRow, formatTaskId } from './types';

const LOCAL_REF = /^T(\d+)$/i;
const NUMERIC_REF = /^#?(\d+)$/;

export interface NewTask {
    title: string;
    phase: Phase;
    workspaceId: number | null;
    origin: Origin;
    source: string;
    sessionId?: string | null;
    body?: string | null;
    assignee?: string | null;
    milestone?: string | null;
}

export interface ChangeContext {
    source: string;
    sessionId?: string | null;
    /** Human-sourced phase changes stamp human_phase_at (spec §8.6). */
    human: boolean;
}

export interface TaskUpdate {
    phase?: Phase;
    title?: string;
    comment?: string;
}

export interface TaskFilter {
    workspaceId?: number;
    milestone?: string;
    assignee?: string;
    phases?: Phase[];
}

export interface NewVendorLink {
    taskId: number;
    vendor: Vendor;
    remoteId: string;
    remoteUrl?: string | null;
    remoteState?: string | null;
    labels?: string | null;
    remoteUpdatedAt?: string | null;
}

export function getTask(db: Ledger, id: number): TaskRow | undefined {
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
}

/** Plain insert plus 'created' event: call inside write(). */
export function insertTaskRow(db: Ledger, task: NewTask, at: string): TaskRow {
    const { lastInsertRowid } = db.prepare(`
        INSERT INTO tasks (title, phase, workspace_id, origin, body, assignee, milestone, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(task.title, task.phase, task.workspaceId, task.origin, task.body ?? null, task.assignee ?? null, task.milestone ?? null, at, at);
    const id = Number(lastInsertRowid);
    recordEvent(db, { taskId: id, kind: 'created', source: task.source, sessionId: task.sessionId, payload: { title: task.title, phase: task.phase } }, at);
    return getTask(db, id)!;
}

export function createTask(db: Ledger, task: NewTask): TaskRow {
    return write(db, () => insertTaskRow(db, task, nowIso()));
}

/** Plain phase update plus 'phase' event: call inside write(). */
export function applyPhaseChange(db: Ledger, task: TaskRow, phase: Phase, ctx: ChangeContext, at: string): void {
    db.prepare('UPDATE tasks SET phase = ?, human_phase_at = COALESCE(?, human_phase_at) WHERE id = ?')
        .run(phase, ctx.human ? at : null, task.id);
    recordEvent(db, { taskId: task.id, kind: 'phase', source: ctx.source, sessionId: ctx.sessionId, payload: { from: task.phase, to: phase } }, at);
}

/** Call inside write(), once per logical change. */
export function bumpRevision(db: Ledger, id: number, at: string): void {
    db.prepare('UPDATE tasks SET rev = rev + 1, updated_at = ? WHERE id = ?').run(at, id);
}

export function updateTask(db: Ledger, id: number, update: TaskUpdate, ctx: ChangeContext): TaskRow {
    return write(db, () => {
        const task = getTask(db, id);
        if (!task) throw new Error(`Task ${formatTaskId(id)} not found`);
        const at = nowIso();
        let changed = false;
        if (update.title !== undefined && update.title !== task.title) {
            db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(update.title, id);
            recordEvent(db, { taskId: id, kind: 'renamed', source: ctx.source, sessionId: ctx.sessionId, payload: { from: task.title, to: update.title } }, at);
            changed = true;
        }
        if (update.phase !== undefined && update.phase !== task.phase) {
            applyPhaseChange(db, task, update.phase, ctx, at);
            changed = true;
        }
        if (update.comment) {
            recordEvent(db, { taskId: id, kind: 'comment', source: ctx.source, sessionId: ctx.sessionId, payload: { text: update.comment } }, at);
            changed = true;
        }
        if (changed) bumpRevision(db, id, at);
        return getTask(db, id)!;
    });
}

/** T42 → local id. #42 or 42 → vendor remote_id in the workspace, else local id (spec §9.1). */
export function resolveTaskRef(db: Ledger, ref: string, workspaceId: number | null): TaskRow | undefined {
    const trimmed = ref.trim();
    const local = trimmed.match(LOCAL_REF);
    if (local) return getTask(db, Number(local[1]));
    const numeric = trimmed.match(NUMERIC_REF);
    if (!numeric) return undefined;
    if (workspaceId !== null) {
        const linked = db.prepare(`
            SELECT t.* FROM tasks t JOIN vendor_links l ON l.task_id = t.id
            WHERE t.workspace_id = ? AND l.remote_id = ?
            ORDER BY t.id LIMIT 1`).get(workspaceId, numeric[1]) as TaskRow | undefined;
        if (linked) return linked;
    }
    return getTask(db, Number(numeric[1]));
}

export function listTasks(db: Ledger, filter: TaskFilter = {}): TaskRow[] {
    const where = new Where().in('phase', filter.phases);
    if (filter.workspaceId !== undefined) where.add('workspace_id = ?', filter.workspaceId);
    if (filter.milestone !== undefined) where.add('milestone = ?', filter.milestone);
    if (filter.assignee !== undefined) where.add('assignee = ?', filter.assignee);
    return db.prepare(`SELECT * FROM tasks${where} ORDER BY updated_at DESC, id DESC`).all(...where.params) as TaskRow[];
}

export function insertVendorLink(db: Ledger, link: NewVendorLink): void {
    db.prepare(`
        INSERT INTO vendor_links (task_id, vendor, remote_id, remote_url, remote_state, labels, remote_updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(link.taskId, link.vendor, link.remoteId, link.remoteUrl ?? null, link.remoteState ?? null, link.labels ?? null, link.remoteUpdatedAt ?? null);
}

export function getVendorLink(db: Ledger, taskId: number): VendorLinkRow | undefined {
    return db.prepare('SELECT * FROM vendor_links WHERE task_id = ? ORDER BY vendor LIMIT 1').get(taskId) as VendorLinkRow | undefined;
}
