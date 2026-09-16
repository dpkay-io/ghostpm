import * as fs from 'fs';

// ponytail: better-sqlite3's WAL/SHM files (and other just-written handles, e.g. an
// installed skill plugin) can still be releasing on Windows right after a test tears
// down, so rmSync sometimes hits ENOTEMPTY/EBUSY/EPERM on a disposable temp dir.
// Leaking it is harmless; failing the test on it is not.
export function removeTempDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw error;
    }
}
