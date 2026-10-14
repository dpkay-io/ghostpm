import { Ledger, ledgerPath, openLedger, write } from '../ledger/db';
import {
    getSyncPause, readSetting, setSyncPause, SETTING_ADO_WORK_ITEM_TYPE, SETTING_PHASE_STATE_MAP,
} from '../ledger/settings';
import { NO_VENDOR, WorkspaceRow, plural } from '../ledger/types';
import { findWorkspace, isStillRegistered } from '../ledger/workspaces';
import { appendLog, SYNC_LOG_FILE } from '../hook/log';
import { Runner, runCli, sweepArgDirs } from '../cli';
import { AzureAdapter } from './azure';
import { GitHubAdapter } from './github';
import { identityOf } from './identity';
import { acquireLease, leaseHolder, leaseHolderId, releaseLease } from './lease';
import { hasDueWork, outboxHealth, rearmFailed, releaseStaleClaims } from './outbox';
import { PullSummary, pullWorkspace } from './pull';
import { PushDeps, PushSummary, pushDue } from './push';
import { BACKGROUND_FLAG, pullIsDue, SYNC_COMMAND, syncIsOff, syncOffHint } from './schedule';
import { SyncPausedError, VENDOR_CALL_TIMEOUT_MS, VendorAdapter } from './vendor';

/** Spec §8.1: the lease holder polls the outbox every ~2 s. */
export const PUSH_POLL_MS = 2 * 1000;
const MS_PER_SECOND = 1000;

export function unusableRemote(workspace: WorkspaceRow): string {
    return `GhostPM cannot tell which ${workspace.vendor === 'github' ? 'GitHub repository' : 'Azure DevOps project'} `
        + `${workspace.path} belongs to from its git remote (${workspace.git_remote ?? 'none'}). `
        + 'It syncs github.com, dev.azure.com and *.visualstudio.com remotes. Fix the remote, then run `ghostpm sync`.';
}

/** The adapter for a workspace, from its remote and settings. A remote it cannot read pauses the workspace. */
export function adapterFor(db: Ledger, workspace: WorkspaceRow, run: Runner = runCli): VendorAdapter {
    const identity = identityOf(workspace);
    if (identity === null) throw new SyncPausedError(unusableRemote(workspace));
    if (identity.vendor === 'github') return new GitHubAdapter(identity.repo, run);
    return new AzureAdapter(
        identity.org, identity.project,
        readSetting(db, workspace.id, SETTING_ADO_WORK_ITEM_TYPE), readSetting(db, workspace.id, SETTING_PHASE_STATE_MAP), run,
    );
}

/** The real CLIs, each call made through the push/pull guard (lease renewed, claim checked) before it spawns. */
export const defaultSyncDeps = (db: Ledger): PushDeps => ({
    holder: leaseHolderId(),
    now: () => Date.now(),
    adapterFor: (workspace, guard) => adapterFor(db, workspace, guard(runCli)),
});

export interface PullReport {
    workspace: WorkspaceRow;
    summary?: PullSummary;
    error?: string;
    /** For a pull that found the workspace must pause: whether the pause was written (only while the lease is held). */
    paused?: boolean;
}

/** Ruling 4: a workspace whose sync_policy is off is never pulled, resumed or re-armed, whoever runs the sync. */
function vendorWorkspaces(db: Ledger): WorkspaceRow[] {
    return (db.prepare('SELECT * FROM workspaces WHERE vendor <> ? ORDER BY id').all(NO_VENDOR) as WorkspaceRow[])
        .filter(workspace => !syncIsOff(db, workspace));
}

const describeError = (error: unknown): string => (error instanceof Error ? (error.stack ?? error.message) : String(error));

/**
 * Ruling M1: as a push pauses only while it holds its row, a pull pauses only while it holds the lease, and only a
 * workspace still registered (another folder may hold its id now). Whether it did.
 */
function pauseWhileHeld(db: Ledger, deps: PushDeps, workspace: WorkspaceRow, reason: string): boolean {
    return write(db, () => {
        if (!acquireLease(db, deps.holder, deps.now()) || !isStillRegistered(db, workspace)) return false;
        setSyncPause(db, workspace.id, reason);
        return true;
    });
}

/**
 * Pulls each vendor workspace that is due (or every one, when forced). A failure leaves that workspace's watermark
 * alone, and a pause is recorded as a push records it (spec §8.8). `attempts`, a runner's memory of when it last
 * tried each workspace, holds off the next try until `sync_pull_minutes` after it, failed or not (ruling I3).
 */
