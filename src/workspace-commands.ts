import * as fs from 'fs';
import * as path from 'path';
import { FLAG_YES } from './cli-args';
import { findGitRoot } from './init';
import { Ledger, write } from './ledger/db';
import {
    LEGACY_CONFIG_FILE, forgetLegacyRoots, importLegacyWorkspace, phaseStateMapFrom, unforgetLegacyRoot,
} from './ledger/legacy-import';
import {
    DEFAULT_ADO_WORK_ITEM_TYPE, PROGRESS_COMMENTS_NONE, PROGRESS_COMMENTS_PHASE, PhaseStateMap, SETTING_ADO_WORK_ITEM_TYPE,
    SETTING_PHASE_STATE_MAP, SETTING_PROGRESS_COMMENTS, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO, SYNC_POLICY_LINKED_ONLY, SYNC_POLICY_OFF,
    SyncPolicy, getWorkspaceSetting, readSetting, setWorkspaceSetting,
} from './ledger/settings';
import {
    WorkspaceFootprint, deleteWorkspace, ensureWorkspace, findWorkspace, refreshWorkspaceRemote, workspaceAtPath,
} from './ledger/workspaces';
import { AZURE_DEVOPS, NO_VENDOR, PHASES, Phase, WorkspaceRow } from './ledger/types';
import { AzureAdapter, AzureProcess, phaseStateMapFromCategories } from './sync/azure';
import { AzureIdentity, MISSING_REMOTE, identityOf } from './sync/identity';
import { syncOffHint } from './sync/schedule';
import { quoteForShell } from './shell-quote';
import { unrecognisedRemote } from './surfaces/sync-health';
import { cleanText } from './surfaces/text';
import { SyncPausedError } from './sync/vendor';

/** How far back init samples work items to learn the process template's states and types. */
export const AZURE_SAMPLE_DAYS = 90;
/** How init names a sync_policy the workspace never had. */
const NOT_SET = 'not set';
/** What a person runs again once whatever stopped init is fixed. */
const INIT_COMMAND = 'ghostpm init';

export type SniffAzure = (identity: AzureIdentity) => Promise<AzureProcess>;

/** The real az, through the sync adapter's one WIQL path: free-text arguments and the vendor timeout. */
const sampleAzureProcess: SniffAzure = identity =>
    new AzureAdapter(identity.org, identity.project, DEFAULT_ADO_WORK_ITEM_TYPE, {}).sampleProcess(AZURE_SAMPLE_DAYS, INIT_COMMAND);

export interface InitResult {
    workspace: WorkspaceRow;
    imported: number;
    /** Settings init detected and stored. */
    applied: string[];
    /** Settings init detected but left alone, because a value was already there. */
    kept: string[];
    warnings: string[];
    /** The workspace's sync_policy after init, wherever it comes from. */
    syncPolicy: SyncPolicy;
    /** Set when init switched the workspace to auto: what the workspace had before (null: nothing). */
    optedIn: { from: SyncPolicy | null } | null;
    /** Its progress_comments after init: a 1.4.0 repo's import turns them off unless a person set them. */
    progressComments: string;
}

/** Imports the 1.4.0 database of the folder init runs in, if it has one. Answers how many tasks it imported. */
function importLegacyFolder(db: Ledger, cwd: string, warnings: string[]): number {
    // 1.4.0 kept its files at the git root of the folder it ran in: a linked worktree had its own.
    const root = findGitRoot(cwd) ?? path.resolve(cwd);
    // A root `ghostpm unregister` kept out of start-up imports: asking for init here asks for it back.
    unforgetLegacyRoot(db, root);
    if (!fs.existsSync(path.join(root, LEGACY_CONFIG_FILE))) return 0;
    try {
        // A repo outside the 1.4.0 registry and ~/.claude.json is never found by the start-up import.
        return importLegacyWorkspace(db, root).imported;
    } catch (error) {
        warnings.push(`Skipped the 1.4.0 import: ${(error as Error).message}`);
        return 0;
    }
}

