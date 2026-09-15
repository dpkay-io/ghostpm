import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openLedger, ledgerPath, write, Where, SCHEMA_VERSION, LEDGER_FILE } from '../../src/ledger/db';

const EXPECTED_TABLES = ['events', 'leases', 'outbox', 'sessions', 'settings', 'tasks', 'vendor_links', 'workspaces'];
const SPEC_BUSY_TIMEOUT_MS = 5000;

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
        fs.rmSync(dir, { recursive: true, force: true });
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

    it('builds WHERE clauses only from active conditions', () => {
        const empty = new Where().in('phase', []);
        expect(`${empty}`).toBe('');
        expect(empty.params).toEqual([]);
        const where = new Where().add('workspace_id = ?', 3).in('phase', ['planned', 'done']);
        expect(`${where}`).toBe(' WHERE workspace_id = ? AND phase IN (?, ?)');
        expect(where.params).toEqual([3, 'planned', 'done']);
    });
});
