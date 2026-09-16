import * as fs from 'fs';
import * as path from 'path';
import { Ledger } from './ledger/db';
import { getSetting, setSetting, SETTING_PREVIOUS_STATUSLINE } from './ledger/settings';

/** What the chained statusline runs; `ghostpm statusline` runs the previous one itself. */
export const STATUSLINE_COMMAND = 'ghostpm statusline';

const COMMAND_TYPE = 'command';

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

/** Puts ghostpm in front of the configured statusline, remembering what it replaced. */
export function chainStatusline(db: Ledger, settingsPath: string): void {
    const settings = readSettings(settingsPath);
    if (settings === null) return;

    const current = settings.statusLine?.command;
    const alreadyOurs = typeof current === 'string' && current.indexOf(STATUSLINE_COMMAND) >= 0;
    // Skipping this when the command is already ours is what stops a second setup from
    // recording ghostpm as its own predecessor, which would chain it to itself forever.
    if (!alreadyOurs && typeof current === 'string' && current.length > 0) {
        setSetting(db, SETTING_PREVIOUS_STATUSLINE, current);
    }

    settings.statusLine = { type: COMMAND_TYPE, command: STATUSLINE_COMMAND };
    writeSettings(settingsPath, settings);
}

/** Gives back exactly the statusline that was configured before chaining. */
export function restoreStatusline(db: Ledger, settingsPath: string): void {
    const settings = readSettings(settingsPath);
    if (settings === null) return;

    const previous = getSetting<string>(db, SETTING_PREVIOUS_STATUSLINE);
    if (previous === undefined) delete settings.statusLine;
    else settings.statusLine = { type: COMMAND_TYPE, command: previous };

    writeSettings(settingsPath, settings);
}
