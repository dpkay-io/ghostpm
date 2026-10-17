import { Ledger, MS_PER_DAY, SqlParam, Where, iso, write } from '../ledger/db';
import {
    ATTEMPT_NONCE_PATH, OP_CREATE, OP_SYNC_STATE, OutboxRow, OutboxStatus, STATUS_CLAIMED, STATUS_DONE, STATUS_FAILED, STATUS_PENDING,
} from '../ledger/projection';
import { SETTING_SYNC_PAUSED } from '../ledger/settings';
import { SYNC_LEASE } from './lease';

/** Spec §8.8: exponential backoff per row, capped at 30 minutes. */
export const PUSH_BACKOFF_BASE_MS = 30 * 1000;
export const PUSH_BACKOFF_CAP_MS = 30 * 60 * 1000;
/** How long a row waits for its task's create to land before it is looked at again. */
export const DEFER_MS = 2 * 1000;
/** Ruling F15: a done row is history nothing reads; it is pruned this long after it was taken. */
export const DONE_ROW_RETENTION_DAYS = 30;
const PAUSED_PATH = `$.${SETTING_SYNC_PAUSED}`;

/**
 * The retry nonces of this workspace's creates that are not done: the item such an attempt made may already be on the
 * vendor, and the retry adopts it. Call inside write().
 */
export function unfinishedCreateNonces(db: Ledger, workspaceId: number): Set<string> {
    const rows = db.prepare(`
        SELECT json_extract(o.payload, ?) AS nonce FROM outbox o JOIN tasks t ON t.id = o.task_id
        WHERE t.workspace_id = ? AND o.op = ? AND o.status <> ? AND nonce IS NOT NULL`)
        .all(ATTEMPT_NONCE_PATH, workspaceId, OP_CREATE, STATUS_DONE) as { nonce: string }[];
    return new Set(rows.map(row => row.nonce));
}

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

/** A post-claim write only lands while the caller still holds the claim: a holder whose lease ran out must not touch a row another holder now owns. */
const HELD = 'status = ? AND claimed_by = ?';

/**
 * A sync_state going back to pending gives way to a newer one queued while it was out:
 * one pending desired state per task (migration 2), and the newer one is the latest.
 * False when the claim is no longer `holder`'s.
 */
function returnToPending(db: Ledger, row: OutboxRow, holder: string, set: string, params: SqlParam[]): boolean {
    return write(db, () => {
        const newer = row.op === OP_SYNC_STATE && db.prepare(
            'SELECT 1 FROM outbox WHERE task_id = ? AND op = ? AND status = ? AND id <> ?',
        ).get(row.task_id, OP_SYNC_STATE, STATUS_PENDING, row.id) !== undefined;
        if (newer) {
            return db.prepare(`DELETE FROM outbox WHERE id = ? AND ${HELD}`).run(row.id, STATUS_CLAIMED, holder).changes === 1;
        }
        return db.prepare(`UPDATE outbox SET status = ?, claimed_by = NULL, claimed_at = NULL${set} WHERE id = ? AND ${HELD}`)
            .run(STATUS_PENDING, ...params, row.id, STATUS_CLAIMED, holder).changes === 1;
    });
}
/**
 * A claim whose holder no longer holds the lease will never finish: give it back (spec §6).
 * Stale sync_state claims give way first, so the one-pending index holds: to a pending row of
 * the same task, and among themselves to the newest. The holder that just took the lease also
 * prunes done rows past their retention, in the same write (ruling F15).
 */
