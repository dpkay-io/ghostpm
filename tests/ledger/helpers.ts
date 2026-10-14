import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Ledger, openLedger, LEDGER_FILE } from '../../src/ledger/db';
import { OP_SYNC_STATE, OutboxRow, OutboxStatus } from '../../src/ledger/projection';
import { SYNC_LEASE } from '../../src/sync/lease';
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

/** One sync_state row in `status`. Seed at most one pending row per task: migration 2 allows no second. */
export function seedOutboxRow(db: Ledger, taskId: number, status: OutboxStatus): void {
    db.prepare('INSERT INTO outbox (task_id, op, status) VALUES (?, ?, ?)').run(taskId, OP_SYNC_STATE, status);
}

/** The sync runner's lease, held by `holder` until `expiresAt`. */
export function seedLease(db: Ledger, holder: string, expiresAt: string): void {
    db.prepare('INSERT OR REPLACE INTO leases (name, holder, expires_at) VALUES (?, ?, ?)').run(SYNC_LEASE, holder, expiresAt);
}
