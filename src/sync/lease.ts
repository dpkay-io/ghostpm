import { randomBytes } from 'crypto';
import { Ledger } from '../ledger/db';

export const SYNC_LEASE = 'sync';
/** Spec §8.1: TTL 60 s, renewed while running. */
export const LEASE_TTL_MS = 60 * 1000;
const HOLDER_PREFIX = 'pid:';
const NONCE_BYTES = 4;
/** Fixed per process start, so a reused PID cannot impersonate a dead holder. */
const START_NONCE = randomBytes(NONCE_BYTES).toString('hex');

const iso = (ms: number): string => new Date(ms).toISOString();

export const leaseHolderId = (pid: number = process.pid): string => `${HOLDER_PREFIX}${pid}:${START_NONCE}`;

/** Takes a free or expired lease, or renews one's own, in one statement. */
export function acquireLease(db: Ledger, holder: string, now: number = Date.now(), ttlMs: number = LEASE_TTL_MS): boolean {
    return db.prepare(`
        INSERT INTO leases (name, holder, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
        WHERE leases.holder = excluded.holder OR leases.expires_at < ?`)
        .run(SYNC_LEASE, holder, iso(now + ttlMs), iso(now)).changes === 1;
}

/** The lease ran out or another runner took it: stop at once, writing nothing (§8.1: one sync runner). */
export class LeaseLostError extends Error {
    constructor() {
        super('the sync lease is gone');
        this.name = 'LeaseLostError';
    }
}

/** Before every vendor call: renew the lease, so each call starts with a full TTL, longer than its timeout. */
export function holdLease(db: Ledger, holder: string, now: number): void {
    if (!acquireLease(db, holder, now)) throw new LeaseLostError();
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