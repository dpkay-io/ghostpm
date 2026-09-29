import * as fs from 'fs';
import { Ledger } from './ledger/db';
import { ensureWorkspace, findWorkspace } from './ledger/workspaces';
import {
    SETTING_DEFS, SettingDef, SettingScope, deleteSetting, explainSetting, isSettingKey, setSetting, setWorkspaceSetting,
} from './ledger/settings';
import { WorkspaceRow } from './ledger/types';

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
        if (workspace === null) deleteSetting(db, key);
        else setWorkspaceSetting(db, workspace.id, key, undefined);
        return `${key} unset (${where(workspace)})`;
    }
    let value: unknown;
    try {
        value = def.parse(args.values);
    } catch (error) {
        throw new Error(`Invalid value for ${key}: ${(error as Error).message}`);
    }
    if (workspace === null) setSetting(db, key, value);
    else setWorkspaceSetting(db, workspace.id, key, value);
    return `${key} = ${JSON.stringify(value)} (${where(workspace)})`;
}
