import { Ledger, MS_PER_DAY, nowIso, write } from '../ledger/db';
import {
    getWorkspaceSetting, setWorkspaceSetting, SETTING_CURRENT_USER, SETTING_LAST_SYNC, SETTING_LINK_CHECK_CURSOR, SETTING_PR_CHECK_CURSOR,
    SETTING_PULL_WATERMARK,
} from '../ledger/settings';
import { bumpRevision, getTask, insertTaskRow, insertVendorLink } from '../ledger/tasks';
import { advancePhase } from '../ledger/work';
import { isStillRegistered } from '../ledger/workspaces';
import { CLOSED_PHASES, EventKind, Phase, SYNC_SOURCE, VENDOR_SOURCE, VendorLinkRow, WorkspaceRow } from '../ledger/types';
import { appendLog, SYNC_LOG_FILE } from '../hook/log';
import { unfinishedCreateNonces } from './outbox';
import { holdLease, LeaseLostError } from './lease';
import { PushDeps, guardWith } from './push';
import { applyRemoteItem, markLinkBroken } from './reconcile';
import { GoneError, RemoteItem, SyncPausedError, VendorAdapter } from './vendor';

/** Spec O2: all states for items changed in the last 90 days, plus all linked items. */
export const PULL_WINDOW_DAYS = 90;
export const PULL_PAGE_LIMIT = 500;
/** How far before its start the next pull re-reads: the vendor's clock and search index may lag ours. */
export const PULL_OVERLAP_MS = 5 * 60 * 1000;
/** Linked items the list did not return that one pull re-reads, rotating through all of them. */
export const LINK_CHECK_LIMIT = 10;
/** PR events (newest first) of open tasks that one pull asks about. */
export const PR_CHECK_LIMIT = 10;
const NEW_ITEM_PHASE: Phase = 'planned';
const PR_MERGED_PHASE: Phase = 'done';
const PR_EVENT: EventKind = 'pr';
const GONE_REASON = 'deleted or moved away on the vendor';

export interface PullSummary {
    fetched: number;
    created: number;
    humanEdits: number;
    broken: number;
    merged: number;
    /** The page came back full and moved the watermark: there is more to read now, not after sync_pull_minutes. */
    more: boolean;
}

/** `ghostpm unregister` forgot the workspace while its pull was out: stop at once, writing nothing (as a lost lease does). */
export class WorkspaceGoneError extends Error {
    constructor(workspace: WorkspaceRow) {
        super(`${workspace.path} was unregistered while it was being pulled`);
        this.name = 'WorkspaceGoneError';
    }
}

type UpsertOutcome = 'created' | 'edited' | 'refreshed' | 'awaiting_adoption';

/** A vendor item with what a new task needs from it worked out before any write (no vendor text work under the write lock). */
interface Incoming {
    item: RemoteItem;
    phase: Phase;
    labels: string;
}

const incoming = (adapter: VendorAdapter, item: RemoteItem): Incoming =>
    ({ item, phase: adapter.phaseOf(item.state, item.labels, NEW_ITEM_PHASE), labels: JSON.stringify(item.labels) });

function linkByRemote(db: Ledger, workspace: WorkspaceRow, remoteId: string): VendorLinkRow | undefined {
    return db.prepare(`
        SELECT l.* FROM vendor_links l JOIN tasks t ON t.id = l.task_id
        WHERE t.workspace_id = ? AND l.vendor = ? AND l.remote_id = ?
        ORDER BY l.task_id LIMIT 1`)
        .get(workspace.id, workspace.vendor, remoteId) as VendorLinkRow | undefined;
}

/**
 * New items become vendor-origin tasks; linked ones go through human wins (which also repairs a broken link).
 * The adapter already stripped our retry markers from the body. An unlinked item that carries the marker of a create
 * not yet done is that create's own: its retry adopts it, so importing it here would link a second task to it. Call inside write().
 */
function upsertItem(db: Ledger, workspace: WorkspaceRow, adapter: VendorAdapter, { item, phase, labels }: Incoming): UpsertOutcome {
    const link = linkByRemote(db, workspace, item.remoteId);
    if (link !== undefined) {
        return applyRemoteItem(db, adapter, getTask(db, link.task_id)!, link, item) ? 'edited' : 'refreshed';
    }
    if (item.markers.length > 0) {
        const owned = unfinishedCreateNonces(db, workspace.id);
        if (item.markers.some(nonce => owned.has(nonce))) return 'awaiting_adoption';
    }
    const task = insertTaskRow(db, {
        title: item.title, phase, workspaceId: workspace.id,
        origin: 'vendor', source: VENDOR_SOURCE, body: item.body, assignee: item.assignee, milestone: item.milestone,
    }, nowIso());
    insertVendorLink(db, {
        taskId: task.id, vendor: workspace.vendor, remoteId: item.remoteId, remoteUrl: item.url, remoteState: item.state,
        labels, remoteUpdatedAt: item.updatedAt, remoteTitle: item.title,
    });
    return 'created';
}