export async function pullWorkspaces(
    db: Ledger,
    deps: PushDeps,
    force: boolean,
    attempts: Map<number, number> = new Map<number, number>(),
): Promise<PullReport[]> {
    const reports: PullReport[] = [];
    for (const workspace of vendorWorkspaces(db)) {
        if (getSyncPause(db, workspace.id) !== undefined) continue;
        if (!force && !pullIsDue(db, workspace, deps.now(), attempts.get(workspace.id))) continue;
        // Checked before every pull (a write, so only when one is due): a lease lost during the last pull
        // (LeaseLostError) ends the run here, and another runner does the rest (§8.1).
        if (!acquireLease(db, deps.holder, deps.now())) break;
        attempts.set(workspace.id, deps.now());
        try {
            const summary = await pullWorkspace(db, workspace, deps);
            // Ruling F10: the rest of a full page that moved the watermark is read on the next pass, not a schedule later.
            if (summary.more) attempts.delete(workspace.id);
            reports.push({ workspace, summary });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            appendLog(SYNC_LOG_FILE, `pull ${workspace.path}: ${message}`);
            if (error instanceof SyncPausedError) reports.push({ workspace, error: message, paused: pauseWhileHeld(db, deps, workspace, error.reason) });
            else reports.push({ workspace, error: message });
        }
    }
    return reports;
}

export interface SyncReport {
    push: PushSummary;
    pulls: PullReport[];
    /** Another runner held the lease by the end of the pass: it carries on from where this one stopped. */
    leaseLost: boolean;
}

/** One pass as the lease holder: push, pull, push what the pull moved (a merged PR's close). */
export async function syncOnce(db: Ledger, deps: PushDeps, forcePull: boolean): Promise<SyncReport | { heldBy: string }> {
    const now = deps.now();
    if (!acquireLease(db, deps.holder, now)) return { heldBy: leaseHolder(db, now)?.holder ?? 'another process' };
    try {
        releaseStaleClaims(db, now);
        const push = await pushDue(db, deps);
        const pulls = await pullWorkspaces(db, deps, forcePull);
        await pushDue(db, deps, push);
        return { push, pulls, leaseLost: leaseHolder(db, deps.now())?.holder !== deps.holder };
    } finally {
        releaseLease(db, deps.holder);
    }
}

export interface SyncRunner {
    tick(): Promise<void>;
    stop(): void;
}

/** Every MCP server runs one; only the lease holder works (spec §8.1). Errors are logged, never thrown. */
export function startSyncRunner(db: Ledger, deps: PushDeps, pollMs: number = PUSH_POLL_MS): SyncRunner {
    let busy = false;
    let holding = false;
    const attempts = new Map<number, number>();
    const tick = async (): Promise<void> => {
        if (busy) return;
        busy = true;
        try {
            // Ruling M4: with no workspace syncing and nothing due (the shipped default), a tick only reads.
            if (vendorWorkspaces(db).length === 0 && !hasDueWork(db, deps.now())) {
                holding = false;
                return;
            }
            if (!acquireLease(db, deps.holder, deps.now())) {
                holding = false;
                return;
            }
            // A new holder gives back what a dead one left claimed (spec §6).
            if (!holding) releaseStaleClaims(db, deps.now());
            holding = true;
            await pushDue(db, deps);
            await pullWorkspaces(db, deps, false, attempts);
        } catch (error) {
            appendLog(SYNC_LOG_FILE, `runner: ${describeError(error)}`);
        } finally {
            busy = false;
        }
    };
    const timer = setInterval(() => { void tick(); }, pollMs);
    timer.unref();
    return {
        tick,
        stop: () => {
            clearInterval(timer);
            releaseLease(db, deps.holder);
        },
    };
}

const isBackground = (argv: readonly string[]): boolean => argv.indexOf(BACKGROUND_FLAG) >= 0;
const LEASE_LOST_NOTE = 'Stopped part way: another sync runner took the lease and carries on from there.';
/** Where no workspace of its own is known: the folder a person names. */
const ANY_REPO = '<repo folder>';

function clearPauses(db: Ledger, workspaces: readonly WorkspaceRow[]): number {
    let resumed = 0;
    for (const workspace of workspaces) {
        if (getSyncPause(db, workspace.id) === undefined) continue;
        setSyncPause(db, workspace.id, undefined);
        resumed++;
    }
    return resumed;
}

function describePush(push: PushSummary): string[] {
    const lines = [`Pushed ${push.pushed}, skipped ${push.skipped}, waiting ${push.deferred}, retrying ${push.retried}, failed ${push.failed}, gone ${push.broken}.`];
    if (push.redacted > 0) lines.push(`Redacted ${plural(push.redacted, 'secret')} before pushing (see ${SYNC_LOG_FILE} in the ghostpm home).`);
    for (const entry of push.paused) lines.push(`Paused ${entry}`);
    return lines;
}

