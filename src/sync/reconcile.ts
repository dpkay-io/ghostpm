import { Ledger } from '../ledger/db';
import { recordEvent } from '../ledger/events';
import { dropPendingSyncState } from '../ledger/projection';
import { updateTask } from '../ledger/tasks';
import { SYNC_SOURCE, TaskRow, VENDOR_SOURCE, VendorLinkRow } from '../ledger/types';
import { DesiredState, RemoteItem, VendorAdapter, parseLabels, stripMarkers } from './vendor';

const LINK_KEY = 'task_id = ? AND vendor = ?';
const NO_INTENT = 'intent_title = NULL, intent_phase = NULL, intent_rev = NULL';

/** An answer older than the stored baseline arrived late (a slower runner): it must not replace the newer one. */
function isStale(db: Ledger, link: VendorLinkRow, updatedAt: string): boolean {
    const stored = db.prepare(`SELECT remote_updated_at FROM vendor_links WHERE ${LINK_KEY}`).get(link.task_id, link.vendor) as
        { remote_updated_at: string | null } | undefined;
    return stored === undefined
        || (stored.remote_updated_at !== null && Date.parse(updatedAt) < Date.parse(stored.remote_updated_at));
}

/** What the vendor holds becomes the comparison point for the next pull (spec §8.6). Monotonic in remote_updated_at. */
function writeBaseline(db: Ledger, link: VendorLinkRow, item: RemoteItem, title: string, lastPushedRev: number | null, endIntent: boolean): void {
    if (isStale(db, link, item.updatedAt)) return;
    db.prepare(`
        UPDATE vendor_links
        SET remote_title = ?, remote_state = ?, labels = ?, remote_updated_at = ?, remote_url = COALESCE(?, remote_url),
            broken_at = NULL, last_pushed_rev = COALESCE(?, last_pushed_rev)${endIntent ? `, ${NO_INTENT}` : ''}
        WHERE ${LINK_KEY}`)
        .run(title, item.state, JSON.stringify(item.labels), item.updatedAt, item.url, lastPushedRev, link.task_id, link.vendor);
}

const isNewer = (item: RemoteItem, link: VendorLinkRow): boolean =>
    link.remote_updated_at === null || Date.parse(item.updatedAt) > Date.parse(link.remote_updated_at);

/** Our own push, landed without its answer being recorded (a failed re-read, a timeout, a lost claim). */
const matchesIntent = (adapter: VendorAdapter, link: VendorLinkRow, item: RemoteItem): boolean =>
    link.intent_title !== null && link.intent_phase !== null
    && adapter.titlesMatch(item.title, link.intent_title)
    && adapter.phaseOf(item.state, item.labels, link.intent_phase) === link.intent_phase;

/**
 * Spec §8.6, human wins. `item` is what the vendor holds now. If it is newer than the
 * baseline and its title or phase differs from what we last saw there, a person (or a bot:
 * the spec's accepted limitation) edited it: apply that here as a human change, and drop
 * the pending push only when the edit replaced both title and phase (Ruling: it may carry
 * a local change the person did not touch). A newer item that is the push in flight
 * (`intent_*`) is ours, not an edit. Then `item` becomes the baseline.
 * Returns whether a human edit was applied. Plain statements: call inside write().
 */
export function applyRemoteItem(db: Ledger, adapter: VendorAdapter, task: TaskRow, link: VendorLinkRow, item: RemoteItem): boolean {
    if (!isNewer(item, link)) return false;
    const ours = matchesIntent(adapter, link, item);
    let edited = false;
    if (!ours) {
        const titleChanged = !adapter.titlesMatch(item.title, link.remote_title ?? task.title);
        const knownPhase = link.remote_state === null
            ? task.phase
            : adapter.phaseOf(link.remote_state, parseLabels(link.labels), task.phase);
        const remotePhase = adapter.phaseOf(item.state, item.labels, task.phase);
        const phaseChanged = remotePhase !== knownPhase && remotePhase !== task.phase;
        if (titleChanged || phaseChanged) {
            updateTask(db, task.id, {
                title: titleChanged ? item.title : undefined,
                phase: phaseChanged ? remotePhase : undefined,
            }, { source: VENDOR_SOURCE, human: true });
            if (titleChanged && phaseChanged) dropPendingSyncState(db, task.id);
            edited = true;
        }
    }
    // Vendor-owned fields: shown locally (without our retry markers), never pushed.
    db.prepare('UPDATE tasks SET body = ?, assignee = ?, milestone = ? WHERE id = ?')
        .run(item.body === null ? null : stripMarkers(item.body), item.assignee, item.milestone, task.id);
    // The intent ends with our push adopted, or with a person's edit applied over it (it can never be ours after that).
    if (ours) writeBaseline(db, link, item, link.intent_title!, link.intent_rev, true);
    else writeBaseline(db, link, item, item.title, null, edited);
    return edited;
}

/**
 * Written just before a state-changing vendor call, in the same short write that checks the claim:
 * if the call lands but its answer is lost, the next read recognises the result as ours.
 */
export function recordIntent(db: Ledger, link: VendorLinkRow, desired: DesiredState, rev: number | null): void {
    db.prepare(`UPDATE vendor_links SET intent_title = ?, intent_phase = ?, intent_rev = ? WHERE ${LINK_KEY}`)
        .run(desired.title, desired.phase, rev, link.task_id, link.vendor);
}

/** After our own push the vendor holds what we sent: record it as the baseline, not as an edit. */
export function recordOwnPush(db: Ledger, link: VendorLinkRow, item: RemoteItem, pushedTitle: string, rev: number | null): void {
    writeBaseline(db, link, item, pushedTitle, rev, true);
}

/** The push in flight ended without landing (refused, retries used up): nothing on the vendor is ours to recognise. */
export function clearIntent(db: Ledger, taskId: number): void {
    db.prepare(`UPDATE vendor_links SET ${NO_INTENT} WHERE task_id = ?`).run(taskId);
}

/** Spec §8.5: deleted or moved away. The task stays local, with an event saying so. */
export function markLinkBroken(db: Ledger, link: VendorLinkRow, reason: string, at: string): void {
    db.prepare(`UPDATE vendor_links SET broken_at = ?, ${NO_INTENT} WHERE ${LINK_KEY}`).run(at, link.task_id, link.vendor);
    recordEvent(db, {
        taskId: link.task_id, kind: 'linked', source: SYNC_SOURCE,
        payload: { vendor: link.vendor, remoteId: link.remote_id, broken: true, reason },
    }, at);
}
