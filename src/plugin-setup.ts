import * as fs from 'fs';
import * as path from 'path';
import { Ledger } from './ledger/db';
import { getSetting, setSetting, SETTING_PREVIOUS_STATUSLINE } from './ledger/settings';
import { getGhostpmHome } from './registry';

/** The CLI of the copy that is running: a plugin version's dist, or a global install's. */
export const CLI_ENTRY_PATH = path.join(__dirname, 'cli-main.js');

const LAUNCHER_FILE = 'ghostpm.js';
const STATUSLINE_SUBCOMMAND = 'statusline';
const COMMAND_TYPE = 'command';
const CLAUDE_DIR = '.claude';
const USER_SETTINGS_FILE = 'settings.json';

/**
 * statusLine is a user-level setting, so a per-project settings file would never take
 * effect. Shared so chaining and restoring cannot end up pointing at different files.
 */
export function userSettingsPath(): string {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return path.join(home, CLAUDE_DIR, USER_SETTINGS_FILE);
}

interface Settings {
    statusLine?: { type?: string; command?: string };
    [key: string]: unknown;
}

/**
 * `{}` when the file simply is not there yet, `null` when it exists but cannot be
 * parsed. The difference matters: creating a missing file is helpful, while
 * overwriting a broken one would destroy a config the user can still repair.
 */
function readSettings(settingsPath: string): Settings | null {
    if (!fs.existsSync(settingsPath)) return {};
    try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Settings
            : null;
    } catch {
        return null;
    }
}

function writeSettings(settingsPath: string, settings: Settings): void {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

export function launcherPath(home: string = getGhostpmHome()): string {
    return path.join(home, LAUNCHER_FILE);
}

/**
 * Runs the launcher in the ghostpm home rather than the CLI itself. Bare `ghostpm` needs a
 * global install that plugin users do not have, and a plugin's own directory is per
 * version: Claude Code deletes it 14 days after an update. The home stays put.
 * Forward slashes read the same to cmd, PowerShell and sh, and node accepts them.
 */
export function statuslineCommand(home: string = getGhostpmHome()): string {
    return `node "${launcherPath(home).split(path.sep).join('/')}" ${STATUSLINE_SUBCOMMAND}`;
}

function isChained(settings: Settings, home: string): boolean {
    const current = settings.statusLine?.command;
    return typeof current === 'string' && current.indexOf(statuslineCommand(home)) >= 0;
}

function launcherSource(cliEntry: string): string {
    return `require(${JSON.stringify(cliEntry)});\n`;
}

function writeLauncher(home: string, cliEntry: string): void {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(launcherPath(home), launcherSource(cliEntry), 'utf8');
}

/**
 * Points an existing launcher at the running copy. Called from SessionStart, the first
 * code a new plugin version runs, so an update never strands the statusline on a
 * deleted directory. No launcher means the user never opted in: nothing to do.
 */
export function refreshLauncher(home: string = getGhostpmHome(), cliEntry: string = CLI_ENTRY_PATH): void {
    const file = launcherPath(home);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') === launcherSource(cliEntry)) return;
    writeLauncher(home, cliEntry);
}

/** Puts ghostpm in front of the configured statusline, remembering what it replaced. */
export function chainStatusline(
    db: Ledger,
    settingsPath: string,
    home: string = getGhostpmHome(),
    cliEntry: string = CLI_ENTRY_PATH,
): void {
    const settings = readSettings(settingsPath);
    if (settings === null) return;

    const current = settings.statusLine?.command;
    // Skipping this when the command is already ours is what stops a second setup from
    // recording ghostpm as its own predecessor, which would chain it to itself forever.
    if (!isChained(settings, home) && typeof current === 'string' && current.length > 0) {
        setSetting(db, SETTING_PREVIOUS_STATUSLINE, current);
    }

    writeLauncher(home, cliEntry);
    settings.statusLine = { type: COMMAND_TYPE, command: statuslineCommand(home) };
    writeSettings(settingsPath, settings);
}

/** Gives back exactly the statusline that was configured before chaining; false if there was nothing to undo. */
export function restoreStatusline(db: Ledger, settingsPath: string, home: string = getGhostpmHome()): boolean {
    const settings = readSettings(settingsPath);
    // Not ours means never chained, or since replaced by hand: either way the user's own.
    if (settings === null || !isChained(settings, home)) return false;

    const previous = getSetting<string>(db, SETTING_PREVIOUS_STATUSLINE);
    if (previous === undefined) delete settings.statusLine;
    else settings.statusLine = { type: COMMAND_TYPE, command: previous };

    writeSettings(settingsPath, settings);
    // Gone, so SessionStart stops maintaining a launcher nothing runs any more.
    fs.rmSync(launcherPath(home), { force: true });
    return true;
}
