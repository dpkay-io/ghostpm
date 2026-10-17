import { Ledger, nowIso, write } from './db';
import { getWorkspace } from './workspaces';
import {
    readSetting, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO, SYNC_POLICY_OFF, SYNC_POLICY_PROMOTE, SyncPolicy,
} from './settings';
import { CLOSED_PHASES, EventKind, NO_VENDOR, Phase, TaskRow, formatTaskId, plural } from './types';

export const OUTBOX_OPS = ['create', 'sync_state', 'comment', 'close_duplicate'] as const;
export type OutboxOp = typeof OUTBOX_OPS[number];
export const OUTBOX_STATUSES = ['pending', 'claimed', 'done', 'failed'] as const;
export type OutboxStatus = typeof OUTBOX_STATUSES[number];

export const OP_CREATE: OutboxOp = 'create';
export const OP_SYNC_STATE: OutboxOp = 'sync_state';
export const OP_COMMENT: OutboxOp = 'comment';
export const OP_CLOSE_DUPLICATE: OutboxOp = 'close_duplicate';
export const STATUS_PENDING: OutboxStatus = 'pending';
export const STATUS_CLAIMED: OutboxStatus = 'claimed';
export const STATUS_DONE: OutboxStatus = 'done';
export const STATUS_FAILED: OutboxStatus = 'failed';

export interface OutboxRow {
    id: number;
    task_id: number;
    op: OutboxOp;
    payload: string | null;
    status: OutboxStatus;
    claimed_by: string | null;
    claimed_at: string | null;
    attempts: number;
    next_attempt_at: string;
    error: string | null;
}

export interface CommentPayload { text: string }
export interface CloseDuplicatePayload { of: string }
/** What a create or comment row carries once tried: its retry marker's nonce, and for a create the title that attempt sent. */
export interface AttemptPayload {
    nonce?: string;
    title?: string;
}
/** json_extract path of AttemptPayload.nonce. */
export const ATTEMPT_NONCE_PATH = '$.nonce';

/**
 * What asked for the projection (spec §8.2):
 * - change: the title or phase changed
 * - comment: an explicit comment (creates under auto, never forces a sync)
 * - evidence: a commit or PR (promotes under promote, never forces a sync)
 * - publish: the user asked (update_task publish)
 *
 * Rules, in order: nothing is queued for a task without a workspace, in a vendor=none workspace,
 * with a broken vendor link, or while sync_policy is off. An unlinked task gets one create if the
 * policy allows it (auto: any trigger; promote: publish or evidence; linked-only: never; never
 * for a done or dropped task).
 */
export type ProjectionTrigger = 'change' | 'comment' | 'evidence' | 'publish';
export type ProjectionResult = 'no_vendor' | 'broken_link' | 'not_allowed' | 'create_failed' | 'create_queued' | 'sync_queued' | 'nothing';

type Reach = 'linked' | 'broken' | 'create_pending' | 'create_in_flight' | 'create_failed' | 'unlinked';

const PROGRESS_KINDS: readonly EventKind[] = ['commit', 'progress', 'pr'];
const PHASE_KIND: EventKind = 'phase';
const COMMENT_PART_SEPARATOR = ' · ';

export function isSyncable(db: Ledger, task: TaskRow): boolean {
    if (task.workspace_id === null) return false;
    const workspace = getWorkspace(db, task.workspace_id);
    return workspace !== undefined && workspace.vendor !== NO_VENDOR;
}

function reachOf(db: Ledger, taskId: number): Reach {
    const link = db.prepare('SELECT broken_at FROM vendor_links WHERE task_id = ? ORDER BY vendor LIMIT 1')
        .get(taskId) as { broken_at: string | null } | undefined;
    if (link !== undefined) return link.broken_at === null ? 'linked' : 'broken';
    const create = db.prepare('SELECT status FROM outbox WHERE task_id = ? AND op = ? AND status IN (?, ?) ORDER BY id DESC LIMIT 1')
        .get(taskId, OP_CREATE, STATUS_PENDING, STATUS_CLAIMED) as { status: OutboxStatus } | undefined;
    if (create !== undefined) return create.status === STATUS_CLAIMED ? 'create_in_flight' : 'create_pending';
    // A failed create waits for a person to re-arm it; queuing another would duplicate the vendor item.
    const failed = db.prepare('SELECT 1 FROM outbox WHERE task_id = ? AND op = ? AND status = ? LIMIT 1')
        .get(taskId, OP_CREATE, STATUS_FAILED);
    return failed === undefined ? 'unlinked' : 'create_failed';
}

