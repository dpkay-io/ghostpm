import { Ledger } from '../ledger/db';

export const SYNC_LEASE = 'sync';
/** Spec §8.1: TTL 60 s, renewed while running. */
export const LEASE_TTL_MS = 60 * 1000;
const HOLDER_PREFIX = 'pid:';

const iso = (ms: number): string => new Date(ms).toISOString();

export const leaseHolderId = (pid: number = process.pid): string => `${HOLDER_PREFIX}${pid}`;

/** Takes a free or expired lease, or renews one's own, in one statement. */
export function acquireLease(db: Ledger, holder: string, now: number = Date.now(), ttlMs: number = LEASE_TTL_MS): boolean {
    return db.prepare(`
        INSERT INTO leases (name, holder, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
        WHERE leases.holder = excluded.holder OR leases.expires_at < ?`)
        .run(SYNC_LEASE, holder, iso(now + ttlMs), iso(now)).changes === 1;
}

export function releaseLease(db: Ledger, holder: string): void {
    db.prepare('DELETE FROM leases WHERE name = ? AND holder = ?').run(SYNC_LEASE, holder);
}

/** Who is syncing right now, if anyone. */
export function leaseHolder(db: Ledger, now: number = Date.now()): { holder: string; expiresAt: string } | undefined {
    const row = db.prepare('SELECT holder, expires_at FROM leases WHERE name = ? AND expires_at >= ?')
        .get(SYNC_LEASE, iso(now)) as { holder: string; expires_at: string } | undefined;
    return row === undefined ? undefined : { holder: row.holder, expiresAt: row.expires_at };
}