import { Ledger, nowIso, write } from '../ledger/db';
import { recordEvent } from '../ledger/events';
import {
    CloseDuplicatePayload, CommentPayload, OutboxOp, OutboxRow, STATUS_FAILED, hasActiveCreate, projectTask,
} from '../ledger/projection';
import { readSetting, SETTING_MAX_PUSH_ATTEMPTS, SETTING_SYNC_POLICY, SYNC_POLICY_OFF, setSyncPause } from '../ledger/settings';
import { getTask, getVendorLink, insertVendorLink } from '../ledger/tasks';
import { CLOSED_PHASES, NO_VENDOR, SYNC_SOURCE, TaskRow, VendorLinkRow, WorkspaceRow, formatTaskId } from '../ledger/types';
import { getWorkspace } from '../ledger/workspaces';
import { appendLog, SYNC_LOG_FILE } from '../hook/log';
import { acquireLease } from './lease';
import { DEFER_MS, claimNext, completeRow, deferRow, failRow, releaseRow, retryRow } from './outbox';
import { applyRemoteItem, markLinkBroken, recordOwnPush } from './reconcile';
import { redactSecrets } from './redact';
import { DesiredState, GoneError, PermanentError, SyncPausedError, VendorAdapter, linkStateOf } from './vendor';

export interface PushDeps {
    holder: string;
    now(): number;
    adapterFor(workspace: WorkspaceRow): VendorAdapter;
}

export interface PushSummary {
    pushed: number;
    skipped: number;
    deferred: number;
    retried: number;
    failed: number;
    broken: number;
    redacted: number;
    /** `<workspace path>: <reason>` for each workspace paused during this run. */
    paused: string[];
}

export const emptyPushSummary = (): PushSummary =>
    ({ pushed: 0, skipped: 0, deferred: 0, retried: 0, failed: 0, broken: 0, redacted: 0, paused: [] });

const NOT_SYNCABLE = 'The task or its workspace no longer syncs.';
const NO_VENDOR_ITEM = 'The task has no vendor item and none is being created.';

/** The lease ran out or another runner took it: stop at once, writing nothing (§8.1: one sync runner). */
class LeaseLostError extends Error {}
/** Another runner owns the row now: this runner records nothing for it and never retries it. */
class ClaimLostError extends Error {}

type Outcome = 'pushed' | 'skipped' | 'deferred' | 'no_item';

interface PushContext {
    db: Ledger;
    deps: PushDeps;
    adapter: VendorAdapter;
    row: OutboxRow;
    task: TaskRow;
    workspace: WorkspaceRow;
    summary: PushSummary;
}

const defaultBody = (task: TaskRow): string => `Tracked by GhostPM as ${formatTaskId(task.id)}.`;

/** Post-claim writes answer false once the row is another holder's. */
function held(landed: boolean): void {
    if (!landed) throw new ClaimLostError();
}

/** The adapter, after renewing the lease: each vendor call starts with a full TTL ahead of it, longer than the call's timeout. */
function leased(ctx: PushContext): VendorAdapter {
    if (!acquireLease(ctx.db, ctx.deps.holder, ctx.deps.now())) throw new LeaseLostError();
    return ctx.adapter;
}

/** Completes the row and records what the push changed, in one transaction: none of it lands once the claim is lost. */
function finish(ctx: PushContext, record: () => void): void {
    write(ctx.db, () => {
        held(completeRow(ctx.db, ctx.row.id, ctx.deps.holder));
        record();
    });
}

/** Spec §8.9: token-shaped text never leaves the machine. Logged by count, never by content. */
function scrub(ctx: PushContext, text: string): string {
    const result = redactSecrets(text);
    if (result.count > 0) {
        ctx.summary.redacted += result.count;
        appendLog(SYNC_LOG_FILE, `${formatTaskId(ctx.task.id)}: redacted ${result.count} secret(s) before pushing`);
    }
    return result.text;
}

const desiredOf = (ctx: PushContext, task: TaskRow): DesiredState => ({ title: scrub(ctx, task.title), phase: task.phase });

type LinkCheck = { link: VendorLinkRow } | { outcome: Outcome };