export function hasActiveCreate(db: Ledger, taskId: number): boolean {
    const reach = reachOf(db, taskId);
    return reach === 'create_pending' || reach === 'create_in_flight';
}

function mayCreate(policy: SyncPolicy, trigger: ProjectionTrigger, task: TaskRow): boolean {
    // A vendor item for work that is already finished or abandoned is noise.
    if (CLOSED_PHASES.has(task.phase)) return false;
    if (policy === SYNC_POLICY_AUTO) return true;
    if (policy === SYNC_POLICY_PROMOTE) return trigger === 'publish' || trigger === 'evidence';
    return false;
}

const syncs = (trigger: ProjectionTrigger): boolean => trigger === 'change' || trigger === 'publish';

function insertRow(db: Ledger, taskId: number, op: OutboxOp, payload: unknown, at: string): void {
    db.prepare('INSERT INTO outbox (task_id, op, payload, status, next_attempt_at) VALUES (?, ?, ?, ?, ?)')
        .run(taskId, op, payload === null ? null : JSON.stringify(payload), STATUS_PENDING, at);
}

/**
 * Desired state, not a diff (spec §6): one pending row per task with no payload; the pusher
 * reads the task when it pushes. A newer desired state also replaces one that gave up.
 * The ON CONFLICT target repeats migration 2's partial index literally, as SQLite requires.
 */
function upsertSyncState(db: Ledger, taskId: number, at: string): void {
    db.prepare('DELETE FROM outbox WHERE task_id = ? AND op = ? AND status = ?').run(taskId, OP_SYNC_STATE, STATUS_FAILED);
    db.prepare(`
        INSERT INTO outbox (task_id, op, status, next_attempt_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(task_id) WHERE op = 'sync_state' AND status = 'pending' DO NOTHING`)
        .run(taskId, OP_SYNC_STATE, STATUS_PENDING, at);
}

const policyOf = (db: Ledger, task: TaskRow): SyncPolicy => readSetting(db, task.workspace_id, SETTING_SYNC_POLICY);

/**
 * Nothing of a task closed before its create was taken ever reaches the vendor: drop what waits. A create
 * that was already tried stays (its attempt may have landed): the pusher only looks for what it made.
 */
export function dropUnpushed(db: Ledger, taskId: number): void {
    db.prepare(`
        DELETE FROM outbox WHERE task_id = ? AND status = ?
          AND (op = ? OR (op = ? AND json_extract(payload, ?) IS NULL))`)
        .run(taskId, STATUS_PENDING, OP_COMMENT, OP_CREATE, ATTEMPT_NONCE_PATH);
}

/** Queues what a vendor should now show for `task`. Plain statements: call inside write(). */
export function projectTask(db: Ledger, task: TaskRow, trigger: ProjectionTrigger, at: string): ProjectionResult {
    if (!isSyncable(db, task)) return 'no_vendor';
    const reach = reachOf(db, task.id);
    if (reach === 'broken') return 'broken_link';
    const policy = policyOf(db, task);
    if (policy === SYNC_POLICY_OFF) return 'not_allowed';
    if (reach === 'create_failed') return 'create_failed';
    if (reach === 'unlinked') {
        if (!mayCreate(policy, trigger, task)) return 'not_allowed';
        insertRow(db, task.id, OP_CREATE, null, at);
        return 'create_queued';
    }
    if (reach === 'create_pending' && CLOSED_PHASES.has(task.phase)) {
        dropUnpushed(db, task.id);
        return 'nothing';
    }
    // A create not yet taken pushes the task as it is then; one already on its way does not.
    if (reach === 'create_pending' || !syncs(trigger)) return 'nothing';
    upsertSyncState(db, task.id, at);
    return 'sync_queued';
}

