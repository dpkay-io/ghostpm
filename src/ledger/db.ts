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
    // 4: the prompt hook's "this session's tasks" reads the session's events, not every task in the workspace (spec §15).
    `
    CREATE INDEX events_session ON events (session_id, task_id);
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
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

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
        throw new Error(newerSchemaMessage(db.name, initialVersion));
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

/** The command that builds the addon into the ghostpm home. */
export const BOOTSTRAP_FIX = 'ghostpm bootstrap';

/**
 * Carries the fix in the message on purpose. Hooks swallow their errors so a session is
 * never blocked, which means this text is often the only trace a user will ever see.
 */
export const MISSING_BINDING_HELP =
    'GhostPM cannot load SQLite: its native addon was never compiled. A Claude Code plugin '
    + 'install runs `npm ci --ignore-scripts`, and npm 12 blocks dependency install scripts by default; '
    + 'either way the step that builds it was skipped. '
    + `Run \`${BOOTSTRAP_FIX}\` to build it into the ghostpm home.`;

/** Falls back to a bootstrapped addon before giving up, so one build survives every update. */
function openDatabase(filePath: string, options: Database.Options = {}): Ledger {
    try {
        return new Database(filePath, options);
    } catch (error) {
        if (!isMissingBinding(error)) throw error;
        const bootstrapped = bootstrappedBindingPath();
        if (!fs.existsSync(bootstrapped)) throw new Error(MISSING_BINDING_HELP);
        return new Database(filePath, { ...options, nativeBinding: bootstrapped });
    }
}

/** True only when neither this copy's addon nor a bootstrapped one loads. In memory: touches no file. */
export function sqliteAddonMissing(): boolean {
    try {
        openDatabase(':memory:').close();
        return false;
    } catch (error) {
        return error instanceof Error && error.message === MISSING_BINDING_HELP;
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

function newerSchemaMessage(filePath: string, version: number): string {
    return `Ledger at ${filePath} is schema version ${version}, newer than this build's ${SCHEMA_VERSION}. Update GhostPM before opening it.`;
}

function olderSchemaMessage(filePath: string, version: number): string {
    return `Ledger at ${filePath} is schema version ${version}, older than this build's ${SCHEMA_VERSION}. `
        + 'Start a Claude Code session or run `ghostpm sync` once so it upgrades, then try again.';
}

export type SchemaStatus = 'current' | 'older' | 'newer';

export function schemaVersion(db: Ledger): number {
    return db.pragma('user_version', { simple: true }) as number;
}

export function schemaStatus(db: Ledger): SchemaStatus {
    const version = schemaVersion(db);
    if (version === SCHEMA_VERSION) return 'current';
    return version > SCHEMA_VERSION ? 'newer' : 'older';
}

/** Carries the next step, like MISSING_BINDING_HELP: a reader has nowhere else to explain itself. */
export function noLedgerMessage(filePath: string): string {
    return `No GhostPM ledger at ${filePath} yet. The first Claude Code session with the GhostPM plugin creates it, and so does \`ghostpm init\`.`;
}

/**
 * For readers (dashboard, standup, tasks, status, statusline, doctor). It never creates the
 * file or its folder, never switches the journal mode and never migrates. A missing ledger
 * is an explained error, not a new empty file. It does not check the schema: callers that
 * must survive any version (the statusline, doctor) use this directly.
 */
export function openLedgerReadOnly(filePath: string = ledgerPath()): Ledger {
    if (!fs.existsSync(filePath)) throw new Error(noLedgerMessage(filePath));
    const db = openDatabase(filePath, { readonly: true, fileMustExist: true });
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return db;
}

/** openLedgerReadOnly for code that reads the current schema: anything else is refused, never migrated. */
export function openReader(filePath: string = ledgerPath()): Ledger {
    const db = openLedgerReadOnly(filePath);
    const version = schemaVersion(db);
    if (version === SCHEMA_VERSION) return db;
    db.close();
    throw new Error(version > SCHEMA_VERSION ? newerSchemaMessage(filePath, version) : olderSchemaMessage(filePath, version));
}

/** Changes whenever another connection commits (SQLite `PRAGMA data_version`); this connection's own writes do not count. */
export function dataVersion(db: Ledger): number {
    return db.pragma('data_version', { simple: true }) as number;
}

/**
 * The baseline is taken when the watcher is created. Each call then says whether another
 * connection or process committed since the previous call. It is a single pragma, cheap
 * enough to poll every second.
 */
export function changeWatcher(db: Ledger): () => boolean {
    let last = dataVersion(db);
    return () => {
        const current = dataVersion(db);
        const changed = current !== last;
        last = current;
        return changed;
    };
}
