import { Ledger, Where, write, nowIso } from './db';
import { recordEvent } from './events';
import { enqueueComment, isSyncable, phaseCommentText, projectTask } from './projection';
import { readSetting, SETTING_PROGRESS_COMMENTS } from './settings';
import { Origin, Phase, TaskRow, VENDOR_SOURCE, Vendor, VendorLinkRow, formatTaskId } from './types';

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

/**
 * Phase update plus 'phase' event, and the vendor projection unless the change came from the
 * vendor: call inside write().
 */
export function applyPhaseChange(db: Ledger, task: TaskRow, phase: Phase, ctx: ChangeContext, at: string): void {
    const projects = ctx.source !== VENDOR_SOURCE && isSyncable(db, task);
    // Read before this phase event exists, so "since the last move" means the previous one.
    const comment = projects && readSetting(db, task.workspace_id, SETTING_PROGRESS_COMMENTS) === 'phase'
        ? phaseCommentText(db, task.id, task.phase, phase)
        : null;
    db.prepare('UPDATE tasks SET phase = ?, human_phase_at = COALESCE(?, human_phase_at) WHERE id = ?')
        .run(phase, ctx.human ? at : null, task.id);
    recordEvent(db, { taskId: task.id, kind: 'phase', source: ctx.source, sessionId: ctx.sessionId, payload: { from: task.phase, to: phase } }, at);
    if (!projects) return;
    const moved = getTask(db, task.id)!;
    projectTask(db, moved, 'change', at);
    if (comment !== null) enqueueComment(db, moved, comment, at);
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
        const renamed = update.title !== undefined && update.title !== task.title;
        const rephased = update.phase !== undefined && update.phase !== task.phase;
        const comment = update.comment ?? '';
        if (renamed) {
            db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(update.title!, id);
            recordEvent(db, { taskId: id, kind: 'renamed', source: ctx.source, sessionId: ctx.sessionId, payload: { from: task.title, to: update.title } }, at);
        }
        // Re-read: the projection a phase change queues must see the title just set.
        if (rephased) applyPhaseChange(db, getTask(db, id)!, update.phase!, ctx, at);
        if (comment.length > 0) {
            recordEvent(db, { taskId: id, kind: 'comment', source: ctx.source, sessionId: ctx.sessionId, payload: { text: comment } }, at);
        }
        if (renamed || rephased || comment.length > 0) bumpRevision(db, id, at);
        const updated = getTask(db, id)!;
        if (ctx.source !== VENDOR_SOURCE) {
            if (renamed) projectTask(db, updated, 'change', at);
            if (comment.length > 0) {
                projectTask(db, updated, 'comment', at);
                enqueueComment(db, updated, comment, at);
            }
        }
        return updated;
    });
}

/** T42 → local id, machine-global. #42 or 42 → vendor remote_id in the workspace, else local id 42 in that same workspace (spec §9.1). */
export function resolveTaskRef(db: Ledger, ref: string, workspaceId: number | null): TaskRow | undefined {
    const trimmed = ref.trim();
    const local = trimmed.match(LOCAL_REF);
    if (local) return getTask(db, Number(local[1]));
    const numeric = trimmed.match(NUMERIC_REF);
    if (!numeric) return undefined;
    // Outside any workspace there is nothing to scope to, so the bare id is the whole ledger.
    if (workspaceId === null) return getTask(db, Number(numeric[1]));
    const linked = db.prepare(`
        SELECT t.* FROM tasks t JOIN vendor_links l ON l.task_id = t.id
        WHERE t.workspace_id = ? AND l.remote_id = ?
        ORDER BY t.id LIMIT 1`).get(workspaceId, numeric[1]) as TaskRow | undefined;
    if (linked) return linked;
    // Two repos routinely both have an issue #42, so a bare number never escapes its workspace.
    return db.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?')
        .get(Number(numeric[1]), workspaceId) as TaskRow | undefined;
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
