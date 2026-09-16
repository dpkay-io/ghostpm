import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Ledger, openLedger, LEDGER_FILE } from '../../src/ledger/db';

export function eventKinds(db: Ledger, taskId: number): string[] {
    return (db.prepare('SELECT kind FROM events WHERE task_id = ? ORDER BY seq').all(taskId) as { kind: string }[])
        .map(e => e.kind);
}

export interface TempLedger {
    db: Ledger;
    dir: string;
    cleanup(): void;
}

export function tempLedger(): TempLedger {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-ledger-'));
    const db = openLedger(path.join(dir, LEDGER_FILE));
    return {
        db,
        dir,
        cleanup: () => {
            db.close();
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch (error) {
                // ponytail: better-sqlite3's WAL/SHM files can still be releasing on Windows
                // right after close(), so rmSync sometimes hits ENOTEMPTY/EBUSY/EPERM on this
                // disposable temp dir. Leaking it is harmless; failing the test on it is not.
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw error;
            }
        },
    };
}
