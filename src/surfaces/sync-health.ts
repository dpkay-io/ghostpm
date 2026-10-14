// The only module surfaces read Phase 3's sync state through: if the contract moves, only these imports change.
import { Ledger, nowIso } from '../ledger/db';
import { getSyncPause } from '../ledger/settings';
import { NO_VENDOR, WorkspaceRow } from '../ledger/types';
import { leaseHolder } from '../sync/lease';
import { outboxHealth } from '../sync/outbox';
import { SYNCED_REMOTES, identityOf } from '../sync/identity';
import { syncIsOff, syncOffHint } from '../sync/schedule';
import { cleanText } from './text';

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
/** How a vendor workspace with no remote on record names it. */
const NO_REMOTE_TEXT = 'none';
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

/** The short state a table cell shows, and the detail that explains it (the off reason, or the pause reason). */
export interface SyncDescription {
    state: string;
    detail: string | null;
}

const STATE_PAUSED = 'paused';
const STATE_UNRECOGNISED = 'remote not recognised';
/** The states whose detail says it all: describeSync prints the detail alone. */
const STATES_IN_DETAIL = [STATE_PAUSED, STATE_UNRECOGNISED];

/**
 * A vendor remote sync cannot read the repository or project from (www.github.com, say), cleaned: git config is text
 * anyone can write. Null when sync can read it, or there is no vendor at all.
 */
export function unrecognisedRemote(workspace: WorkspaceRow): string | null {
    if (workspace.vendor === NO_VENDOR || identityOf(workspace) !== null) return null;
    return `${STATE_UNRECOGNISED}: ${cleanText(workspace.git_remote ?? NO_REMOTE_TEXT)}; GhostPM syncs ${SYNCED_REMOTES} remotes`;
}

/** `health` may be passed when the caller already read it. */
export function syncDescription(db: Ledger, workspace: WorkspaceRow, health: SyncHealth = workspaceSyncHealth(db, workspace.id)): SyncDescription {
    const off = syncOffReason(db, workspace);
    if (off !== null) return { state: SYNC_OFF, detail: off };
    const counts: string[] = [];
    if (health.pending > 0) counts.push(`${health.pending} pending`);
    if (health.failed > 0) counts.push(`${health.failed} failed`);
    // The pause reason quotes the vendor CLI: cleaned here, once for every surface. With no pause yet, a remote sync
    // cannot read is still never ok: the first sync would only pause on it.
    const paused = health.paused === null ? null : `${STATE_PAUSED}: ${cleanText(health.paused)}`;
    const detail = paused ?? unrecognisedRemote(workspace);
    if (counts.length > 0) return { state: counts.join(PART_SEPARATOR), detail };
    if (detail === null) return { state: SYNC_OK, detail };
    return { state: paused === null ? STATE_UNRECOGNISED : STATE_PAUSED, detail };
}

/** Sync state in words, the same on every surface: off and why first, else what is queued, failed, paused or unreadable, else ok. */
export function describeSync(db: Ledger, workspace: WorkspaceRow): string {
    const { state, detail } = syncDescription(db, workspace);
    if (detail === null) return state;
    if (state === SYNC_OFF) return `${state} (${detail})`;
    return STATES_IN_DETAIL.indexOf(state) >= 0 ? detail : `${state}${PART_SEPARATOR}${detail}`;
}