/** Queued only while the task is on the vendor or on its way there. Call inside write(). */
export function enqueueComment(db: Ledger, task: TaskRow, text: string, at: string): boolean {
    if (!isSyncable(db, task) || policyOf(db, task) === SYNC_POLICY_OFF) return false;
    const reach = reachOf(db, task.id);
    if (reach !== 'linked' && reach !== 'create_pending' && reach !== 'create_in_flight') return false;
    const payload: CommentPayload = { text };
    insertRow(db, task.id, OP_COMMENT, payload, at);
    return true;
}

/** A desired state for `taskId` that has not gone out, nor will: something else now says what its item shows. */
function dropUnsentSyncState(db: Ledger, taskId: number): void {
    db.prepare('DELETE FROM outbox WHERE task_id = ? AND op = ? AND status IN (?, ?)')
        .run(taskId, OP_SYNC_STATE, STATUS_PENDING, STATUS_FAILED);
}

/** Spec §8.7: the merged-away item closes as a duplicate, which replaces its own pending state. */
export function enqueueCloseDuplicate(db: Ledger, from: TaskRow, ofRemoteId: string, at: string): void {
    if (!isSyncable(db, from) || policyOf(db, from) === SYNC_POLICY_OFF || reachOf(db, from.id) !== 'linked') return;
    dropUnsentSyncState(db, from.id);
    const payload: CloseDuplicatePayload = { of: ofRemoteId };
    insertRow(db, from.id, OP_CLOSE_DUPLICATE, payload, at);
}

/**
 * Ruling F1: a merge moved `fromId`'s vendor item to `into`, which had none. That item now shows `into`: its
 * desired state replaces the one `fromId` still had queued, and the comments not posted yet go there as `into`'s.
 * Call inside write().
 */
export function handOverVendorItem(db: Ledger, fromId: number, into: TaskRow, at: string): void {
    dropUnsentSyncState(db, fromId);
    db.prepare('UPDATE outbox SET task_id = ? WHERE task_id = ? AND op = ? AND status <> ?').run(into.id, fromId, OP_COMMENT, STATUS_DONE);
    projectTask(db, into, 'change', at);
}

/** Human wins (spec §8.6): the vendor's own edit already says everything this row would. */
export function dropPendingSyncState(db: Ledger, taskId: number): void {
    db.prepare('DELETE FROM outbox WHERE task_id = ? AND op = ? AND status = ?').run(taskId, OP_SYNC_STATE, STATUS_PENDING);
}

/**
 * Spec D8 `phase`: one comment per phase move, summarising the evidence since the previous
 * move. Counts and PR links only; file names and notes stay local (spec §7.6).
 * Call before the new phase event is recorded.
 */
export function phaseCommentText(db: Ledger, taskId: number, from: Phase, to: Phase): string {
    const rows = db.prepare(`
        SELECT kind, payload FROM events
        WHERE task_id = ? AND kind IN (?, ?, ?)
          AND seq > COALESCE((SELECT MAX(seq) FROM events WHERE task_id = ? AND kind = ?), 0)
        ORDER BY seq`)
        .all(taskId, ...PROGRESS_KINDS, taskId, PHASE_KIND) as { kind: EventKind; payload: string | null }[];
    let commits = 0;
    const files = new Set<string>();
    const prs: string[] = [];
    for (const row of rows) {
        const payload = JSON.parse(row.payload ?? '{}') as { files?: unknown; url?: unknown };
        if (row.kind === 'commit') commits++;
        else if (row.kind === 'pr' && typeof payload.url === 'string') prs.push(payload.url);
        else if (Array.isArray(payload.files)) payload.files.forEach(file => files.add(String(file)));
    }
    const parts = [`Phase: ${from} → ${to}`];
    if (commits > 0) parts.push(plural(commits, 'commit'));
    if (files.size > 0) parts.push(plural(files.size, 'file'));
    prs.forEach(url => parts.push(`PR ${url}`));
    return parts.join(COMMENT_PART_SEPARATOR);
}

/** The explicit "promote" signal (update_task publish). */
export function publishTask(db: Ledger, taskId: number): ProjectionResult {
    return write(db, () => {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
        if (!task) throw new Error(`Task ${formatTaskId(taskId)} not found`);
        return projectTask(db, task, 'publish', nowIso());
    });
}
