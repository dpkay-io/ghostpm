import Database from 'better-sqlite3';
import { bootstrappedBindingPath, isMissingBinding } from './binding';
import * as fs from 'fs';
import * as path from 'path';
import { getGhostpmHome } from '../registry';

export type Ledger = Database.Database;

export const LEDGER_FILE = 'ledger.db';
export const BUSY_TIMEOUT_MS = 5000;

/**
 * One entry per schema version. Never edit a shipped entry; append a new one.
 * Literals inside an entry are frozen with it on purpose: renaming a constant later must
 * not rewrite what an old ledger was migrated with.
 */
const MIGRATIONS: readonly string[] = [
    `
    CREATE TABLE workspaces (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        git_remote TEXT,
        vendor TEXT NOT NULL DEFAULT 'none',
        settings TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        phase TEXT NOT NULL,
        workspace_id INTEGER,
        origin TEXT NOT NULL,
        summary TEXT,
        body TEXT,
        assignee TEXT,
        milestone TEXT,
        rev INTEGER NOT NULL DEFAULT 0,
        human_phase_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX tasks_workspace ON tasks (workspace_id, updated_at);
    CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        session_id TEXT,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT,
        at TEXT NOT NULL
    );
    CREATE INDEX events_task ON events (task_id, seq);
    CREATE INDEX events_at ON events (at);
    CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        client TEXT NOT NULL,
        cwd TEXT NOT NULL,
        workspace_id INTEGER,
        task_id INTEGER,
        transcript_path TEXT,
        started_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ended_at TEXT
    );
    CREATE TABLE vendor_links (
        task_id INTEGER NOT NULL,
        vendor TEXT NOT NULL,
        remote_id TEXT NOT NULL,
        remote_url TEXT,
        remote_state TEXT,
        labels TEXT,
        remote_updated_at TEXT,
        last_pushed_rev INTEGER,
        PRIMARY KEY (task_id, vendor)
    );
    CREATE INDEX vendor_links_remote ON vendor_links (vendor, remote_id);
    CREATE TABLE outbox (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL,
        op TEXT NOT NULL,
        payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        claimed_by TEXT,
        claimed_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        error TEXT
    );
    CREATE TABLE leases (
        name TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        expires_at TEXT NOT NULL
    );
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    `,
    // 2 (Phase 3, Sync v2): one pending desired state per task, the claim index, and the
    // vendor-side baseline (last title seen) plus a marker for items deleted or moved away.
    `
    DELETE FROM outbox
    WHERE op = 'sync_state' AND status = 'pending'
      AND id NOT IN (SELECT MAX(id) FROM outbox WHERE op = 'sync_state' AND status = 'pending' GROUP BY task_id);
    CREATE UNIQUE INDEX outbox_one_pending_sync_state ON outbox (task_id) WHERE op = 'sync_state' AND status = 'pending';
    UPDATE outbox SET next_attempt_at = '1970-01-01T00:00:00.000Z' WHERE next_attempt_at IS NULL;
    CREATE INDEX outbox_due ON outbox (status, next_attempt_at);
    ALTER TABLE vendor_links ADD COLUMN remote_title TEXT;
    ALTER TABLE vendor_links ADD COLUMN broken_at TEXT;
    `,
    // 3 (Phase 3, Sync v2): the push in flight (intent), written just before the vendor call, so a
    // push that landed without its answer being recorded is never read as a person's edit.
    `
    ALTER TABLE vendor_links ADD COLUMN intent_title TEXT;
    ALTER TABLE vendor_links ADD COLUMN intent_phase TEXT;
    ALTER TABLE vendor_links ADD COLUMN intent_rev INTEGER;
    `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function ledgerPath(): string {
    return path.join(getGhostpmHome(), LEDGER_FILE);
}

export function nowIso(): string {
    return new Date().toISOString();
}

/** The ledger's time format for a moment given in epoch milliseconds. */
export const iso = (ms: number): string => new Date(ms).toISOString();
export const MS_PER_MINUTE = 60 * 1000;
export const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

export type SqlParam = string | number;

/** Collects AND-joined conditions and their bound parameters for dynamic filters. */
export class Where {
    private readonly conditions: string[] = [];
    readonly params: SqlParam[] = [];

    add(condition: string, ...params: SqlParam[]): this {
        this.conditions.push(condition);
        this.params.push(...params);
        return this;
    }

    in(column: string, values: readonly SqlParam[] | undefined): this {
        if (!values || values.length === 0) return this;
        return this.add(`${column} IN (${values.map(() => '?').join(', ')})`, ...values);
    }

    toString(): string {
        return this.conditions.length > 0 ? ` WHERE ${this.conditions.join(' AND ')}` : '';
    }
}

/** Runs fn in a BEGIN IMMEDIATE transaction. A nested call becomes a savepoint of the outer transaction. */
export function write<T>(db: Ledger, fn: () => T): T {
    return db.transaction(fn).immediate();
}

/** Brings the ledger up to `targetVersion` (normally the newest). Forward only. */
export function migrate(db: Ledger, targetVersion: number = SCHEMA_VERSION): void {
    // Read outside any transaction first: the common case (already current) then needs
    // no write lock at all, which matters when this runs on every hook invocation.
    const initialVersion = db.pragma('user_version', { simple: true }) as number;
    if (initialVersion > SCHEMA_VERSION) {
        throw new Error(
            `Ledger at ${db.name} is schema version ${initialVersion}, newer than this build's ${SCHEMA_VERSION}. Update GhostPM before opening it.`
        );
    }
    if (initialVersion >= targetVersion) return;

    // Re-reading the version inside the lock makes concurrent first opens safe.
    const applyNext = (): boolean => {
        const version = db.pragma('user_version', { simple: true }) as number;
        if (version >= targetVersion) return false;
        db.exec(MIGRATIONS[version]);
        db.pragma(`user_version = ${version + 1}`);
        return true;
    };
    while (write(db, applyNext)) { /* one schema version per transaction */ }
}

/**
 * Carries the fix in the message on purpose. Hooks swallow their errors so a session is
 * never blocked, which means this text is often the only trace a user will ever see.
 */
export const MISSING_BINDING_HELP =
    'GhostPM cannot load SQLite: its native addon was never compiled. A Claude Code plugin '
    + 'install runs `npm ci --ignore-scripts`, which skips the step that builds it. '
    + 'Run `ghostpm bootstrap` to build it into the ghostpm home.';

/** Falls back to a bootstrapped addon before giving up, so one build survives every update. */
function openDatabase(filePath: string): Ledger {
    try {
        return new Database(filePath);
    } catch (error) {
        if (!isMissingBinding(error)) throw error;
        const bootstrapped = bootstrappedBindingPath();
        if (!fs.existsSync(bootstrapped)) throw new Error(MISSING_BINDING_HELP);
        return new Database(filePath, { nativeBinding: bootstrapped });
    }
}

export function openLedger(filePath: string = ledgerPath()): Ledger {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const db = openDatabase(filePath);
    try {
        db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
        db.pragma('journal_mode = WAL');
        migrate(db);
    } catch (error) {
        // A refused ledger must not stay locked by this process (Windows keeps open files locked).
        db.close();
        throw error;
    }
    return db;
}