/**
 * The next `limit` of `items` (in ascending `keyOf` order) after the workspace's cursor stored under `setting`,
 * wrapping round to the first; the cursor moves to the last one taken, so every item gets its turn. Call inside write().
 */
function nextBatch<T>(db: Ledger, workspace: WorkspaceRow, setting: string, items: T[], keyOf: (item: T) => number, limit: number): T[] {
    const cursor = getWorkspaceSetting<number>(db, workspace.id, setting) ?? 0;
    const start = items.findIndex(item => keyOf(item) > cursor);
    const rotated = start < 0 ? items : items.slice(start).concat(items.slice(0, start));
    const batch = rotated.slice(0, limit);
    if (batch.length > 0) setWorkspaceSetting(db, workspace.id, setting, keyOf(batch[batch.length - 1]));
    return batch;
}

/** O2 "plus all linked items": the links this pull did not see, a batch at a time, rotating by task id. Call inside write(). */
function linksToCheck(db: Ledger, workspace: WorkspaceRow, seen: Set<string>): VendorLinkRow[] {
    const links = (db.prepare(`
        SELECT l.* FROM vendor_links l JOIN tasks t ON t.id = l.task_id
        WHERE t.workspace_id = ? AND l.vendor = ? AND l.broken_at IS NULL
        ORDER BY l.task_id`)
        .all(workspace.id, workspace.vendor) as VendorLinkRow[])
        .filter(link => !seen.has(link.remote_id));
    return nextBatch(db, workspace, SETTING_LINK_CHECK_CURSOR, links, link => link.task_id, LINK_CHECK_LIMIT);
}

/** One pull request to ask about, with every open task that recorded it; `seq` is when it was first recorded. */
interface PullRequestCheck {
    url: string;
    seq: number;
    taskIds: number[];
}

/**
 * Ruling F9: each pull request recorded on an open task, asked about once however often it was recorded, a batch at a
 * time, rotating by when it was first recorded so none waits behind newer ones for ever. Call inside write().
 */
function pullRequestsToCheck(db: Ledger, workspace: WorkspaceRow): PullRequestCheck[] {
    const closed = Array.from(CLOSED_PHASES);
    const rows = db.prepare(`
        SELECT e.seq AS seq, e.task_id AS taskId, e.payload AS payload FROM events e JOIN tasks t ON t.id = e.task_id
        WHERE t.workspace_id = ? AND e.kind = ? AND t.phase NOT IN (${closed.map(() => '?').join(', ')})
        ORDER BY e.seq`)
        .all(workspace.id, PR_EVENT, ...closed) as { seq: number; taskId: number; payload: string | null }[];
    const byUrl = new Map<string, PullRequestCheck>();
    for (const row of rows) {
        const url = (JSON.parse(row.payload ?? '{}') as { url?: unknown }).url;
        if (typeof url !== 'string' || url.length === 0) continue;
        const known = byUrl.get(url);
        if (known === undefined) byUrl.set(url, { url, seq: row.seq, taskIds: [row.taskId] });
        else if (known.taskIds.indexOf(row.taskId) < 0) known.taskIds.push(row.taskId);
    }
    // A Map keeps insertion order: by first record.
    return nextBatch(db, workspace, SETTING_PR_CHECK_CURSOR, Array.from(byUrl.values()), check => check.seq, PR_CHECK_LIMIT);
}

function latestChange(items: RemoteItem[]): string {
    return items.reduce((latest, item) => (Date.parse(item.updatedAt) > Date.parse(latest) ? item.updatedAt : latest), items[0].updatedAt);
}

/**
 * One pull of one workspace, by the holder of the sync lease, which it renews before every vendor call
 * (ruling D7) and checks in every write (ruling F2). Throws on a vendor failure or a lost lease; the
 * watermark and last_sync then stay where they were.
 */
