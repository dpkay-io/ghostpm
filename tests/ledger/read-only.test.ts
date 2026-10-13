import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import {
    LEDGER_FILE, SCHEMA_VERSION, changeWatcher, noLedgerMessage, openLedger, openLedgerReadOnly, openReader, schemaStatus,
} from '../../src/ledger/db';
import { removeTempDir } from '../temp-dir';

/** A second OS process that commits one row, as a hook or the MCP server would. */
const WRITE_ONE_SETTING = `
const Database = require(process.argv[1]);
const db = new Database(process.argv[2]);
db.pragma('busy_timeout = 5000');
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('probe', ?)").run(JSON.stringify(Date.now()));
db.close();
`;
/** A second OS process that only reads. */
const READ_ONLY = `
const Database = require(process.argv[1]);
const db = new Database(process.argv[2], { readonly: true });
db.prepare('SELECT COUNT(*) AS n FROM settings').get();
db.close();
`;

function runChild(script: string, file: string): void {
    const result = spawnSync(process.execPath, ['-e', script, require.resolve('better-sqlite3'), file], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`child failed: ${result.stderr}`);
}

describe('read-only ledger access', () => {
    let dir: string;
    const file = (): string => path.join(dir, LEDGER_FILE);

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-ro-'));
    });

    afterEach(() => {
        removeTempDir(dir);
    });

    it('never creates the ledger or its folder', () => {
        const missing = path.join(dir, 'home', LEDGER_FILE);
        expect(() => openLedgerReadOnly(missing)).toThrow(noLedgerMessage(missing));
        expect(fs.existsSync(path.dirname(missing))).toBe(false);
    });

    it('leaves the journal mode of the file alone', () => {
        const plain = new Database(file());
        plain.pragma(`user_version = ${SCHEMA_VERSION}`);
        plain.close();

        const reader = openLedgerReadOnly(file());
        try {
            expect(reader.pragma('journal_mode', { simple: true })).toBe('delete');
        } finally {
            reader.close();
        }
        const again = new Database(file());
        try {
            expect(again.pragma('journal_mode', { simple: true })).toBe('delete');
        } finally {
            again.close();
        }
    });

    it('refuses a ledger older than this build instead of migrating it', () => {
        new Database(file()).close();

        expect(() => openReader(file())).toThrow('schema version 0, older');
        const plain = new Database(file());
        try {
            expect(plain.pragma('user_version', { simple: true })).toBe(0);
            expect(plain.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get()).toEqual({ n: 0 });
        } finally {
            plain.close();
        }
    });

    it('refuses a ledger newer than this build and names both versions (Review Focus 4)', () => {
        const writer = openLedger(file());
        writer.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
        writer.close();

        expect(() => openReader(file())).toThrow(`schema version ${SCHEMA_VERSION + 1}, newer than this build's ${SCHEMA_VERSION}`);
        const raw = openLedgerReadOnly(file());
        try {
            expect(schemaStatus(raw)).toBe('newer');
        } finally {
            raw.close();
        }
    });

    it('reads a current ledger and cannot write to it', () => {
        openLedger(file()).close();
        const reader = openReader(file());
        try {
            expect(schemaStatus(reader)).toBe('current');
            expect(() => reader.prepare("INSERT INTO settings (key, value) VALUES ('k', '1')").run()).toThrow(/readonly/i);
        } finally {
            reader.close();
        }
    });
});

describe('changeWatcher', () => {
    let dir: string;
    const file = (): string => path.join(dir, LEDGER_FILE);

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-watch-'));
        openLedger(file()).close();
    });

    afterEach(() => {
        removeTempDir(dir);
    });

    it('sees a commit from another connection in this process', () => {
        const reader = openReader(file());
        const writer = openLedger(file());
        try {
            const changed = changeWatcher(reader);
            expect(changed()).toBe(false);
            writer.prepare("INSERT INTO settings (key, value) VALUES ('k', '1')").run();
            expect(changed()).toBe(true);
            expect(changed()).toBe(false);
        } finally {
            writer.close();
            reader.close();
        }
    });

    it('sees a commit from another process, and nothing when that process only reads (spec §15)', () => {
        const reader = openReader(file());
        try {
            const changed = changeWatcher(reader);
            runChild(WRITE_ONE_SETTING, file());
            expect(changed()).toBe(true);
            expect(changed()).toBe(false);
            runChild(READ_ONLY, file());
            expect(changed()).toBe(false);
        } finally {
            reader.close();
        }
    });
});
