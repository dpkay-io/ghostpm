import { Ledger, nowIso, write } from '../ledger/db';
import {
    getWorkspaceSetting, setWorkspaceSetting, SETTING_CURRENT_USER, SETTING_LAST_SYNC, SETTING_LINK_CHECK_CURSOR,
} from '../ledger/settings';
import { bumpRevision, getTask, insertTaskRow, insertVendorLink } from '../ledger/tasks';
import { advancePhase } from '../ledger/work';
import { CLOSED_PHASES, EventKind, Phase, SYNC_SOURCE, VENDOR_SOURCE, VendorLinkRow, WorkspaceRow } from '../ledger/types';
import { holdLease } from './lease';
import { PushDeps, guardWith } from './push';
import { applyRemoteItem, markLinkBroken } from './reconcile';
import { RemoteItem, VendorAdapter } from './vendor';

/** Spec O2: all states for items changed in the last 90 days, plus all linked items. */
export const PULL_WINDOW_DAYS = 90;
export const PULL_PAGE_LIMIT = 500;
/** Linked items the list did not return that one pull re-reads, rotating through all of them. */
export const LINK_CHECK_LIMIT = 10;
/** PR events (newest first) of open tasks that one pull asks about. */
export const PR_CHECK_LIMIT = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
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
}

type UpsertOutcome = 'created' | 'edited' | 'refreshed';

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
 * The adapter already stripped our retry markers from the body. Call inside write().
 */
function upsertItem(db: Ledger, workspace: WorkspaceRow, adapter: VendorAdapter, { item, phase, labels }: Incoming): UpsertOutcome {
    const link = linkByRemote(db, workspace, item.remoteId);
    if (link !== undefined) {
        return applyRemoteItem(db, adapter, getTask(db, link.task_id)!, link, item) ? 'edited' : 'refreshed';
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

/** O2 "plus all linked items": the links this pull did not see, a batch at a time, rotating by task id. */
function linksToCheck(db: Ledger, workspace: WorkspaceRow, seen: Set<string>): VendorLinkRow[] {
    const links = (db.prepare(`
        SELECT l.* FROM vendor_links l JOIN tasks t ON t.id = l.task_id
        WHERE t.workspace_id = ? AND l.vendor = ? AND l.broken_at IS NULL
        ORDER BY l.task_id`)
        .all(workspace.id, workspace.vendor) as VendorLinkRow[])
        .filter(link => !seen.has(link.remote_id));
    const cursor = getWorkspaceSetting<number>(db, workspace.id, SETTING_LINK_CHECK_CURSOR) ?? 0;
    const start = links.findIndex(link => link.task_id > cursor);
    const rotated = start < 0 ? links : links.slice(start).concat(links.slice(0, start));
    const batch = rotated.slice(0, LINK_CHECK_LIMIT);
    if (batch.length > 0) setWorkspaceSetting(db, workspace.id, SETTING_LINK_CHECK_CURSOR, batch[batch.length - 1].task_id);
    return batch;
}

function openPullRequests(db: Ledger, workspaceId: number): { taskId: number; url: string }[] {
    const closed = Array.from(CLOSED_PHASES);
    const rows = db.prepare(`
        SELECT e.task_id AS taskId, e.payload AS payload FROM events e JOIN tasks t ON t.id = e.task_id
        WHERE t.workspace_id = ? AND e.kind = ? AND t.phase NOT IN (${closed.map(() => '?').join(', ')})
        ORDER BY e.seq DESC LIMIT ?`)
        .all(workspaceId, PR_EVENT, ...closed, PR_CHECK_LIMIT) as { taskId: number; payload: string | null }[];
    const prs: { taskId: number; url: string }[] = [];
    for (const row of rows) {
        const url = (JSON.parse(row.payload ?? '{}') as { url?: unknown }).url;
        if (typeof url === 'string' && url.length > 0) prs.push({ taskId: row.taskId, url });
    }
    return prs;
}

function latestChange(items: RemoteItem[]): string {
    return items.reduce((latest, item) => (Date.parse(item.updatedAt) > Date.parse(latest) ? item.updatedAt : latest), items[0].updatedAt);
}

/**
 * One pull of one workspace, by the holder of the sync lease, which it renews before every vendor call
 * (ruling D7). Throws on a vendor failure or a lost lease; the watermark then stays where it was.
 */
export async function pullWorkspace(
    db: Ledger,
    workspace: WorkspaceRow,
    deps: PushDeps,
    pageLimit: number = PULL_PAGE_LIMIT,
): Promise<PullSummary> {
    // Taken before any fetch, so what changes while fetching is read next time (spec §8.5).
    const now = deps.now();
    const startedAt = new Date(now).toISOString();
    const since = getWorkspaceSetting<string>(db, workspace.id, SETTING_LAST_SYNC)
        ?? new Date(now - PULL_WINDOW_DAYS * MS_PER_DAY).toISOString();
    const summary: PullSummary = { fetched: 0, created: 0, humanEdits: 0, broken: 0, merged: 0 };
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
    const upsert = (item: RemoteItem): void => {
        const prepared = incoming(adapter, item);
        count(write(db, () => upsertItem(db, workspace, adapter, prepared)));
    };

    // Gap-map N3: without it `@me` and the "assigned to me" candidates never work.
    if (getWorkspaceSetting<string>(db, workspace.id, SETTING_CURRENT_USER) === undefined) {
        setWorkspaceSetting(db, workspace.id, SETTING_CURRENT_USER, await leased().currentUser());
    }

    const items = await leased().listChangedSince(since, pageLimit);
    summary.fetched = items.length;
    const seen = new Set<string>();
    for (const item of items) {
        seen.add(item.remoteId);
        upsert(item);
    }

    for (const link of linksToCheck(db, workspace, seen)) {
        const item = await leased().fetch(link.remote_id);
        if (item === null) {
            write(db, () => markLinkBroken(db, link, GONE_REASON, nowIso()));
            summary.broken++;
        } else {
            upsert(item);
        }
    }

    for (const pr of openPullRequests(db, workspace.id)) {
        const mergedAt = await leased().mergedAt(pr.url);
        if (mergedAt === null) continue;
        // Evidence, not a human edit: blocked if a person changed the phase after the merge (spec §8.6).
        const moved = write(db, () => {
            const task = getTask(db, pr.taskId);
            const at = nowIso();
            if (task === undefined || !advancePhase(db, task, PR_MERGED_PHASE, { source: SYNC_SOURCE, human: false }, at, mergedAt)) return false;
            // Ruling D2: a new revision, or the pusher skips the queued state as the one it last pushed.
            bumpRevision(db, task.id, at);
            return true;
        });
        if (moved) summary.merged++;
    }

    // A full page may have more behind it: continue from the newest change seen, not from now.
    setWorkspaceSetting(db, workspace.id, SETTING_LAST_SYNC, items.length >= pageLimit ? latestChange(items) : startedAt);
    return summary;
}
