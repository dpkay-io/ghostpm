import * as fs from 'fs';
import * as path from 'path';
import { getGhostpmHome } from '../registry';

export const HOOK_LOG_FILE = 'hook.log';
export const SYNC_LOG_FILE = 'sync.log';

/** Best effort: logging must never be the reason a hook or a sync fails. */
export function appendLog(fileName: string, message: string): void {
    try {
        const home = getGhostpmHome();
        fs.mkdirSync(home, { recursive: true });
        fs.appendFileSync(path.join(home, fileName), `${new Date().toISOString()} ${message}\n`);
    } catch { /* nothing left to do if even logging fails */ }
}

export function logHookError(error: unknown): void {
    appendLog(HOOK_LOG_FILE, error instanceof Error ? (error.stack ?? error.message) : String(error));
}