/** What init learns from an Azure DevOps sample, in the order it reports them. */
const AZURE_SETTINGS = [SETTING_PHASE_STATE_MAP, SETTING_ADO_WORK_ITEM_TYPE];

/** One piece of advice for any az failure: az's own (worded for init by the adapter), or fix it and run init again. Quotes az: cleaned. */
function sampleFailure(project: string, error: unknown): string {
    if (error instanceof SyncPausedError) return cleanText(`Could not sample work items in ${project}. ${error.reason}`);
    return cleanText(`Could not sample work items in ${project} (${(error as Error).message}). Fix that, then run \`${INIT_COMMAND}\`.`);
}

/** The phases a saved phase_state_map has no state for (every phase when there is none). */
const unmappedPhases = (saved: PhaseStateMap | undefined): Phase[] => PHASES.filter(phase => saved?.[phase] === undefined);

/**
 * Fills phase_state_map and ado_work_item_type from a sample of the project. A value already there came from an
 * earlier init, the 1.4.0 import or a person and always stays; a saved map only gains the phases it leaves out (an
 * older init stored only the states it saw). When nothing is missing, az is not asked at all.
 */
async function detectAzureSettings(db: Ledger, sniff: SniffAzure, result: InitResult): Promise<void> {
    const savedMap = getWorkspaceSetting<PhaseStateMap>(db, result.workspace.id, SETTING_PHASE_STATE_MAP);
    const unmapped = unmappedPhases(savedMap);
    const missing = AZURE_SETTINGS.filter(key => (key === SETTING_PHASE_STATE_MAP
        ? unmapped.length > 0
        : getWorkspaceSetting(db, result.workspace.id, key) === undefined));
    result.kept.push(...AZURE_SETTINGS.filter(key => missing.indexOf(key) < 0));
    if (missing.length === 0) return;
    const identity = identityOf(result.workspace);
    if (identity === null || identity.vendor !== AZURE_DEVOPS) {
        result.warnings.push(`Could not read the Azure DevOps organization and project from the git remote (${cleanText(result.workspace.git_remote ?? MISSING_REMOTE)}).`);
        return;
    }
    // Decoded from the remote URL, and the states are the vendor's: both printed cleaned.
    const project = cleanText(identity.project);
    let sampled: AzureProcess;
    try {
        // A network call: no transaction is open here (spec §5).
        sampled = await sniff(identity);
    } catch (error) {
        result.warnings.push(sampleFailure(project, error));
        return;
    }

    const noneChanged = (key: string): string =>
        `No work items changed in the last ${AZURE_SAMPLE_DAYS} days in ${project} to learn ${key} from.`;
    const unrecognised = `None of the states sampled in ${project} (${cleanText(sampled.states.join(', '))}) reads as a GhostPM phase, `
        + `so ${SETTING_PHASE_STATE_MAP} was not set: run \`ghostpm config set ${SETTING_PHASE_STATE_MAP} <phase>=<State>... `
        + `--workspace ${quoteForShell(result.workspace.path)}\`.`;
    // The project's real states by category win; the sampled names fill any phase they leave out.
    const stateMap = { ...phaseStateMapFrom(sampled.states), ...phaseStateMapFromCategories(sampled.typeStates ?? [], sampled.states) };
    // Each setting: what the sample says, or why it says nothing.
    const learned: { [key: string]: [unknown, string] } = {
        [SETTING_PHASE_STATE_MAP]: [
            Object.keys(stateMap).length > 0 ? stateMap : undefined,
            sampled.states.length === 0 ? noneChanged(SETTING_PHASE_STATE_MAP) : unrecognised,
        ],
        [SETTING_ADO_WORK_ITEM_TYPE]: [sampled.workItemTypes[0], noneChanged(SETTING_ADO_WORK_ITEM_TYPE)],
    };
    for (const key of missing) {
        if (key === SETTING_PHASE_STATE_MAP && savedMap !== undefined) {
            fillSavedMap(db, result, savedMap, unmapped.filter(phase => stateMap[phase] !== undefined), stateMap);
            continue;
        }
        const [value, why] = learned[key];
        if (value === undefined) {
            result.warnings.push(why);
        } else {
            setWorkspaceSetting(db, result.workspace.id, key, value);
            result.applied.push(key);
        }
    }
}

