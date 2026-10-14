import * as fs from 'fs';
import * as path from 'path';
import { FLAG_YES } from './cli-args';
import { findGitRoot } from './init';
import { Ledger, write } from './ledger/db';
import {
    LEGACY_CONFIG_FILE, forgetLegacyRoots, importLegacyWorkspace, phaseStateMapFrom, unforgetLegacyRoot,
} from './ledger/legacy-import';
import {
    DEFAULT_ADO_WORK_ITEM_TYPE, PROGRESS_COMMENTS_NONE, PROGRESS_COMMENTS_PHASE, SETTING_ADO_WORK_ITEM_TYPE, SETTING_PHASE_STATE_MAP,
    SETTING_PROGRESS_COMMENTS, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO, SYNC_POLICY_OFF, SyncPolicy, getWorkspaceSetting, readSetting,
    setWorkspaceSetting,
} from './ledger/settings';
import { WorkspaceFootprint, deleteWorkspace, ensureWorkspace, refreshWorkspaceRemote } from './ledger/workspaces';
import { AZURE_DEVOPS, NO_VENDOR, WorkspaceRow } from './ledger/types';
import { AzureAdapter, AzureProcess } from './sync/azure';
import { AzureIdentity, identityOf } from './sync/identity';
import { syncOffHint } from './sync/schedule';

/** How far back init samples work items to learn the process template's states and types. */
export const AZURE_SAMPLE_DAYS = 90;
const NO_REMOTE = 'none';

export type SniffAzure = (identity: AzureIdentity) => Promise<AzureProcess>;

/** The real az, through the sync adapter's one WIQL path: free-text arguments and the vendor timeout. */
const sampleAzureProcess: SniffAzure = identity =>
    new AzureAdapter(identity.org, identity.project, DEFAULT_ADO_WORK_ITEM_TYPE, {}).sampleProcess(AZURE_SAMPLE_DAYS);

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

/** Fills phase_state_map and ado_work_item_type from a sample of the project; a value already there always stays. */
async function detectAzureSettings(db: Ledger, sniff: SniffAzure, result: InitResult): Promise<void> {
    const identity = identityOf(result.workspace);
    if (identity === null || identity.vendor !== AZURE_DEVOPS) {
        result.warnings.push(`Could not read the Azure DevOps organization and project from the git remote (${result.workspace.git_remote ?? NO_REMOTE}).`);
        return;
    }
    let sampled: AzureProcess;
    try {
        // A network call: no transaction is open here (spec §5).
        sampled = await sniff(identity);
    } catch (error) {
        result.warnings.push(`Could not sample work items in ${identity.project}; run \`ghostpm init\` again once this is fixed: ${(error as Error).message}`);
        return;
    }

    const stateMap = phaseStateMapFrom(sampled.states);
    const detected: [string, unknown][] = [
        [SETTING_PHASE_STATE_MAP, Object.keys(stateMap).length > 0 ? stateMap : undefined],
        [SETTING_ADO_WORK_ITEM_TYPE, sampled.workItemTypes.length > 0 ? sampled.workItemTypes[0] : undefined],
    ];
    for (const [key, value] of detected) {
        // A value already there came from an earlier init, the 1.4.0 import or a person: never overwrite it.
        if (getWorkspaceSetting(db, result.workspace.id, key) !== undefined) {
            result.kept.push(key);
        } else if (value === undefined) {
            result.warnings.push(`No work items changed in the last ${AZURE_SAMPLE_DAYS} days to learn ${key} from.`);
        } else {
            setWorkspaceSetting(db, result.workspace.id, key, value);
            result.applied.push(key);
        }
    }
}

export async function initWorkspace(db: Ledger, cwd: string, sniff: SniffAzure = sampleAzureProcess): Promise<InitResult> {
    const registered = ensureWorkspace(db, cwd);
    // Ruling P41: init opts the repo in to sync. Before the 1.4.0 import, whose linked-only stamp only fills a gap.
    if (getWorkspaceSetting(db, registered.id, SETTING_SYNC_POLICY) === undefined) {
        setWorkspaceSetting(db, registered.id, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);
    }
    const warnings: string[] = [];
    const imported = importLegacyFolder(db, cwd, warnings);
    // The git remote wins over the 1.4.0 config: it is what vendor calls will target.
    const workspace = refreshWorkspaceRemote(db, registered);
    const result: InitResult = {
        workspace, imported, applied: [], kept: [], warnings,
        syncPolicy: readSetting(db, workspace.id, SETTING_SYNC_POLICY),
        progressComments: readSetting(db, workspace.id, SETTING_PROGRESS_COMMENTS),
    };
    if (workspace.vendor === AZURE_DEVOPS) await detectAzureSettings(db, sniff, result);
    return result;
}

/** What sync does here now, and how to change it: worded with the same hint every surface uses. */
function syncLines(result: InitResult): string[] {
    const where = result.workspace.path;
    if (result.syncPolicy === SYNC_POLICY_OFF) return [`Sync:      ${SYNC_POLICY_OFF} (${syncOffHint(where)})`];
    const lines = [`Sync:      on (${SETTING_SYNC_POLICY} ${result.syncPolicy})`];
    if (result.progressComments === PROGRESS_COMMENTS_NONE) {
        lines.push(`Phase comments: off (${SETTING_PROGRESS_COMMENTS} ${PROGRESS_COMMENTS_NONE}); `
            + `\`ghostpm config set ${SETTING_PROGRESS_COMMENTS} ${PROGRESS_COMMENTS_PHASE} --workspace "${where}"\` turns them on`);
    }
    lines.push('Next: `ghostpm sync` pulls its issues, and Claude Code sessions here are captured by the GhostPM plugin.');
    return lines;
}

export function describeInit(result: InitResult): string {
    const workspace = result.workspace;
    const lines = [
        `Workspace: ${workspace.path}`,
        `Vendor:    ${workspace.vendor}${workspace.git_remote ? ` (${workspace.git_remote})` : ''}`,
    ];
    if (result.imported > 0) lines.push(`Imported ${result.imported} task(s) from the 1.4.0 database.`);
    if (result.applied.length > 0) lines.push(`Detected: ${result.applied.join(', ')}.`);
    if (result.kept.length > 0) lines.push(`Kept the existing ${result.kept.join(', ')} (change with \`ghostpm config set\`).`);
    result.warnings.forEach(warning => lines.push(`Warning: ${warning}`));
    if (workspace.vendor === NO_VENDOR) lines.push('No GitHub or Azure DevOps remote: tasks stay local.');
    else lines.push(...syncLines(result));
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

export function describeUnregister(workspace: WorkspaceRow, footprint: WorkspaceFootprint, deleted: boolean): string {
    const summary = `${footprint.tasks} task(s), ${footprint.events} event(s), ${footprint.vendorLinks} vendor link(s), `
        + `${footprint.outbox} queued vendor change(s) and ${footprint.sessions} session(s)`;
    if (deleted) {
        return `Forgot ${workspace.path}: ${summary}. Nothing was changed at the vendor. `
            + 'The next session in this folder registers it again; `ghostpm init` there also brings back its 1.4.0 tasks, if it had any.';
    }
    return `This deletes ${summary} recorded for ${workspace.path}. Nothing changes at the vendor, but queued changes that were never pushed are lost.\n`
        + `Run \`ghostpm unregister "${workspace.path}" ${FLAG_YES}\` to confirm.`;
}
