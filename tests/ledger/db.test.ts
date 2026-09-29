import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { openLedger, ledgerPath, migrate, write, Where, SCHEMA_VERSION, LEDGER_FILE } from '../../src/ledger/db';
import { removeTempDir } from '../temp-dir';

const EXPECTED_TABLES = ['events', 'leases', 'outbox', 'sessions', 'settings', 'tasks', 'vendor_links', 'workspaces'];
const SPEC_BUSY_TIMEOUT_MS = 5000;
const FIRST_SCHEMA_VERSION = 1;
const EPOCH = '1970-01-01T00:00:00.000Z';

describe('ledger db', () => {
    let dir: string;
    let originalHome: string | undefined;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-ledger-'));
        originalHome = process.env.GHOSTPM_HOME;
        process.env.GHOSTPM_HOME = dir;
    });

    afterEach(() => {
        if (originalHome !== undefined) process.env.GHOSTPM_HOME = originalHome;
        else delete process.env.GHOSTPM_HOME;
        removeTempDir(dir);
    });

    it('resolves the ledger path under GHOSTPM_HOME', () => {
        expect(ledgerPath()).toBe(path.join(dir, LEDGER_FILE));
    });

    it('creates the file with WAL, busy timeout, schema version and all tables', () => {
        const db = openLedger();
        try {
            expect(fs.existsSync(path.join(dir, LEDGER_FILE))).toBe(true);
            expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
            expect(db.pragma('busy_timeout', { simple: true })).toBe(SPEC_BUSY_TIMEOUT_MS);
            expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
            const tables = (db.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            ).all() as { name: string }[]).map(r => r.name);
            expect(tables).toEqual(EXPECTED_TABLES);
        } finally {
            db.close();
        }
    });

    it('reopens an existing ledger without failing on existing tables', () => {
        openLedger().close();
        const db = openLedger();
        try {
            expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
        } finally {
            db.close();
        }
    });

    it('shares committed data between two connections', () => {
        const first = openLedger();
        const second = openLedger();
        try {
            first.prepare("INSERT INTO settings (key, value) VALUES ('k', '1')").run();
            expect(second.prepare("SELECT value FROM settings WHERE key = 'k'").get()).toEqual({ value: '1' });
        } finally {
            first.close();
            second.close();
        }
    });

    it('rolls back nested writes when the outer write throws', () => {
        const db = openLedger();
        try {
            expect(() => write(db, () => {
                write(db, () => db.prepare("INSERT INTO settings (key, value) VALUES ('inner', '1')").run());
                throw new Error('boom');
            })).toThrow('boom');
            expect(db.prepare('SELECT COUNT(*) AS n FROM settings').get()).toEqual({ n: 0 });
        } finally {
            db.close();
        }
    });

    it('refuses to open a ledger written by a newer schema version', () => {
        const newerVersion = SCHEMA_VERSION + 1;
        const bumped = openLedger();
        bumped.pragma(`user_version = ${newerVersion}`);
        bumped.close();

        let thrown: Error | undefined;
        try {
            openLedger();
        } catch (error) {
            thrown = error as Error;
        }
        expect(thrown).toBeDefined();
        expect(thrown!.message).toContain(String(newerVersion));
        expect(thrown!.message).toContain(String(SCHEMA_VERSION));
        expect(thrown!.message).toContain(ledgerPath());
    });

    it('does not open a write transaction to migrate an already-current ledger', () => {
        openLedger().close();
        const db = new Database(ledgerPath());
        try {
            // write() calls db.transaction(...).immediate(), which takes the write lock.
            // The fast path must return before migrate() ever calls it.
            const transactionSpy = jest.spyOn(db, 'transaction');
            migrate(db);
            expect(transactionSpy).not.toHaveBeenCalled();
        } finally {
            db.close();
        }
    });

    it('builds WHERE clauses only from active conditions', () => {
        const empty = new Where().in('phase', []);
        expect(`${empty}`).toBe('');
        expect(empty.params).toEqual([]);
        const where = new Where().add('workspace_id = ?', 3).in('phase', ['planned', 'done']);
        expect(`${where}`).toBe(' WHERE workspace_id = ? AND phase IN (?, ?)');
        expect(where.params).toEqual([3, 'planned', 'done']);
    });

    it('upgrades a populated version-1 ledger while an older process still reads it', () => {
        const file = ledgerPath();
        const older = new Database(file);
        older.pragma(`busy_timeout = ${SPEC_BUSY_TIMEOUT_MS}`);
        older.pragma('journal_mode = WAL');
        migrate(older, FIRST_SCHEMA_VERSION);
        older.exec(`
            INSERT INTO workspaces (id, path) VALUES (1, 'ws');
            INSERT INTO tasks (id, title, phase, workspace_id, origin, created_at, updated_at)
                VALUES (1, 'Kept', 'planned', 1, 'local', 't', 't'), (2, 'Also kept', 'planned', 1, 'local', 't', 't');
            INSERT INTO outbox (id, task_id, op, status) VALUES (1, 1, 'sync_state', 'pending'), (2, 1, 'sync_state', 'pending');
            INSERT INTO vendor_links (task_id, vendor, remote_id) VALUES (1, 'github', '7');
        `);
        // An open statement holds a read snapshot, like a session still running the old build.
        const reading = older.prepare('SELECT id FROM tasks ORDER BY id').iterate();
        reading.next();

        const db = openLedger(file);
        try {
            expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
            expect(db.prepare('SELECT title FROM tasks ORDER BY id').all()).toEqual([{ title: 'Kept' }, { title: 'Also kept' }]);
            // v1 never enforced one pending sync_state per task: the newest survives.
            expect(db.prepare('SELECT id, next_attempt_at FROM outbox').all()).toEqual([{ id: 2, next_attempt_at: EPOCH }]);
            expect(db.prepare('SELECT remote_title, broken_at FROM vendor_links').get()).toEqual({ remote_title: null, broken_at: null });
            // The older connection finishes what it was reading.
            expect(Array.from(reading)).toEqual([{ id: 2 }]);
        } finally {
            db.close();
            older.close();
        }
    });

    it('allows one pending sync_state per task, beside any number in flight', () => {
        const db = openLedger();
        try {
            const insert = db.prepare('INSERT INTO outbox (task_id, op, status, next_attempt_at) VALUES (1, ?, ?, ?)');
            insert.run('sync_state', 'claimed', EPOCH);
            insert.run('sync_state', 'pending', EPOCH);
            insert.run('comment', 'pending', EPOCH);
            insert.run('comment', 'pending', EPOCH);
            expect(() => insert.run('sync_state', 'pending', EPOCH)).toThrow(/UNIQUE constraint failed/);
        } finally {
            db.close();
        }
    });

    it('answers the claim query from an index', () => {
        const db = openLedger();
        try {
            const plan = db.prepare(
                'EXPLAIN QUERY PLAN SELECT id FROM outbox WHERE status = ? AND next_attempt_at <= ? ORDER BY id LIMIT 1'
            ).all('pending', EPOCH) as { detail: string }[];
            expect(plan.map(step => step.detail).join('\n')).toContain('outbox_due');
        } finally {
            db.close();
        }
    });

    it('closes its handle when it refuses a newer ledger', () => {
        const bumped = openLedger();
        bumped.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
        bumped.close();
        const closeSpy = jest.spyOn(Database.prototype, 'close');
        try {
            expect(() => openLedger()).toThrow(/newer than this build/);
            // A leaked handle keeps the file locked on Windows until the process exits.
            expect(closeSpy).toHaveBeenCalledTimes(1);
        } finally {
            closeSpy.mockRestore();
        }
    });
});
