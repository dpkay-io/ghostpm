import { Ledger, SqlParam, Where, write } from '../ledger/db';
import {
    OP_SYNC_STATE, OutboxRow, OutboxStatus, STATUS_CLAIMED, STATUS_DONE, STATUS_FAILED, STATUS_PENDING,
} from '../ledger/projection';
import { SETTING_SYNC_PAUSED } from '../ledger/settings';
import { SYNC_LEASE } from './lease';

/** Spec §8.8: exponential backoff per row, capped at 30 minutes. */
export const PUSH_BACKOFF_BASE_MS = 30 * 1000;
export const PUSH_BACKOFF_CAP_MS = 30 * 60 * 1000;
/** How long a row waits for its task's create to land before it is looked at again. */
export const DEFER_MS = 2 * 1000;
const PAUSED_PATH = `$.${SETTING_SYNC_PAUSED}`;

const iso = (ms: number): string => new Date(ms).toISOString();

export function backoffMs(attempt: number): number {
    return Math.min(PUSH_BACKOFF_BASE_MS * Math.pow(2, attempt - 1), PUSH_BACKOFF_CAP_MS);
}

/** Rows join their task and workspace so a paused workspace's rows are never picked. */
const ACTIVE_WORKSPACE_ROWS = `
    FROM outbox o JOIN tasks t ON t.id = o.task_id JOIN workspaces w ON w.id = t.workspace_id
    WHERE json_extract(w.settings, ?) IS NULL`;

/** Atomic: one statement picks and claims, so two processes can never take the same row (spec §6). */
export function claimNext(db: Ledger, holder: string, now: number): OutboxRow | undefined {
    const at = iso(now);
    return db.prepare(`
        UPDATE outbox SET status = ?, claimed_by = ?, claimed_at = ?
        WHERE id = (SELECT o.id ${ACTIVE_WORKSPACE_ROWS} AND o.status = ? AND o.next_attempt_at <= ? ORDER BY o.id LIMIT 1)
        RETURNING *`)
        .get(STATUS_CLAIMED, holder, at, PAUSED_PATH, STATUS_PENDING, at) as OutboxRow | undefined;
}

/**
 * A sync_state going back to pending gives way to a newer one queued while it was out:
 * one pending desired state per task (migration 2), and the newer one is the latest.
 */
function returnToPending(db: Ledger, row: OutboxRow, set: string, params: SqlParam[]): void {
    write(db, () => {
        const newer = row.op === OP_SYNC_STATE && db.prepare(
            'SELECT 1 FROM outbox WHERE task_id = ? AND op = ? AND status = ? AND id <> ?',
        ).get(row.task_id, OP_SYNC_STATE, STATUS_PENDING, row.id) !== undefined;
        if (newer) {
            db.prepare('DELETE FROM outbox WHERE id = ?').run(row.id);
            return;
        }
        db.prepare(`UPDATE outbox SET status = ?, claimed_by = NULL, claimed_at = NULL${set} WHERE id = ?`)
            .run(STATUS_PENDING, ...params, row.id);
    });
}

/**
 * A claim whose holder no longer holds the lease will never finish: give it back (spec §6).
 * Stale sync_state claims give way first, so the one-pending index holds: to a pending row of
 * the same task, and among themselves to the newest.
 */
export function releaseStaleClaims(db: Ledger, now: number): number {
    return write(db, () => {
        const stale = `status = ? AND claimed_by IS NOT (SELECT holder FROM leases WHERE name = ? AND expires_at >= ?)`;
        const params = [STATUS_CLAIMED, SYNC_LEASE, iso(now)];
        db.prepare(`
            DELETE FROM outbox WHERE ${stale} AND op = ?
              AND (task_id IN (SELECT task_id FROM outbox WHERE op = ? AND status = ?)
                OR id NOT IN (SELECT MAX(id) FROM outbox WHERE ${stale} AND op = ? GROUP BY task_id))`)
            .run(...params, OP_SYNC_STATE, OP_SYNC_STATE, STATUS_PENDING, ...params, OP_SYNC_STATE);
        return db.prepare(`UPDATE outbox SET status = ?, claimed_by = NULL, claimed_at = NULL WHERE ${stale}`)
            .run(STATUS_PENDING, ...params).changes;
    });
}

