import { randomBytes } from 'crypto';
import { Runner } from '../cli';
import { Ledger, nowIso, write } from '../ledger/db';
import { recordEvent } from '../ledger/events';
import {
    AttemptPayload, CloseDuplicatePayload, CommentPayload, OP_CLOSE_DUPLICATE, OP_COMMENT, OP_CREATE, OP_SYNC_STATE, OutboxOp, OutboxRow, STATUS_FAILED,
    dropUnpushed, hasActiveCreate, projectTask,
} from '../ledger/projection';
import {
    readSetting, SETTING_MAX_PUSH_ATTEMPTS, SETTING_SYNC_POLICY, SYNC_POLICY_LINKED_ONLY, SYNC_POLICY_OFF, setSyncPause,
} from '../ledger/settings';
import { getTask, getVendorLink, insertVendorLink } from '../ledger/tasks';
import { CLOSED_PHASES, NO_VENDOR, SYNC_SOURCE, TaskRow, VendorLinkRow, WorkspaceRow, formatTaskId } from '../ledger/types';
import { MERGED_PHASE } from '../ledger/work';
import { getWorkspace } from '../ledger/workspaces';
import { appendLog, SYNC_LOG_FILE } from '../hook/log';
import { acquireLease, holdLease, LeaseLostError } from './lease';
import {
    DEFER_MS, claimNext, completeRow, deferRow, failRow, holdsClaim, releaseOwnClaims, releaseRow, retryRow, setRowPayload,
} from './outbox';
import { applyRemoteItem, clearIntent, markLinkBroken, recordIntent, recordOwnPush } from './reconcile';
import { redactSecrets } from './redact';
import {
    DesiredState, GoneError, MARKER_NONCE_BYTES, PermanentError, RemoteItem, SyncPausedError, VendorAdapter, idempotencyMarker, linkStateOf,
} from './vendor';

/** Wraps the runner an adapter makes its CLI calls through, so every single call is checked first. */
export type RunGuard = (run: Runner) => Runner;