/** Rows after `create` need the vendor item; while its create is on the way they wait. */
function requireLink(ctx: PushContext): LinkCheck {
    const link = getVendorLink(ctx.db, ctx.task.id);
    if (link !== undefined) return link.broken_at === null ? { link } : { outcome: 'skipped' };
    return { outcome: hasActiveCreate(ctx.db, ctx.task.id) ? 'deferred' : 'no_item' };
}

async function pushCreate(ctx: PushContext): Promise<Outcome> {
    // Never create twice, nor for work already done or dropped (plan Ruling 87): a re-armed create can outlive its task's phase.
    if (getVendorLink(ctx.db, ctx.task.id) !== undefined || CLOSED_PHASES.has(ctx.task.phase)) return 'skipped';
    const desired = desiredOf(ctx, ctx.task);
    const body = scrub(ctx, ctx.task.body !== null && ctx.task.body.trim().length > 0 ? ctx.task.body : defaultBody(ctx.task));
    const item = await leased(ctx).create(desired, body);
    // An adapter whose follow-up read or state move failed answers with the item as first created:
    // it is linked all the same, and a sync_state moves it the rest of the way.
    const landed = ctx.adapter.phaseOf(item.state, item.labels, desired.phase) === desired.phase;
    finish(ctx, () => {
        insertVendorLink(ctx.db, {
            taskId: ctx.task.id, vendor: ctx.workspace.vendor, remoteId: item.remoteId, remoteUrl: item.url,
            remoteState: item.state, labels: JSON.stringify(item.labels), remoteUpdatedAt: item.updatedAt,
            remoteTitle: desired.title, lastPushedRev: landed ? ctx.task.rev : null,
        });
        recordEvent(ctx.db, {
            taskId: ctx.task.id, kind: 'linked', source: SYNC_SOURCE,
            payload: { vendor: ctx.workspace.vendor, remoteId: item.remoteId, url: item.url },
        });
        if (!landed) projectTask(ctx.db, getTask(ctx.db, ctx.task.id)!, 'change', nowIso());
    });
    return 'pushed';
}

async function pushSyncState(ctx: PushContext): Promise<Outcome> {
    const check = requireLink(ctx);
    if ('outcome' in check) return check.outcome;
    if (check.link.last_pushed_rev === ctx.task.rev) return 'skipped';
    // Ruling: read the vendor first, so an edit a person made there since our last push is
    // applied here rather than overwritten by this push (spec §8.6).
    const current = await leased(ctx).fetch(check.link.remote_id);
    if (current === null) throw new GoneError(`${formatTaskId(ctx.task.id)}: vendor item ${check.link.remote_id} is gone`);
    // Renewed before the merge is written; nothing awaits between it and the push, so it covers both.
    const adapter = leased(ctx);
    const merged = write(ctx.db, () => {
        // Re-read: another session may have changed the task while the fetch was out.
        applyRemoteItem(ctx.db, adapter, getTask(ctx.db, ctx.task.id)!, check.link, current);
        return getTask(ctx.db, ctx.task.id)!;
    });
    const desired = desiredOf(ctx, merged);
    const item = await adapter.syncState(linkStateOf(current), desired);
    finish(ctx, () => recordOwnPush(ctx.db, check.link, item, desired.title, merged.rev));
    return 'pushed';
}

async function pushComment(ctx: PushContext): Promise<Outcome> {
    const check = requireLink(ctx);
    if ('outcome' in check) return check.outcome;
    const payload = JSON.parse(ctx.row.payload ?? '{}') as CommentPayload;
    const item = await leased(ctx).comment(check.link.remote_id, scrub(ctx, payload.text));
    finish(ctx, () => {
        // null: posted but not re-read, so there is no baseline to take. Otherwise our comment changes
        // nothing that is compared, so anything else that moved is a person's.
        if (item !== null) applyRemoteItem(ctx.db, ctx.adapter, getTask(ctx.db, ctx.task.id)!, check.link, item);
    });
    return 'pushed';
}

async function pushCloseDuplicate(ctx: PushContext): Promise<Outcome> {
    const check = requireLink(ctx);
    if ('outcome' in check) return check.outcome;
    const payload = JSON.parse(ctx.row.payload ?? '{}') as CloseDuplicatePayload;
    const item = await leased(ctx).closeDuplicate(check.link.remote_id, payload.of);
    finish(ctx, () => recordOwnPush(ctx.db, check.link, item, check.link.remote_title ?? item.title, null));
    return 'pushed';
}

