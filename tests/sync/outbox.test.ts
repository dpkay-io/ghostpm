import { tempLedger, TempLedger, clonedRepo } from '../ledger/helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask, insertVendorLink } from '../../src/ledger/tasks';
import { setSyncPause } from '../../src/ledger/settings';
import { OutboxRow } from '../../src/ledger/projection';
import { TaskRow } from '../../src/ledger/types';
import { acquireLease } from '../../src/sync/lease';
import {
    backoffMs, claimNext, completeRow, deferRow, failRow, hasDueWork, outboxHealth, rearmFailed, releaseRow,
    releaseStaleClaims, retryRow, DEFER_MS, PUSH_BACKOFF_BASE_MS, PUSH_BACKOFF_CAP_MS,
} from '../../src/sync/outbox';

const T0 = Date.parse('2026-09-29T12:00:00.000Z');
const MINUTE_MS = 60 * 1000;
const HOLDER = 'pid:1';
const iso = (ms: number): string => new Date(ms).toISOString();

describe('outbox queue mechanics', () => {
    let ledger: TempLedger;
    let workspaceId: number;
    let task: TaskRow;

    const insert = (op: string, status = 'pending', dueAt = T0, taskId = task.id): number => Number(
        ledger.db.prepare('INSERT INTO outbox (task_id, op, status, next_attempt_at, claimed_by) VALUES (?, ?, ?, ?, ?)')
            .run(taskId, op, status, iso(dueAt), status === 'claimed' ? HOLDER : null).lastInsertRowid,
    );
    const row = (id: number): OutboxRow => ledger.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as OutboxRow;
    const claimedBy = (id: number, holder: string): void => {
        ledger.db.prepare("UPDATE outbox SET status = 'claimed', claimed_by = ? WHERE id = ?").run(holder, id);
    };
    const pendingSyncStates = (): number =>
        (ledger.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE op = 'sync_state' AND status = 'pending'").get() as { n: number }).n;

    beforeEach(() => {
        ledger = tempLedger();
        workspaceId = ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'widgets')).id;
        task = createTask(ledger.db, { title: 'Queued', phase: 'planned', workspaceId, origin: 'local', source: 'test' });
    });

    afterEach(() => ledger.cleanup());

    it('claims the oldest due row for its holder, and nothing that is not due', () => {
        const due = insert('comment');
        insert('comment', 'pending', T0 + MINUTE_MS);
        const claimed = claimNext(ledger.db, HOLDER, T0);
        expect(claimed).toMatchObject({ id: due, status: 'claimed', claimed_by: 'pid:1', claimed_at: iso(T0) });
        expect(claimNext(ledger.db, 'pid:1', T0)).toBeUndefined();
    });

    it('skips the rows of a paused workspace', () => {
        const id = insert('comment');
        setSyncPause(ledger.db, workspaceId, 'GitHub CLI is not logged in.');
        expect(claimNext(ledger.db, 'pid:1', T0)).toBeUndefined();
        setSyncPause(ledger.db, workspaceId, undefined);
        expect(claimNext(ledger.db, 'pid:1', T0)?.id).toBe(id);
    });

    it('returns claims whose holder lost the lease, and only those', () => {
        acquireLease(ledger.db, 'pid:live', T0);
        const live = insert('comment');
        const dead = insert('comment');
        claimedBy(live, 'pid:live');
        claimedBy(dead, 'pid:dead');
        expect(releaseStaleClaims(ledger.db, T0)).toBe(1);
        expect(row(dead)).toMatchObject({ status: 'pending', claimed_by: null });
        expect(row(live)).toMatchObject({ status: 'claimed', claimed_by: 'pid:live' });
    });

    it('backs off exponentially, capped at 30 minutes', () => {
        expect([1, 2, 3, 6, 7, 8].map(backoffMs)).toEqual([
            PUSH_BACKOFF_BASE_MS, 2 * PUSH_BACKOFF_BASE_MS, 4 * PUSH_BACKOFF_BASE_MS, 32 * PUSH_BACKOFF_BASE_MS,
            PUSH_BACKOFF_CAP_MS, PUSH_BACKOFF_CAP_MS,
        ]);
        expect(PUSH_BACKOFF_CAP_MS).toBe(30 * MINUTE_MS);
    });

    it('retries with backoff, then gives up after the last attempt', () => {
        const id = insert('comment', 'claimed');
        expect(retryRow(ledger.db, row(id), HOLDER, 'HTTP 502', 3, T0)).toBe('pending');
        expect(row(id)).toMatchObject({ status: 'pending', attempts: 1, error: 'HTTP 502', next_attempt_at: iso(T0 + PUSH_BACKOFF_BASE_MS), claimed_by: null });
        claimedBy(id, HOLDER);
        expect(retryRow(ledger.db, row(id), HOLDER, 'HTTP 502', 3, T0)).toBe('pending');
        expect(row(id).status).toBe('pending');
        claimedBy(id, HOLDER);
        expect(retryRow(ledger.db, row(id), HOLDER, 'HTTP 503', 3, T0)).toBe('failed');
        expect(row(id)).toMatchObject({ status: 'failed', attempts: 3, error: 'HTTP 503' });
    });

    it('waits without counting an attempt when deferred', () => {
        const id = insert('comment', 'claimed');
        expect(deferRow(ledger.db, row(id), HOLDER, T0 + DEFER_MS)).toBe(true);
        expect(row(id)).toMatchObject({ status: 'pending', attempts: 0, next_attempt_at: iso(T0 + DEFER_MS) });
    });

    it('lets a returning sync_state give way to a newer one queued while it was out', () => {
        insert('sync_state', 'pending');
        const giveBack = [
            (out: OutboxRow) => retryRow(ledger.db, out, HOLDER, 'HTTP 502', 8, T0),
            (out: OutboxRow) => deferRow(ledger.db, out, HOLDER, T0 + DEFER_MS),
            (out: OutboxRow) => releaseRow(ledger.db, out, HOLDER),
        ];
        for (const give of giveBack) {
            const out = insert('sync_state', 'claimed');
            expect(() => give(row(out))).not.toThrow();
            expect(row(out)).toBeUndefined();
        }
        acquireLease(ledger.db, 'pid:new', T0);
        claimedBy(insert('sync_state', 'claimed'), 'pid:gone');
        expect(() => releaseStaleClaims(ledger.db, T0)).not.toThrow();
        expect(pendingSyncStates()).toBe(1);
    });

    it('keeps only the newest of several stale sync_state claims for a task with no pending one', () => {
        const older = insert('sync_state', 'claimed');
        claimedBy(older, 'pid:gone1');
        const newest = insert('sync_state', 'claimed');
        claimedBy(newest, 'pid:gone2');
        expect(() => releaseStaleClaims(ledger.db, T0)).not.toThrow();
        expect(pendingSyncStates()).toBe(1);
        expect(row(newest)).toMatchObject({ status: 'pending', claimed_by: null });
        expect(row(older)).toBeUndefined();
    });
    it('ignores late writes from a holder that lost its claim', () => {
        const first = 'pid:a';
        const second = 'pid:b';
        const id = insert('comment');
        acquireLease(ledger.db, first, T0);
        expect(claimNext(ledger.db, first, T0)?.id).toBe(id);
        const stale = row(id);
        const later = T0 + 2 * MINUTE_MS;
        acquireLease(ledger.db, second, later);
        expect(releaseStaleClaims(ledger.db, later)).toBe(1);
        expect(claimNext(ledger.db, second, later)?.id).toBe(id);
        expect(completeRow(ledger.db, id, second)).toBe(true);

        expect(retryRow(ledger.db, stale, first, 'HTTP 502', 8, later)).toBeNull();
        expect(failRow(ledger.db, id, first, 'late')).toBe(false);
        expect(completeRow(ledger.db, id, first)).toBe(false);
        expect(deferRow(ledger.db, stale, first, later)).toBe(false);
        expect(releaseRow(ledger.db, stale, first)).toBe(false);
        expect(row(id)).toMatchObject({ status: 'done', attempts: 0, error: null });
    });

    it('counts attempts from the ledger, not from the caller copy of the row', () => {
        const id = insert('comment', 'claimed');
        const copy = row(id);
        expect(retryRow(ledger.db, copy, HOLDER, 'one', 8, T0)).toBe('pending');
        claimedBy(id, HOLDER);
        expect(retryRow(ledger.db, copy, HOLDER, 'two', 8, T0)).toBe('pending');
        expect(row(id).attempts).toBe(2);
    });

    it('completes and fails rows', () => {
        const done = insert('comment', 'claimed');
        const failed = insert('comment', 'claimed');
        expect(completeRow(ledger.db, done, HOLDER)).toBe(true);
        expect(failRow(ledger.db, failed, HOLDER, 'No Azure DevOps state is set for phase in_review.')).toBe(true);
        expect(row(done).status).toBe('done');
        expect(row(failed)).toMatchObject({ status: 'failed', error: 'No Azure DevOps state is set for phase in_review.' });
    });

    it('re-arms failed rows while keeping one pending sync_state per task', () => {
        const other = createTask(ledger.db, { title: 'Other', phase: 'planned', workspaceId, origin: 'local', source: 'test' });
        insert('sync_state', 'failed');
        insert('sync_state', 'failed');
        insert('sync_state', 'pending');
        const comment = insert('comment', 'failed');
        insert('sync_state', 'failed', T0, other.id);
        const newestForOther = insert('sync_state', 'failed', T0, other.id);

        expect(rearmFailed(ledger.db, T0)).toBe(2);
        expect(row(comment)).toMatchObject({ status: 'pending', attempts: 0, error: null, next_attempt_at: iso(T0) });
        expect(row(newestForOther).status).toBe('pending');
        expect(pendingSyncStates()).toBe(2);
    });

    it('re-arms a failed sync_state whose task already has an older pending one', () => {
        insert('sync_state', 'pending');
        const failed = insert('sync_state', 'failed');
        expect(rearmFailed(ledger.db, T0)).toBe(0);
        expect(row(failed)).toBeUndefined();
        expect(pendingSyncStates()).toBe(1);
    });

    it('drops a failed create once its task is linked or has a newer create, and health stops reporting it', () => {
        const linkedTask = createTask(ledger.db, { title: 'Linked', phase: 'planned', workspaceId, origin: 'local', source: 'test' });
        const staleLinked = insert('create', 'failed', T0, linkedTask.id);
        insertVendorLink(ledger.db, { taskId: linkedTask.id, vendor: 'github', remoteId: '5' });
        const older = insert('create', 'failed');
        const newer = insert('create', 'failed');
        expect(outboxHealth(ledger.db)).toEqual({ pending: 0, failed: 1 });

        expect(rearmFailed(ledger.db, T0)).toBe(1);
        expect(row(staleLinked)).toBeUndefined();
        expect(row(older)).toBeUndefined();
        expect(row(newer).status).toBe('pending');
    });

    it('counts pending and failed work per workspace and machine-wide', () => {
        const otherWorkspace = ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'gadgets', 'https://github.com/acme/gadgets.git')).id;
        const otherTask = createTask(ledger.db, { title: 'Elsewhere', phase: 'planned', workspaceId: otherWorkspace, origin: 'local', source: 'test' });
        insert('comment');
        insert('comment', 'claimed');
        insert('comment', 'failed');
        insert('comment', 'done');
        insert('comment', 'pending', T0, otherTask.id);
        expect(outboxHealth(ledger.db, workspaceId)).toEqual({ pending: 2, failed: 1 });
        expect(outboxHealth(ledger.db)).toEqual({ pending: 3, failed: 1 });
    });

    it('sees due work: a due row, or a claim nobody is finishing, outside paused workspaces', () => {
        expect(hasDueWork(ledger.db, T0)).toBe(false);
        insert('comment', 'pending', T0 + MINUTE_MS);
        expect(hasDueWork(ledger.db, T0)).toBe(false);
        const claim = insert('comment', 'claimed');
        expect(hasDueWork(ledger.db, T0)).toBe(true);
        completeRow(ledger.db, claim, HOLDER);
        insert('comment');
        expect(hasDueWork(ledger.db, T0)).toBe(true);
        setSyncPause(ledger.db, workspaceId, 'paused');
        expect(hasDueWork(ledger.db, T0)).toBe(false);
    });
});
