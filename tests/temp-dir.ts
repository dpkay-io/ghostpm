import * as fs from 'fs';

/**
 * better-sqlite3's WAL/SHM files (and other just-written handles, e.g. an installed skill plugin) can still be releasing
 * on Windows right after a test tears down. Node retries the removal on EBUSY, ENOTEMPTY and EPERM with a backoff of
 * RETRY_DELAY_MS more each time (at most 1.5 s, and only when the first try failed), so the folder goes rather than
 * staying behind empty in the temporary folder.
 */
const REMOVE_RETRIES = 5;
const RETRY_DELAY_MS = 100;

// ponytail: a folder still locked after every retry is left behind. Leaking it is harmless; failing the test on it is not.
export function removeTempDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: REMOVE_RETRIES, retryDelay: RETRY_DELAY_MS });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw error;
    }
}
