import { Ledger } from '../ledger/db';
import {
    getSyncPause, readSetting, setSyncPause, SETTING_ADO_WORK_ITEM_TYPE, SETTING_PHASE_STATE_MAP,
} from '../ledger/settings';
import { NO_VENDOR, WorkspaceRow } from '../ledger/types';
import { appendLog, SYNC_LOG_FILE } from '../hook/log';
import { Runner, runCli } from '../cli';
import { AzureAdapter } from './azure';
import { GitHubAdapter } from './github';
import { identityOf } from './identity';
import { acquireLease, leaseHolder, leaseHolderId, releaseLease } from './lease';
import { rearmFailed, releaseStaleClaims } from './outbox';
import { PullSummary, pullWorkspace } from './pull';
import { PushDeps, PushSummary, pushDue } from './push';
import { BACKGROUND_FLAG, pullIsDue, syncIsOff } from './schedule';
import { SyncPausedError, VendorAdapter } from './vendor';

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
}

/** Ruling 4: a workspace whose sync_policy is off is never pulled or resumed, whoever runs the sync. */
function vendorWorkspaces(db: Ledger): WorkspaceRow[] {
    return (db.prepare('SELECT * FROM workspaces WHERE vendor <> ? ORDER BY id').all(NO_VENDOR) as WorkspaceRow[])
        .filter(workspace => !syncIsOff(db, workspace));
}

/**
 * Pulls each vendor workspace that is due (or every one, when forced). A failure leaves that workspace's watermark
 * alone, and a pause is recorded as a push records it (spec §8.8).
 */
export async function pullWorkspaces(db: Ledger, deps: PushDeps, force: boolean): Promise<PullReport[]> {
    const reports: PullReport[] = [];
    for (const workspace of vendorWorkspaces(db)) {
        if (getSyncPause(db, workspace.id) !== undefined) continue;
        if (!force && !pullIsDue(db, workspace, deps.now())) continue;
        // Checked before every pull (a write, so only when one is due): a lease lost during the last pull
        // (LeaseLostError) ends the run here, and another runner does the rest (§8.1).
        if (!acquireLease(db, deps.holder, deps.now())) break;
        try {
            reports.push({ workspace, summary: await pullWorkspace(db, workspace, deps) });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            appendLog(SYNC_LOG_FILE, `pull ${workspace.path}: ${message}`);
            if (error instanceof SyncPausedError) setSyncPause(db, workspace.id, error.reason);
            reports.push({ workspace, error: message });
        }
    }
    return reports;
}

export interface SyncReport {
    push: PushSummary;
    pulls: PullReport[];
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
        return { push, pulls };
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
    const tick = async (): Promise<void> => {
        if (busy) return;
        busy = true;
        try {
            if (!acquireLease(db, deps.holder, deps.now())) {
                holding = false;
                return;
            }
            // A new holder gives back what a dead one left claimed (spec §6).
            if (!holding) releaseStaleClaims(db, deps.now());
            holding = true;
            await pushDue(db, deps);
            await pullWorkspaces(db, deps, false);
        } catch (error) {
            appendLog(SYNC_LOG_FILE, `runner: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
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

const plural = (count: number, noun: string, suffix = 's'): string => `${count} ${noun}${count === 1 ? '' : suffix}`;

function clearPauses(db: Ledger): number {
    let resumed = 0;
    for (const workspace of vendorWorkspaces(db)) {
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
    if (report.summary === undefined) return `${report.workspace.path}: pull failed: ${report.error}`;
    const s = report.summary;
    return `${report.workspace.path}: ${s.fetched} changed on the vendor, ${s.created} new, ${plural(s.humanEdits, 'edit')} applied, `
        + `${s.merged} merged, ${s.broken} gone.`;
}

/**
 * `ghostpm sync`. Run by a person it first resumes paused workspaces and re-arms failed pushes
 * (spec §8.8); `--background` (SessionStart's spawn) does neither and pulls only what is due.
 */
export async function runSyncCommand(db: Ledger, argv: string[], deps: PushDeps = defaultSyncDeps(db)): Promise<string> {
    const background = argv.indexOf(BACKGROUND_FLAG) >= 0;
    const lines: string[] = [];
    if (!background) {
        const resumed = clearPauses(db);
        const rearmed = rearmFailed(db, deps.now());
        if (resumed > 0) lines.push(`Resumed sync for ${plural(resumed, 'paused workspace')}.`);
        if (rearmed > 0) lines.push(`Retrying ${plural(rearmed, 'failed push', 'es')}.`);
    }
    const result = await syncOnce(db, deps, !background);
    if ('heldBy' in result) {
        lines.push(`Sync is already running in ${result.heldBy}; it pushes every ${PUSH_POLL_MS / MS_PER_SECOND} s and pulls on schedule.`);
        return lines.join('\n');
    }
    return lines.concat(describePush(result.push), result.pulls.map(describePull)).join('\n');
}
