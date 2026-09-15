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
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}
