import { Ledger } from '../ledger/db';
import {
    getSyncPause, getWorkspaceSetting, readSetting, SETTING_LAST_SYNC, SETTING_SYNC_POLICY, SETTING_SYNC_PULL_MINUTES, SYNC_POLICY_OFF,
} from '../ledger/settings';
import { NO_VENDOR, WorkspaceRow } from '../ledger/types';
import { leaseHolder } from './lease';
import { hasDueWork } from './outbox';

/** `ghostpm sync`, and the flag SessionStart adds to it. */
export const SYNC_COMMAND = 'sync';
export const BACKGROUND_FLAG = '--background';
const MS_PER_MINUTE = 60 * 1000;

/** Ruling 4: `off` (the default) means no push, no pull and no SessionStart spawn for the workspace. */
export function syncIsOff(db: Ledger, workspace: WorkspaceRow): boolean {
    return readSetting(db, workspace.id, SETTING_SYNC_POLICY) === SYNC_POLICY_OFF;
}

/** Spec §8.1: every `sync_pull_minutes`, for a vendor workspace that syncs and is not paused. */
export function pullIsDue(db: Ledger, workspace: WorkspaceRow, now: number): boolean {
    if (workspace.vendor === NO_VENDOR || syncIsOff(db, workspace) || getSyncPause(db, workspace.id) !== undefined) return false;
    const last = getWorkspaceSetting<string>(db, workspace.id, SETTING_LAST_SYNC);
    return last === undefined || Date.parse(last) + readSetting(db, null, SETTING_SYNC_PULL_MINUTES) * MS_PER_MINUTE <= now;
}

/** SessionStart's question (spec §8.1): is there sync work, and nobody doing it? Never in a workspace that is off. */
export function shouldStartSync(db: Ledger, workspace: WorkspaceRow, now: number): boolean {
    if (syncIsOff(db, workspace) || leaseHolder(db, now) !== undefined) return false;
    return hasDueWork(db, now) || pullIsDue(db, workspace, now);
}