export function completeRow(db: Ledger, id: number): void {
    db.prepare('UPDATE outbox SET status = ?, error = NULL WHERE id = ?').run(STATUS_DONE, id);
}

export function failRow(db: Ledger, id: number, error: string): void {
    db.prepare('UPDATE outbox SET status = ?, error = ? WHERE id = ?').run(STATUS_FAILED, error, id);
}

/** Waiting on something else (its task's create), not failing: no attempt is counted. */
export function deferRow(db: Ledger, row: OutboxRow, until: number): void {
    returnToPending(db, row, ', next_attempt_at = ?', [iso(until)]);
}

/** Back exactly as it was: its workspace was just paused. */
export function releaseRow(db: Ledger, row: OutboxRow): void {
    returnToPending(db, row, '', []);
}

/** Transient failure: back off (spec §8.8); `failed` once `maxAttempts` is reached. */
export function retryRow(db: Ledger, row: OutboxRow, error: string, maxAttempts: number, now: number): OutboxStatus {
    const attempts = row.attempts + 1;
    if (attempts >= maxAttempts) {
        db.prepare('UPDATE outbox SET status = ?, attempts = ?, error = ? WHERE id = ?').run(STATUS_FAILED, attempts, error, row.id);
        return STATUS_FAILED;
    }
    returnToPending(db, row, ', attempts = ?, error = ?, next_attempt_at = ?', [attempts, error, iso(now + backoffMs(attempts))]);
    return STATUS_PENDING;
}

/**
 * A person asked to retry (`ghostpm sync`). Superseded sync_state rows go first, so each
 * task keeps at most one pending desired state.
 */
export function rearmFailed(db: Ledger, now: number): number {
    return write(db, () => {
        db.prepare(`
            DELETE FROM outbox WHERE op = ? AND status = ?
              AND id NOT IN (SELECT MAX(id) FROM outbox WHERE op = ? AND status IN (?, ?) GROUP BY task_id)`)
            .run(OP_SYNC_STATE, STATUS_FAILED, OP_SYNC_STATE, STATUS_FAILED, STATUS_PENDING);
        return db.prepare('UPDATE outbox SET status = ?, attempts = 0, error = NULL, next_attempt_at = ? WHERE status = ?')
            .run(STATUS_PENDING, iso(now), STATUS_FAILED).changes;
    });
}

/** Plan 4 contract: unfinished (pending or in flight) and failed rows, for one workspace or all. */
export function outboxHealth(db: Ledger, workspaceId?: number): { pending: number; failed: number } {
    const where = new Where();
    if (workspaceId !== undefined) where.add('t.workspace_id = ?', workspaceId);
    return db.prepare(`
        SELECT COALESCE(SUM(o.status IN (?, ?)), 0) AS pending, COALESCE(SUM(o.status = ?), 0) AS failed
        FROM outbox o JOIN tasks t ON t.id = o.task_id${where}`)
        .get(STATUS_PENDING, STATUS_CLAIMED, STATUS_FAILED, ...where.params) as { pending: number; failed: number };
}

/** SessionStart's question: is there a due row, or a claim nobody is finishing, outside paused workspaces? */
export function hasDueWork(db: Ledger, now: number): boolean {
    const found = db.prepare(`
        SELECT EXISTS (SELECT 1 ${ACTIVE_WORKSPACE_ROWS} AND o.status = ? AND o.next_attempt_at <= ?)
            OR EXISTS (SELECT 1 ${ACTIVE_WORKSPACE_ROWS} AND o.status = ?) AS due`)
        .get(PAUSED_PATH, STATUS_PENDING, iso(now), PAUSED_PATH, STATUS_CLAIMED) as { due: number };
    return found.due === 1;
}