export function releaseStaleClaims(db: Ledger, now: number): number {
    return write(db, () => {
        db.prepare('DELETE FROM outbox WHERE status = ? AND COALESCE(claimed_at, next_attempt_at) < ?')
            .run(STATUS_DONE, iso(now - DONE_ROW_RETENTION_DAYS * MS_PER_DAY));
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

/** Whether `holder` still owns the claim on row `id`. */
export function holdsClaim(db: Ledger, id: number, holder: string): boolean {
    return db.prepare(`SELECT 1 FROM outbox WHERE id = ? AND ${HELD}`).get(id, STATUS_CLAIMED, holder) !== undefined;
}

/** Stores what a retry of this row must know (an idempotency marker); false when the claim is no longer `holder`'s. */
export function setRowPayload(db: Ledger, id: number, holder: string, payload: unknown): boolean {
    return db.prepare(`UPDATE outbox SET payload = ? WHERE id = ? AND ${HELD}`)
        .run(JSON.stringify(payload), id, STATUS_CLAIMED, holder).changes === 1;
}

export function completeRow(db: Ledger, id: number, holder: string): boolean {
    return db.prepare(`UPDATE outbox SET status = ?, error = NULL WHERE id = ? AND ${HELD}`)
        .run(STATUS_DONE, id, STATUS_CLAIMED, holder).changes === 1;
}

export function failRow(db: Ledger, id: number, holder: string, error: string): boolean {
    return db.prepare(`UPDATE outbox SET status = ?, error = ? WHERE id = ? AND ${HELD}`)
        .run(STATUS_FAILED, error, id, STATUS_CLAIMED, holder).changes === 1;
}

/** Waiting on something else (its task's create), not failing: no attempt is counted. */
export function deferRow(db: Ledger, row: OutboxRow, holder: string, until: number): boolean {
    return returnToPending(db, row, holder, ', next_attempt_at = ?', [iso(until)]);
}

/** Back exactly as it was: its workspace was just paused. */
export function releaseRow(db: Ledger, row: OutboxRow, holder: string): boolean {
    return returnToPending(db, row, holder, '', []);
}

/**
 * Ruling F3: a holder pushes one row at a time, so a row it still has claimed when a run starts is one an earlier
 * run gave up on when its bookkeeping write failed (another writer held the lock past the busy timeout). It goes back
 * as a dead holder's claim would, and its retry marker keeps a second push from duplicating the first. Reads first:
 * a run with nothing left over writes nothing.
 */
export function releaseOwnClaims(db: Ledger, holder: string): number {
    const left = db.prepare(`SELECT * FROM outbox WHERE ${HELD}`).all(STATUS_CLAIMED, holder) as OutboxRow[];
    if (left.length === 0) return 0;
    return write(db, () => left.filter(row => releaseRow(db, row, holder)).length);
}

/**
 * Transient failure: back off (spec §8.8); `failed` once `maxAttempts` is reached. The count comes
 * from the ledger, not the caller's copy of the row. The resulting status, or null when the claim is no longer `holder`'s.
 */
export function retryRow(db: Ledger, row: OutboxRow, holder: string, error: string, maxAttempts: number, now: number): OutboxStatus | null {
    return write(db, () => {
        const held = db.prepare(`SELECT attempts FROM outbox WHERE id = ? AND ${HELD}`)
            .get(row.id, STATUS_CLAIMED, holder) as { attempts: number } | undefined;
        if (held === undefined) return null;
        const attempts = held.attempts + 1;
        if (attempts >= maxAttempts) {
            const failed = db.prepare(`UPDATE outbox SET status = ?, attempts = attempts + 1, error = ? WHERE id = ? AND ${HELD}`)
                .run(STATUS_FAILED, error, row.id, STATUS_CLAIMED, holder).changes === 1;
            return failed ? STATUS_FAILED : null;
        }
        const pending = returnToPending(db, row, holder, ', attempts = attempts + 1, error = ?, next_attempt_at = ?',
            [error, iso(now + backoffMs(attempts))]);
        return pending ? STATUS_PENDING : null;
    });
}

/** A failed create that no longer matters: its task is linked since, or a newer create was queued. */
const STALE_FAILED_CREATE = `o.op = ? AND o.status = ? AND (
    EXISTS (SELECT 1 FROM vendor_links l WHERE l.task_id = o.task_id)
    OR EXISTS (SELECT 1 FROM outbox n WHERE n.task_id = o.task_id AND n.op = o.op AND n.id > o.id))`;
/** The statuses outbox health counts: every one but done. */
const HEALTH_STATUSES: readonly OutboxStatus[] = [STATUS_PENDING, STATUS_CLAIMED, STATUS_FAILED];
/** The rows of tasks in the workspaces whose ids are the JSON array bound to it. */
const IN_WORKSPACES = 'task_id IN (SELECT id FROM tasks WHERE workspace_id IN (SELECT value FROM json_each(?)))';

/**
 * A person asked to retry (`ghostpm sync`): the failed rows of `workspaceIds` only, the workspaces that sync
 * (ruling I1). Superseded sync_state rows go first, so each task keeps at most one pending desired state.
 */
export function rearmFailed(db: Ledger, now: number, workspaceIds: readonly number[]): number {
    const workspaces = JSON.stringify(workspaceIds);
    return write(db, () => {
        // sync_state carries no payload: any pending one already says everything a failed one would.
        db.prepare(`
            DELETE FROM outbox WHERE op = ? AND status = ? AND ${IN_WORKSPACES}
              AND (task_id IN (SELECT task_id FROM outbox WHERE op = ? AND status = ?)
                OR id NOT IN (SELECT MAX(id) FROM outbox WHERE op = ? AND status = ? GROUP BY task_id))`)
            .run(OP_SYNC_STATE, STATUS_FAILED, workspaces, OP_SYNC_STATE, STATUS_PENDING, OP_SYNC_STATE, STATUS_FAILED);
        db.prepare(`DELETE FROM outbox WHERE ${IN_WORKSPACES} AND id IN (SELECT o.id FROM outbox o WHERE ${STALE_FAILED_CREATE})`)
            .run(workspaces, OP_CREATE, STATUS_FAILED);
        return db.prepare(`UPDATE outbox SET status = ?, attempts = 0, error = NULL, next_attempt_at = ? WHERE status = ? AND ${IN_WORKSPACES}`)
            .run(STATUS_PENDING, iso(now), STATUS_FAILED, workspaces).changes;
    });
}

/**
 * Plan 4 contract: unfinished (pending or in flight) and failed rows, for one workspace or all. A stale failed create
 * is not a failure. Done rows, nearly all of the outbox, are never read: the status index skips them (ruling F15).
 */
export function outboxHealth(db: Ledger, workspaceId?: number): { pending: number; failed: number } {
    const where = new Where().in('o.status', HEALTH_STATUSES).add(`NOT (${STALE_FAILED_CREATE})`, OP_CREATE, STATUS_FAILED);
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