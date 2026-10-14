// The only module surfaces read Phase 3's sync state through: if the contract moves, only these imports change.
import { Ledger, nowIso } from '../ledger/db';
import { getSyncPause } from '../ledger/settings';
import { NO_VENDOR, WorkspaceRow } from '../ledger/types';
import { leaseHolder } from '../sync/lease';
import { outboxHealth } from '../sync/outbox';
import { syncIsOff, syncOffHint } from '../sync/schedule';

export interface SyncHealth {
    /** Queued and in-flight (claimed) pushes alike. */
    pending: number;
    failed: number;
    paused: string | null;
}

export interface SyncRunner {
    holder: string;
    expiresAt: string;
}

export interface MachineSyncHealth {
    pending: number;
    failed: number;
    runner: SyncRunner | null;
}

export const SYNC_OFF = 'off';
export const SYNC_OK = 'ok';
const NO_REMOTE = 'no GitHub or Azure DevOps remote';
const PART_SEPARATOR = ' · ';

export function workspaceSyncHealth(db: Ledger, workspaceId: number): SyncHealth {
    const { pending, failed } = outboxHealth(db, workspaceId);
    return { pending, failed, paused: getSyncPause(db, workspaceId) ?? null };
}

/** `now` is the snapshot time: the runner is whoever holds the lease at that moment. */
export function machineSyncHealth(db: Ledger, now: string = nowIso()): MachineSyncHealth {
    const { pending, failed } = outboxHealth(db);
    return { pending, failed, runner: leaseHolder(db, Date.parse(now)) ?? null };
}

/** Why sync never runs in this workspace (no vendor remote, or `sync_policy off`), or null when it runs. */
export function syncOffReason(db: Ledger, workspace: WorkspaceRow): string | null {
    if (workspace.vendor === NO_VENDOR) return NO_REMOTE;
    return syncIsOff(db, workspace) ? syncOffHint(workspace.path) : null;
}

/** Sync state in words, the same on every surface: off and why first, else what is queued, failed or paused, else ok. */
export function describeSync(db: Ledger, workspace: WorkspaceRow): string {
    const off = syncOffReason(db, workspace);
    if (off !== null) return `${SYNC_OFF} (${off})`;
    const health = workspaceSyncHealth(db, workspace.id);
    const parts: string[] = [];
    if (health.pending > 0) parts.push(`${health.pending} pending`);
    if (health.failed > 0) parts.push(`${health.failed} failed`);
    if (health.paused !== null) parts.push(`paused: ${health.paused}`);
    return parts.length > 0 ? parts.join(PART_SEPARATOR) : SYNC_OK;
}
