import * as fs from 'fs';
import * as path from 'path';
import { getGhostpmHome } from '../registry';

export const HOOK_LOG_FILE = 'hook.log';
export const SYNC_LOG_FILE = 'sync.log';
/** A log above this size moves to `<name>.1` before the next line: two files of about 1 MiB at most, per log. */
export const LOG_MAX_BYTES = 1024 * 1024;
export const ROTATED_LOG_SUFFIX = '.1';

/**
 * One generation is kept. ponytail: two processes rotating at once can lose the older `.1`; a lock costs every hook
 * more than that log is worth.
 */
function rotateIfFull(file: string): void {
    try {
        if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}${ROTATED_LOG_SUFFIX}`);
    } catch { /* no log yet, or the rename failed: append to the current file anyway */ }
}

/** Best effort: logging must never be the reason a hook or a sync fails. */
export function appendLog(fileName: string, message: string): void {
    try {
        const home = getGhostpmHome();
        fs.mkdirSync(home, { recursive: true });
        const file = path.join(home, fileName);
        rotateIfFull(file);
        fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
    } catch { /* nothing left to do if even logging fails */ }
}

export function logHookError(error: unknown): void {
    appendLog(HOOK_LOG_FILE, error instanceof Error ? (error.stack ?? error.message) : String(error));
}
