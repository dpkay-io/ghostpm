import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Ledger, openLedger, LEDGER_FILE } from '../../src/ledger/db';
import { OutboxRow } from '../../src/ledger/projection';
import { removeTempDir } from '../temp-dir';

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
            removeTempDir(dir);
        },
    };
}

export const GITHUB_REMOTE = 'https://github.com/acme/widgets.git';

/** A folder that looks like a clone of `remote`, so ensureWorkspace detects its vendor. */
export function clonedRepo(parent: string, name: string, remote: string = GITHUB_REMOTE): string {
    const root = path.join(parent, name);
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'config'), `[remote "origin"]\n\turl = ${remote}\n`);
    return root;
}

export function outboxRows(db: Ledger, taskId: number): OutboxRow[] {
    return db.prepare('SELECT * FROM outbox WHERE task_id = ? ORDER BY id').all(taskId) as OutboxRow[];
}