const PUSHERS: Record<OutboxOp, (ctx: PushContext) => Promise<Outcome>> = {
    create: pushCreate,
    sync_state: pushSyncState,
    comment: pushComment,
    close_duplicate: pushCloseDuplicate,
};

function onFailure(db: Ledger, deps: PushDeps, row: OutboxRow, workspace: WorkspaceRow, error: unknown, summary: PushSummary): void {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(SYNC_LOG_FILE, `${formatTaskId(row.task_id)} ${row.op}: ${message}`);
    if (error instanceof SyncPausedError) {
        // Spec §8.8: the whole workspace waits for a person; this row keeps its attempts.
        write(db, () => {
            setSyncPause(db, workspace.id, error.reason);
            held(releaseRow(db, row, deps.holder));
        });
        const entry = `${workspace.path}: ${error.reason}`;
        if (summary.paused.indexOf(entry) < 0) summary.paused.push(entry);
        return;
    }
    if (error instanceof GoneError) {
        write(db, () => {
            held(completeRow(db, row.id, deps.holder));
            const link = getVendorLink(db, row.task_id);
            if (link !== undefined) markLinkBroken(db, link, message, nowIso());
        });
        summary.broken++;
        return;
    }
    if (error instanceof PermanentError) {
        held(failRow(db, row.id, deps.holder, message));
        summary.failed++;
        return;
    }
    const status = retryRow(db, row, deps.holder, message, readSetting(db, null, SETTING_MAX_PUSH_ATTEMPTS), deps.now());
    if (status === null) throw new ClaimLostError();
    if (status === STATUS_FAILED) summary.failed++;
    else summary.retried++;
}

async function pushRow(db: Ledger, deps: PushDeps, row: OutboxRow, summary: PushSummary): Promise<void> {
    const task = getTask(db, row.task_id);
    const workspace = task !== undefined && task.workspace_id !== null ? getWorkspace(db, task.workspace_id) : undefined;
    if (task === undefined || workspace === undefined || workspace.vendor === NO_VENDOR) {
        held(failRow(db, row.id, deps.holder, NOT_SYNCABLE));
        summary.failed++;
        return;
    }
    // Ruling: a row queued before its workspace was switched off is done with. Released, it would be claimed again at once.
    if (readSetting(db, workspace.id, SETTING_SYNC_POLICY) === SYNC_POLICY_OFF) {
        held(completeRow(db, row.id, deps.holder));
        summary.skipped++;
        return;
    }
    let outcome: Outcome;
    try {
        outcome = await PUSHERS[row.op]({ db, deps, adapter: deps.adapterFor(workspace), row, task, workspace, summary });
    } catch (error) {
        if (error instanceof LeaseLostError || error instanceof ClaimLostError) throw error;
        onFailure(db, deps, row, workspace, error, summary);
        return;
    }
    if (outcome === 'pushed') {
        summary.pushed++;
    } else if (outcome === 'skipped') {
        held(completeRow(db, row.id, deps.holder));
        summary.skipped++;
    } else if (outcome === 'deferred') {
        held(deferRow(db, row, deps.holder, deps.now() + DEFER_MS));
        summary.deferred++;
    } else {
        held(failRow(db, row.id, deps.holder, NO_VENDOR_ITEM));
        summary.failed++;
    }
}

/**
 * Pushes every due row, one at a time, renewing the lease before each claim and each vendor
 * call, and stopping once it is lost. Never holds a transaction across a vendor call (spec §5).
 */
export async function pushDue(db: Ledger, deps: PushDeps, summary: PushSummary = emptyPushSummary()): Promise<PushSummary> {
    while (acquireLease(db, deps.holder, deps.now())) {
        const row = claimNext(db, deps.holder, deps.now());
        if (row === undefined) break;
        try {
            await pushRow(db, deps, row, summary);
        } catch (error) {
            if (error instanceof LeaseLostError) {
                appendLog(SYNC_LOG_FILE, `${formatTaskId(row.task_id)} ${row.op}: the sync lease is gone; stopped before the vendor call`);
                break;
            }
            if (!(error instanceof ClaimLostError)) throw error;
            appendLog(SYNC_LOG_FILE, `${formatTaskId(row.task_id)} ${row.op}: another sync runner holds this row now; left to it`);
        }
    }
    return summary;
}