export interface PushDeps {
    holder: string;
    now(): number;
    /** Build the adapter on `guard(<its runner>)`: each CLI call then renews the lease and checks the claim before it spawns. */
    adapterFor(workspace: WorkspaceRow, guard: RunGuard): VendorAdapter;
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
const TRIED_BEFORE_OFF = 'Sync was switched off after this create was tried, and the item may exist. '
    + 'With sync on again, `ghostpm sync` looks for it before creating anything.';
const MARKER_SEPARATOR = '\n\n';
/** The ops that write a push intent before their vendor call. */
const RECORDS_INTENT: ReadonlySet<OutboxOp> = new Set<OutboxOp>([OP_SYNC_STATE, OP_CLOSE_DUPLICATE]);

/** Another runner owns the row now: this runner records nothing for it and never retries it. */
class ClaimLostError extends Error {}

/** `pushed` and `ended`: the pusher completed the row itself (`ended`: with nothing pushed). */
type Outcome = 'pushed' | 'skipped' | 'ended' | 'deferred' | 'no_item';

interface Claim {
    db: Ledger;
    deps: PushDeps;
    row: OutboxRow;
}

interface PushContext extends Claim {
    adapter: VendorAdapter;
    task: TaskRow;
    workspace: WorkspaceRow;
    summary: PushSummary;
}

const defaultBody = (task: TaskRow): string => `Tracked by GhostPM as ${formatTaskId(task.id)}.`;
/** What an earlier attempt at a create or comment row recorded; a row never tried carries no nonce. */
const attemptOf = (row: OutboxRow): AttemptPayload => JSON.parse(row.payload ?? '{}') as AttemptPayload;
const withMarker = (text: string, nonce: string): string => `${text}${MARKER_SEPARATOR}${idempotencyMarker(nonce)}`;
const newNonce = (): string => randomBytes(MARKER_NONCE_BYTES).toString('hex');

/** Post-claim writes answer false once the row is another holder's. */
function held(landed: boolean): void {
    if (!landed) throw new ClaimLostError();
}

/** Before every vendor call: renew the lease (each call then starts with a full TTL, longer than its timeout) and make sure the row is still ours. */
function guard(claim: Claim): void {
    holdLease(claim.db, claim.deps.holder, claim.deps.now());
    held(holdsClaim(claim.db, claim.row.id, claim.deps.holder));
}

/** Runs `check` before each CLI call the adapter makes through the wrapped runner. */
export const guardWith = (check: () => void): RunGuard => run => async (command, args, options) => {
    check();
    return run(command, args, options);
};

const guarded = (claim: Claim): RunGuard => guardWith(() => guard(claim));

/** The adapter, once guarded: covers adapters with no CLI runner of their own. */
function leased(ctx: PushContext): VendorAdapter {
    guard(ctx);
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

/**
 * Rows after `create` need the vendor item; while its create is on the way they wait. With none coming, a desired
 * state has nothing to apply to and is done with (ruling F1), while a comment's text would be lost: it fails.
 */
function requireLink(ctx: PushContext): LinkCheck {
    const link = getVendorLink(ctx.db, ctx.task.id);
    if (link !== undefined) return link.broken_at === null ? { link } : { outcome: 'skipped' };
    if (hasActiveCreate(ctx.db, ctx.task.id)) return { outcome: 'deferred' };
    return { outcome: ctx.row.op === OP_COMMENT ? 'no_item' : 'skipped' };
}

/**
 * Plan Ruling 87: nothing is created for work already done or dropped (a re-armed create can outlive its task's
 * phase), and spec §8.2: nothing in a linked-only workspace (ruling F4: one switched there after the create was tried).
 */
const createsNothing = (db: Ledger, task: TaskRow, workspace: WorkspaceRow): boolean =>
    CLOSED_PHASES.has(task.phase) || readSetting(db, workspace.id, SETTING_SYNC_POLICY) === SYNC_POLICY_LINKED_ONLY;

async function pushCreate(ctx: PushContext): Promise<Outcome> {
    if (getVendorLink(ctx.db, ctx.task.id) !== undefined) return 'skipped';   // never create twice
    const earlier = attemptOf(ctx.row);
    // An attempt that may have landed is still looked for, so its item is linked (and closed, for a closed task), not orphaned.
    const lookOnly = createsNothing(ctx.db, ctx.task, ctx.workspace);
    if (lookOnly && earlier.nonce === undefined) return 'skipped';
    const desired = desiredOf(ctx, ctx.task);
    let sent = earlier.title ?? desired.title;
    // An earlier attempt may have created the item and failed after it: adopt that one rather than make a second.
    let item: RemoteItem | null = earlier.nonce === undefined ? null : await leased(ctx).findCreated(idempotencyMarker(earlier.nonce), sent);
    if (item === null && lookOnly) {
        // Nothing landed. The task may have reopened while the lookup was out: read it again and complete this row in
        // the same write, since a reopen between the two would find this create still in flight and queue nothing.
        finish(ctx, () => {
            const task = getTask(ctx.db, ctx.task.id)!;
            // Still nothing to create: its comments can never reach the vendor either.
            if (createsNothing(ctx.db, task, ctx.workspace)) dropUnpushed(ctx.db, task.id);
            // Reopened, or sync switched since: this create is stale. The projection decides, by policy, what the task
            // needs now (a fresh create its waiting comments and state then follow).
            else projectTask(ctx.db, task, 'change', nowIso());
        });
        return 'ended';
    }
    if (item === null) {
        const nonce = earlier.nonce ?? newNonce();
        sent = desired.title;
        const attempt: AttemptPayload = { nonce, title: sent };
        held(setRowPayload(ctx.db, ctx.row.id, ctx.deps.holder, attempt));
        const body = scrub(ctx, ctx.task.body !== null && ctx.task.body.trim().length > 0 ? ctx.task.body : defaultBody(ctx.task));
        item = await leased(ctx).create(desired, withMarker(body, nonce));
    }
    const created = item;
    // An adapter whose follow-up read or state move failed answers with the item as first created, and an adopted
    // item shows what its own attempt sent: either is linked all the same, and a sync_state moves it the rest of the way.
    const landed = sent === desired.title && ctx.adapter.phaseOf(created.state, created.labels, desired.phase) === desired.phase;
    finish(ctx, () => {
        insertVendorLink(ctx.db, {
            taskId: ctx.task.id, vendor: ctx.workspace.vendor, remoteId: created.remoteId, remoteUrl: created.url,
            remoteState: created.state, labels: JSON.stringify(created.labels), remoteUpdatedAt: created.updatedAt,
            remoteTitle: sent, lastPushedRev: landed ? ctx.task.rev : null,
        });
        recordEvent(ctx.db, {
            taskId: ctx.task.id, kind: 'linked', source: SYNC_SOURCE,
            payload: { vendor: ctx.workspace.vendor, remoteId: created.remoteId, url: created.url },
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
    // Guarded before the merge is written; nothing awaits between it and the push, so it covers both.
    const adapter = leased(ctx);
    const merged = write(ctx.db, () => {
        held(holdsClaim(ctx.db, ctx.row.id, ctx.deps.holder));
        // Re-read: another session, or another runner, may have changed the task or its link while the fetch was out.
        const link = getVendorLink(ctx.db, ctx.task.id);
        if (link === undefined || link.remote_id !== check.link.remote_id) return null;
        applyRemoteItem(ctx.db, adapter, getTask(ctx.db, ctx.task.id)!, link, current);
        return { link, task: getTask(ctx.db, ctx.task.id)! };
    });
    if (merged === null) return 'skipped';
    // Redaction runs on local text outside any transaction: the write lock is never held across text work.
    const desired = desiredOf(ctx, merged.task);
    // Write-ahead: if the push lands but its answer is lost, the next read knows the result as ours.
    write(ctx.db, () => {
        held(holdsClaim(ctx.db, ctx.row.id, ctx.deps.holder));
        recordIntent(ctx.db, merged.link, desired, merged.task.rev);
    });
    const item = await adapter.syncState(linkStateOf(current), desired);
    finish(ctx, () => recordOwnPush(ctx.db, merged.link, item, desired.title, merged.task.rev));
    return 'pushed';
}

async function pushComment(ctx: PushContext): Promise<Outcome> {
    const check = requireLink(ctx);
    if ('outcome' in check) return check.outcome;
    const payload = JSON.parse(ctx.row.payload ?? '{}') as CommentPayload & AttemptPayload;
    // An earlier attempt may have posted it and failed after: never post it twice.
    const posted = payload.nonce !== undefined
        && await leased(ctx).hasComment(check.link.remote_id, idempotencyMarker(payload.nonce));
    let item: RemoteItem | null = null;
    if (!posted) {
        const nonce = payload.nonce ?? newNonce();
        if (payload.nonce === undefined) held(setRowPayload(ctx.db, ctx.row.id, ctx.deps.holder, { ...payload, nonce }));
        item = await leased(ctx).comment(check.link.remote_id, withMarker(scrub(ctx, payload.text), nonce));
    }
    const answer = item;
    finish(ctx, () => {
        // null: posted but not re-read, so there is no baseline to take. Otherwise our comment changes
        // nothing that is compared, so anything else that moved is a person's.
        const link = getVendorLink(ctx.db, ctx.task.id);
        if (answer !== null && link !== undefined) applyRemoteItem(ctx.db, ctx.adapter, getTask(ctx.db, ctx.task.id)!, link, answer);
    });
    return 'pushed';
}

async function pushCloseDuplicate(ctx: PushContext): Promise<Outcome> {
    const check = requireLink(ctx);
    if ('outcome' in check) return check.outcome;
    const payload = JSON.parse(ctx.row.payload ?? '{}') as CloseDuplicatePayload;
    const title = check.link.remote_title ?? ctx.task.title;
    const adapter = leased(ctx);
    write(ctx.db, () => recordIntent(ctx.db, check.link, { title, phase: MERGED_PHASE }, null));
    const item = await adapter.closeDuplicate(check.link.remote_id, payload.of);
    finish(ctx, () => recordOwnPush(ctx.db, check.link, item, title, null));
    return 'pushed';
}

const PUSHERS: Record<OutboxOp, (ctx: PushContext) => Promise<Outcome>> = {
    create: pushCreate,
    sync_state: pushSyncState,
    comment: pushComment,
    close_duplicate: pushCloseDuplicate,
};

/** A row that ends without landing leaves no intent behind: a person's later edit to the same state is theirs. */
function endIntent(db: Ledger, row: OutboxRow): void {
    if (RECORDS_INTENT.has(row.op)) clearIntent(db, row.task_id);
}

/** Done with, nothing pushed (off, linked-only, closed, nothing left to push). */
function completeSkipped(db: Ledger, deps: PushDeps, row: OutboxRow): void {
    write(db, () => {
        held(completeRow(db, row.id, deps.holder));
        endIntent(db, row);
    });
}

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
        write(db, () => {
            held(failRow(db, row.id, deps.holder, message));
            endIntent(db, row);
        });
        summary.failed++;
        return;
    }
    const status = write(db, () => {
        const next = retryRow(db, row, deps.holder, message, readSetting(db, null, SETTING_MAX_PUSH_ATTEMPTS), deps.now());
        if (next === STATUS_FAILED) endIntent(db, row);
        return next;
    });
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
    // Rulings: rows queued before the workspace was switched off, and creates never tried before it went linked-only
    // (which never creates, spec §8.2), are done with. Released, they would be claimed again at once. A create that was
    // tried may have landed (ruling F4): skipped, its item would be orphaned and duplicated once sync is back. Under off
    // it fails, for a person's `ghostpm sync` to look for once sync is on again; under linked-only pushCreate looks now.
    const policy = readSetting(db, workspace.id, SETTING_SYNC_POLICY);
    const triedCreate = row.op === OP_CREATE && attemptOf(row).nonce !== undefined;
    if (policy === SYNC_POLICY_OFF && triedCreate) {
        held(failRow(db, row.id, deps.holder, TRIED_BEFORE_OFF));
        summary.failed++;
        return;
    }
    if (policy === SYNC_POLICY_OFF || (policy === SYNC_POLICY_LINKED_ONLY && row.op === OP_CREATE && !triedCreate)) {
        completeSkipped(db, deps, row);
        summary.skipped++;
        return;
    }
    const claim: Claim = { db, deps, row };
    let outcome: Outcome;
    try {
        outcome = await PUSHERS[row.op]({ ...claim, adapter: deps.adapterFor(workspace, guarded(claim)), task, workspace, summary });
    } catch (error) {
        if (error instanceof LeaseLostError || error instanceof ClaimLostError) throw error;
        onFailure(db, deps, row, workspace, error, summary);
        return;
    }
    if (outcome === 'pushed') {
        summary.pushed++;
    } else if (outcome === 'skipped') {
        completeSkipped(db, deps, row);
        summary.skipped++;
    } else if (outcome === 'ended') {
        summary.skipped++;   // the pusher completed it without pushing
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
    const handled = new Set<number>();
    // Ruling F3: what an earlier run of this holder left claimed (its bookkeeping write failed) is pushed again.
    releaseOwnClaims(db, deps.holder);
    while (acquireLease(db, deps.holder, deps.now())) {
        const row = claimNext(db, deps.holder, deps.now());
        if (row === undefined) break;
        if (handled.has(row.id)) {
            // Due again within this run: it waits for the next run instead of looping here.
            releaseRow(db, row, deps.holder);
            break;
        }
        handled.add(row.id);
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