function describePull(report: PullReport): string {
    // The same line a push prints for a pause (ruling M1).
    if (report.paused === true) return `Paused ${report.workspace.path}: ${report.error}`;
    if (report.summary === undefined) return `${report.workspace.path}: pull failed: ${report.error}`;
    const s = report.summary;
    return `${report.workspace.path}: ${s.fetched} changed on the vendor, ${s.created} new, ${plural(s.humanEdits, 'edit')} applied, `
        + `${s.merged} merged, ${s.broken} gone.`;
}

export interface SyncCommandResult {
    output: string;
    /** Something is left for a person to act on (ruling I2): `ghostpm sync` then exits non-zero. */
    failed: boolean;
}

/**
 * Ruling F2: when the workspace `ghostpm sync` runs in is off, or no workspace syncs at all, how to turn sync on
 * (the wording get_project_state uses).
 */
function syncOffLine(db: Ledger, cwd: string, syncing: readonly WorkspaceRow[]): string | undefined {
    const here = findWorkspace(db, cwd);
    if (here !== undefined && here.vendor !== NO_VENDOR && syncIsOff(db, here)) return `Sync is off for ${here.path} (${syncOffHint(here.path)}).`;
    return syncing.length === 0 ? `No workspace syncs (${syncOffHint(ANY_REPO)}).` : undefined;
}

/**
 * `ghostpm sync`, run in `cwd`. Run by a person it first resumes paused workspaces and re-arms failed pushes, of the
 * workspaces that sync only (spec §8.8, ruling I1); `--background` (SessionStart's spawn) does neither and pulls only
 * what is due. Another runner holding the lease is not a failure: it does the work.
 */
export async function runSyncCommand(
    db: Ledger,
    argv: string[],
    deps: PushDeps = defaultSyncDeps(db),
    cwd: string = process.cwd(),
): Promise<SyncCommandResult> {
    const background = isBackground(argv);
    const syncing = vendorWorkspaces(db);
    const lines: string[] = [];
    // Nobody reads a background run's output.
    const offLine = background ? undefined : syncOffLine(db, cwd, syncing);
    const answer = (failed: boolean): SyncCommandResult => ({ output: lines.concat(offLine ?? []).join('\n'), failed });
    if (!background) {
        const resumed = clearPauses(db, syncing);
        const rearmed = rearmFailed(db, deps.now(), syncing.map(workspace => workspace.id));
        if (resumed > 0) lines.push(`Resumed sync for ${plural(resumed, 'paused workspace')}.`);
        if (rearmed > 0) lines.push(`Retrying ${plural(rearmed, 'failed push', 'es')}.`);
    }
    const result = await syncOnce(db, deps, !background);
    if ('heldBy' in result) {
        lines.push(`Sync is already running in ${result.heldBy}; it pushes every ${PUSH_POLL_MS / MS_PER_SECOND} s and pulls on schedule.`);
        return answer(false);
    }
    lines.push(...describePush(result.push), ...result.pulls.map(describePull));
    // Ruling I2: name each workspace with pushes left failed, so a person knows where to look.
    const leftFailed = syncing
        .map(workspace => ({ workspace, failed: outboxHealth(db, workspace.id).failed }))
        .filter(entry => entry.failed > 0);
    for (const { workspace, failed } of leftFailed) {
        lines.push(`${workspace.path}: ${plural(failed, 'push', 'es')} failed (see ${SYNC_LOG_FILE} in the ghostpm home).`);
    }
    if (result.leaseLost) lines.push(LEASE_LOST_NOTE);
    return answer(leftFailed.length > 0 || result.leaseLost || result.push.paused.length > 0
        || result.pulls.some(pull => pull.error !== undefined));
}

/** A vendor call is killed at VENDOR_CALL_TIMEOUT_MS: an argument folder twice that old belongs to no call still running. */
const STALE_ARG_DIR_MS = 2 * VENDOR_CALL_TIMEOUT_MS;

/** Ruling F11: at the start of every runner and every `ghostpm sync`, the argument folders vendor calls left behind go. */
export const sweepStaleArgDirs = (): Promise<number> => sweepArgDirs(STALE_ARG_DIR_MS);

/**
 * `ghostpm sync` as the command line runs it. `--background` is SessionStart's spawn, whose output nobody reads:
 * what goes wrong there is logged to sync.log instead of thrown (ruling M8).
 */
export async function syncCommandMain(
    argv: string[],
    openDb: () => Ledger = () => openLedger(ledgerPath()),
    depsFor: (db: Ledger) => PushDeps = defaultSyncDeps,
): Promise<SyncCommandResult> {
    try {
        const db = openDb();
        try {
            return await runSyncCommand(db, argv, depsFor(db));
        } finally {
            db.close();
        }
    } catch (error) {
        if (!isBackground(argv)) throw error;
        appendLog(SYNC_LOG_FILE, `${SYNC_COMMAND} ${BACKGROUND_FLAG}: ${describeError(error)}`);
        return { output: '', failed: true };
    }
}