/** Adds the detected state of each `added` phase to the saved map, whose own phases never change, and says which. */
function fillSavedMap(db: Ledger, result: InitResult, saved: PhaseStateMap, added: Phase[], detected: PhaseStateMap): void {
    if (added.length === 0) {
        result.kept.push(SETTING_PHASE_STATE_MAP);
        return;
    }
    const filled: PhaseStateMap = { ...saved };
    added.forEach(phase => { filled[phase] = detected[phase]; });
    setWorkspaceSetting(db, result.workspace.id, SETTING_PHASE_STATE_MAP, filled);
    // The states are the vendor's: printed cleaned.
    result.applied.push(`${SETTING_PHASE_STATE_MAP} (added ${added.map(phase => `${phase}=${cleanText(detected[phase]!)}`).join(', ')})`);
}

/**
 * Init is the explicit opt-in: no policy, or the linked-only stamp a 1.4.0 import leaves, becomes auto; anything else
 * a person chose (off, promote) stays. Runs before the 1.4.0 import, whose stamp only fills a gap (ruling P41).
 */
function optIn(db: Ledger, workspaceId: number): InitResult['optedIn'] {
    const before = getWorkspaceSetting<SyncPolicy>(db, workspaceId, SETTING_SYNC_POLICY);
    if (before !== undefined && before !== SYNC_POLICY_LINKED_ONLY) return null;
    setWorkspaceSetting(db, workspaceId, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);
    return { from: before ?? null };
}

export async function initWorkspace(db: Ledger, cwd: string, sniff: SniffAzure = sampleAzureProcess): Promise<InitResult> {
    const registered = ensureWorkspace(db, cwd);
    const optedIn = optIn(db, registered.id);
    const warnings: string[] = [];
    const imported = importLegacyFolder(db, cwd, warnings);
    // The git remote wins over the 1.4.0 config: it is what vendor calls will target.
    const workspace = refreshWorkspaceRemote(db, registered);
    const result: InitResult = {
        workspace, imported, applied: [], kept: [], warnings,
        syncPolicy: readSetting(db, workspace.id, SETTING_SYNC_POLICY),
        optedIn,
        progressComments: readSetting(db, workspace.id, SETTING_PROGRESS_COMMENTS),
    };
    if (workspace.vendor === AZURE_DEVOPS) await detectAzureSettings(db, sniff, result);
    return result;
}

/** `sync_policy was linked-only; now auto`. */
const switched = (optedIn: { from: SyncPolicy | null }, now: SyncPolicy): string =>
    `${SETTING_SYNC_POLICY} was ${optedIn.from ?? NOT_SET}; now ${now}`;

/** What sync does here now, and how to change it: worded with the same hint every surface uses. */
function syncLines(result: InitResult): string[] {
    const where = result.workspace.path;
    if (result.syncPolicy === SYNC_POLICY_OFF) return [`Sync:      ${SYNC_POLICY_OFF} (${syncOffHint(where)})`];
    // Only init reads the remote again, so after a fix it is init that picks it up.
    const unrecognised = unrecognisedRemote(result.workspace);
    if (unrecognised !== null) return [`Sync:      ${unrecognised}. Fix the remote, then run \`${INIT_COMMAND}\` again.`];
    const lines = [result.optedIn === null
        ? `Sync:      on (${SETTING_SYNC_POLICY} ${result.syncPolicy})`
        : `Sync:      on (${switched(result.optedIn, result.syncPolicy)})`];
    if (result.progressComments === PROGRESS_COMMENTS_NONE) {
        lines.push(`Phase comments: off (${SETTING_PROGRESS_COMMENTS} ${PROGRESS_COMMENTS_NONE}); `
            + `\`ghostpm config set ${SETTING_PROGRESS_COMMENTS} ${PROGRESS_COMMENTS_PHASE} --workspace ${quoteForShell(where)}\` turns them on`);
    }
    lines.push('Next: `ghostpm sync` pulls its issues, and Claude Code sessions here are captured by the GhostPM plugin.');
    return lines;
}

