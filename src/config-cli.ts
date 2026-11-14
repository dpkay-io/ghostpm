import * as fs from 'fs';
import { Ledger, write } from './ledger/db';
import { ensureWorkspace, findWorkspace } from './ledger/workspaces';
import {
    SETTING_DEFS, SETTING_LABEL_PREFIX, SETTING_PHASE_LABEL_MAP, SettingDef, SettingKey, SettingScope, deleteSetting, explainSetting, getSetting,
    getWorkspaceSetting, isSettingKey, setSetting, setWorkspaceSetting,
} from './ledger/settings';
import { WorkspaceRow, plural } from './ledger/types';
import { describeLabelClash, relabelChanged, snapshotLabelNames } from './sync/phase-labels';

/** Settings that decide which GitHub label each phase shows: changing one relabels the open issues it moves. */
const LABEL_SETTINGS: ReadonlySet<SettingKey> = new Set<SettingKey>([SETTING_LABEL_PREFIX, SETTING_PHASE_LABEL_MAP]);

const WORKSPACE_FLAG = '--workspace';
const GET = 'get';
const SET = 'set';
const UNSET = 'unset';
export const CONFIG_USAGE = 'Usage: ghostpm config get|set|unset <key> [value...] [--workspace <path>]';

interface ConfigArgs {
    action: string;
    key: string;
    values: string[];
    workspacePath: string | null;
}

function parseArgs(argv: readonly string[]): ConfigArgs {
    const positional: string[] = [];
    let workspacePath: string | null = null;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] !== WORKSPACE_FLAG) {
            positional.push(argv[i]);
            continue;
        }
        if (i + 1 >= argv.length) throw new Error(CONFIG_USAGE);
        workspacePath = argv[++i];
    }
    const [action, key, ...values] = positional;
    if (action === undefined || key === undefined) throw new Error(CONFIG_USAGE);
    return { action, key, values, workspacePath };
}

function workspaceAt(db: Ledger, folder: string, create: boolean): WorkspaceRow | null {
    if (!fs.existsSync(folder)) throw new Error(`No such folder: ${folder}`);
    return create ? ensureWorkspace(db, folder) : findWorkspace(db, folder) ?? null;
}

/** The workspace a command acts on, or null for the global value. */
function targetOf(db: Ledger, key: string, scope: SettingScope, args: ConfigArgs, cwd: string): WorkspaceRow | null {
    const writing = args.action !== GET;
    if (scope === 'global') {
        if (args.workspacePath !== null) throw new Error(`${key} is a global setting; drop ${WORKSPACE_FLAG}.`);
        return null;
    }
    if (scope === 'workspace') return workspaceAt(db, args.workspacePath ?? cwd, writing);
    // Global with a workspace override: writes go global unless a workspace is named;
    // reads show what applies in the folder the command runs in.
    if (writing) return args.workspacePath === null ? null : workspaceAt(db, args.workspacePath, true);
    return workspaceAt(db, args.workspacePath ?? cwd, false);
}

const where = (workspace: WorkspaceRow | null): string => (workspace === null ? 'global' : `workspace ${workspace.path}`);

/** Stores `value` (undefined removes it) at the command's scope. */
function store(db: Ledger, key: string, workspace: WorkspaceRow | null, value: unknown): void {
    if (workspace === null) {
        if (value === undefined) deleteSetting(db, key);
        else setSetting(db, key, value);
    } else {
        setWorkspaceSetting(db, workspace.id, key, value);
    }
}

/**
 * Works out and writes the change in one transaction: `next` gets the value stored at the command's scope (a setting
 * set a part at a time merges into it) and answers what to store, undefined to remove it. A label setting is then
 * checked (two phases sharing a label roll it back), and the open issues whose label it moved are queued to show the
 * new one. Answers what was stored and a note about that relabelling, or ''.
 */
function applyChange(
    db: Ledger, key: SettingKey, workspace: WorkspaceRow | null, next: (stored: unknown) => unknown,
): { value: unknown; note: string } {
    return write(db, () => {
        const before = LABEL_SETTINGS.has(key) ? snapshotLabelNames(db) : null;
        const value = next(workspace === null ? getSetting<unknown>(db, key) : getWorkspaceSetting<unknown>(db, workspace.id, key));
        store(db, key, workspace, value);
        if (before === null) return { value, note: '' };
        const clash = describeLabelClash(db);
        if (clash !== null) throw new Error(`Not changed: ${clash}. Give each phase its own label.`);
        const queued = relabelChanged(db, before);
        return { value, note: queued === 0 ? '' : `\n${plural(queued, 'open issue')} will be relabelled on the next sync.` };
    });
}

export function runConfigCommand(db: Ledger, argv: readonly string[], cwd: string): string {
    const args = parseArgs(argv);
    if (args.action !== GET && args.action !== SET && args.action !== UNSET) throw new Error(CONFIG_USAGE);
    if (!isSettingKey(args.key)) {
        throw new Error(`Unknown setting "${args.key}". Settings: ${Object.keys(SETTING_DEFS).join(', ')}`);
    }
    const key = args.key;
    const def: SettingDef<unknown> = SETTING_DEFS[key];
    const workspace = targetOf(db, key, def.scope, args, cwd);

    if (args.action === GET) {
        const { value, source } = explainSetting(db, workspace === null ? null : workspace.id, key);
        return `${key} = ${JSON.stringify(value)} (${source === 'workspace' ? where(workspace) : source})`;
    }
    if (args.action === UNSET) {
        const { note } = applyChange(db, key, workspace, () => undefined);
        return `${key} unset (${where(workspace)})${note}`;
    }
    let parsed: unknown;
    try {
        parsed = def.parse(args.values);
    } catch (error) {
        throw new Error(`Invalid value for ${key}: ${(error as Error).message}`);
    }
    const combine = def.combine;
    const { value, note } = applyChange(db, key, workspace, stored => (combine === undefined ? parsed : combine(stored, parsed)));
    return `${key} ${value === undefined ? 'unset' : `= ${JSON.stringify(value)}`} (${where(workspace)})${note}`;
}
