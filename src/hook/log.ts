import * as fs from 'fs';
import * as path from 'path';
import { getGhostpmHome } from '../registry';

export const HOOK_LOG_FILE = 'hook.log';

/** Best effort: logging must never be the reason a hook fails. */
export function logHookError(error: unknown): void {
    try {
        const home = getGhostpmHome();
        fs.mkdirSync(home, { recursive: true });
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        fs.appendFileSync(path.join(home, HOOK_LOG_FILE), `${new Date().toISOString()} ${message}\n`);
    } catch { /* nothing left to do if even logging fails */ }
}