export function describeInit(result: InitResult): string {
    const workspace = result.workspace;
    const lines = [
        `Workspace: ${workspace.path}`,
        `Vendor:    ${workspace.vendor}${workspace.git_remote ? ` (${cleanText(workspace.git_remote)})` : ''}`,
    ];
    if (result.imported > 0) lines.push(`Imported ${result.imported} task(s) from the 1.4.0 database.`);
    if (result.applied.length > 0) lines.push(`Detected: ${result.applied.join(', ')}.`);
    if (result.kept.length > 0) lines.push(`Kept the existing ${result.kept.join(', ')} (change with \`ghostpm config set\`).`);
    result.warnings.forEach(warning => lines.push(`Warning: ${warning}`));
    if (workspace.vendor !== NO_VENDOR) {
        lines.push(...syncLines(result));
        return lines.join('\n');
    }
    lines.push('No GitHub or Azure DevOps remote: tasks stay local.');
    // Only init reads a remote added later, so the policy it set waits for the next init.
    if (result.optedIn !== null) {
        lines.push(`Sync:      waits for a remote (${switched(result.optedIn, result.syncPolicy)}): `
            + `add a GitHub or Azure DevOps remote, then run \`${INIT_COMMAND}\` again.`);
    }
    return lines.join('\n');
}

/**
 * Forgets the workspace and everything recorded under it, in one transaction. The vendor is never touched. Its 1.4.0
 * roots stay out of later start-up imports, which would otherwise bring it back and queue its 1.4.0 comments again (C38).
 */
export function unregisterWorkspace(db: Ledger, workspace: WorkspaceRow): WorkspaceFootprint {
    return write(db, () => {
        forgetLegacyRoots(db, workspace);
        return deleteWorkspace(db, workspace.id);
    });
}

/**
 * The workspace `ghostpm unregister <folder>` names: the folder's own row first, even when its .git is gone, since
 * climbing to a parent's git root would pick another workspace. Only an existing folder with no row of its own
 * resolves as a session there would, to its git root.
 */
export function unregisterTarget(db: Ledger, folder: string): WorkspaceRow | undefined {
    return workspaceAtPath(db, folder) ?? (fs.existsSync(folder) ? findWorkspace(db, folder) : undefined);
}

export function describeUnregister(workspace: WorkspaceRow, footprint: WorkspaceFootprint, deleted: boolean): string {
    const summary = `${footprint.tasks} task(s), ${footprint.events} event(s), ${footprint.vendorLinks} vendor link(s), `
        + `${footprint.outbox} queued vendor change(s) and ${footprint.sessions} session(s)`;
    if (deleted) {
        // Every hook event (session start, prompt, tool calls) registers the folder it runs in.
        return `Forgot ${workspace.path}: ${summary}. Nothing was changed at the vendor. `
            + 'A Claude Code session in this folder, one already open included, registers it again as a new workspace on its '
            + `next prompt or tool call; \`${INIT_COMMAND}\` there also turns sync on and brings back its 1.4.0 tasks, if it had any.`;
    }
    return `This deletes ${summary} recorded for ${workspace.path}. Nothing changes at the vendor, but queued changes that were never pushed are lost.\n`
        + `Run \`ghostpm unregister ${quoteForShell(workspace.path)} ${FLAG_YES}\` to confirm.`;
}