export async function pullWorkspace(
    db: Ledger,
    workspace: WorkspaceRow,
    deps: PushDeps,
    pageLimit: number = PULL_PAGE_LIMIT,
): Promise<PullSummary> {
    // Taken before any fetch, so what changes while fetching is read next time (spec §8.5).
    const startedAt = deps.now();
    // A ledger from before the watermark existed reads from its last_sync, which held the same thing (no migration).
    const since = getWorkspaceSetting<string>(db, workspace.id, SETTING_PULL_WATERMARK)
        ?? getWorkspaceSetting<string>(db, workspace.id, SETTING_LAST_SYNC)
        ?? new Date(startedAt - PULL_WINDOW_DAYS * MS_PER_DAY).toISOString();
    const summary: PullSummary = { fetched: 0, created: 0, humanEdits: 0, broken: 0, merged: 0, more: false };
    const count = (outcome: UpsertOutcome): void => {
        if (outcome === 'created') summary.created++;
        else if (outcome === 'edited') summary.humanEdits++;
    };
    const renew = (): void => holdLease(db, deps.holder, deps.now());
    // As the pusher does: the runner renews before each CLI call, and each adapter call renews first
    // (which covers adapters with no CLI runner of their own).
    const adapter = deps.adapterFor(workspace, guardWith(renew));
    const leased = (): VendorAdapter => {
        renew();
        return adapter;
    };
    // Ruling F2: every write checks the lease first, as the pusher checks its claim, so a lost lease stops the pull
    // before anything it read lands, the watermark included. So does an unregister: the next folder registered would
    // take this workspace's id, and with it whatever the pull went on to write.
    const leasedWrite = <T>(fn: () => T): T => write(db, () => {
        renew();
        if (!isStillRegistered(db, workspace)) throw new WorkspaceGoneError(workspace);
        return fn();
    });
    const upsert = (item: RemoteItem): void => {
        const prepared = incoming(adapter, item);
        count(leasedWrite(() => upsertItem(db, workspace, adapter, prepared)));
    };

    // Gap-map N3: without it `@me` and the "assigned to me" candidates never work.
    if (getWorkspaceSetting<string>(db, workspace.id, SETTING_CURRENT_USER) === undefined) {
        const user = await leased().currentUser();
        if (user !== null) leasedWrite(() => setWorkspaceSetting(db, workspace.id, SETTING_CURRENT_USER, user));
    }

    const items = await leased().listChangedSince(since, pageLimit);
    summary.fetched = items.length;
    const seen = new Set<string>();
    for (const item of items) {
        seen.add(item.remoteId);
        upsert(item);
    }

    for (const link of leasedWrite(() => linksToCheck(db, workspace, seen))) {
        const item = await leased().fetch(link.remote_id);
        if (item === null) {
            leasedWrite(() => markLinkBroken(db, link, GONE_REASON, nowIso()));
            summary.broken++;
        } else {
            upsert(item);
        }
    }

    for (const pr of leasedWrite(() => pullRequestsToCheck(db, workspace))) {
        let mergedAt: string | null;
        try {
            mergedAt = await leased().mergedAt(pr.url);
        } catch (error) {
            // Ruling F5: one pull request that cannot be read must not stop this pull, nor every pull after it. A lost
            // lease or a reason to pause still ends the pull; a gone pull request is simply not merged.
            if (error instanceof LeaseLostError || error instanceof SyncPausedError) throw error;
            if (!(error instanceof GoneError)) {
                appendLog(SYNC_LOG_FILE, `pull ${workspace.path}: ${pr.url}: ${error instanceof Error ? error.message : String(error)}`);
            }
            continue;
        }
        if (mergedAt === null) continue;
        const merged = mergedAt;
        // Evidence, not a human edit: blocked if a person changed the phase after the merge (spec §8.6).
        summary.merged += leasedWrite(() => pr.taskIds.filter(taskId => {
            const task = getTask(db, taskId);
            const at = nowIso();
            if (task === undefined || !advancePhase(db, task, PR_MERGED_PHASE, { source: SYNC_SOURCE, human: false }, at, merged)) return false;
            // Ruling D2: a new revision, or the pusher skips the queued state as the one it last pushed.
            bumpRevision(db, task.id, at);
            return true;
        }).length);
    }

    // A full page may have more behind it: continue from the newest change seen, and leave last_sync so the next pull is
    // due at once. Otherwise re-read a little before this pull began, for a vendor clock or search index behind ours
    // (ruling F4; re-reads are de-duplicated by baseline), and count the schedule from when this pull began. Only an
    // adapter that lists by page can come back full (ruling F6).
    const full = adapter.pages && items.length >= pageLimit;
    const watermark = full ? latestChange(items) : new Date(startedAt - PULL_OVERLAP_MS).toISOString();
    leasedWrite(() => {
        setWorkspaceSetting(db, workspace.id, SETTING_PULL_WATERMARK, watermark);
        if (!full) setWorkspaceSetting(db, workspace.id, SETTING_LAST_SYNC, new Date(startedAt).toISOString());
    });
    // A full page whose changes all share the time it read from cannot move on (a tie stall): it waits as any pull does.
    summary.more = full && Date.parse(watermark) > Date.parse(since);
    return summary;
}
