import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
// The module object itself, not an import wrapper: a spy on it is what src code calling os.homedir() sees.
import os = require('os');
import { Ledger, openLedger, LEDGER_FILE } from '../../src/ledger/db';
import { LEGACY_DB_FILE } from '../../src/ledger/legacy-import';
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

/** The ghostpm home (ledger, 1.4.0 registry, sync.log) and the user home code reads from the environment. */
const HOME_VARIABLES = ['GHOSTPM_HOME', 'HOME', 'USERPROFILE'];

/**
 * Points every home at `home`: the variables, and os.homedir() (~/.claude.json, the ghostpm home's fallback), which
 * never reads Jest's process.env (a sandbox copy). Returns the restore.
 */
export function isolateHomes(home: string): () => void {
    const originals = HOME_VARIABLES.map(name => process.env[name]);
    HOME_VARIABLES.forEach(name => { process.env[name] = home; });
    const homedir = jest.spyOn(os, 'homedir').mockReturnValue(home);
    return () => {
        homedir.mockRestore();
        HOME_VARIABLES.forEach((name, index) => {
            const original = originals[index];
            if (original !== undefined) process.env[name] = original;
            else delete process.env[name];
        });
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

/**
 * A linked worktree of the repository at `main`, as git 2.28 lays it out: `<worktree>/.git` is a file naming
 * `<main>/.git/worktrees/<name>`, whose `commondir` leads back to `<main>/.git`.
 */
export function linkedWorktree(main: string, worktree: string, name: string = path.basename(worktree)): string {
    const gitDir = path.join(main, '.git', 'worktrees', name);
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
    return worktree;
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

/** A valid 1.4.0 `.mcp-pm.yml` for a GitHub repo. */
export const LEGACY_GITHUB_CONFIG = `vendor: "github"
workflow:
  states: ["open", "closed"]
  transitions:
    start_task: "in_progress"
views:
  list_columns: ["id", "state", "title", "assignee"]
  detail_fields: ["id", "title", "body", "comments"]
`;

/** 1.4.0's `.mcp-pm.db` schema: src/db.ts initSchema plus migrateSchema, frozen here so tests outlive that file. */
const LEGACY_SCHEMA = `
    CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL, assignee TEXT, body TEXT,
        comments TEXT, updatedAt TEXT, labels TEXT, milestone TEXT, url TEXT
    );
    CREATE TABLE outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', errorMsg TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export interface LegacyTask {
    id: string;
    title: string;
    state: string;
    assignee?: string;
    body?: string;
    comments?: string;
    updatedAt?: string;
    labels?: string;
    milestone?: string;
    url?: string;
}

/** A change 1.4.0 queued for an issue (`payload` is its `{ state?, comment? }` JSON). */
export interface LegacyOutboxItem {
    taskId: string;
    action: string;
    payload: string;
    status: string;
}

export function seedLegacyDb(
    root: string, tasks: LegacyTask[], metadata: { [key: string]: string } = {}, outbox: LegacyOutboxItem[] = [],
): void {
    const legacy = new Database(path.join(root, LEGACY_DB_FILE));
    try {
        legacy.exec(LEGACY_SCHEMA);
        const insert = legacy.prepare(`
            INSERT INTO tasks (id, title, state, assignee, body, comments, updatedAt, labels, milestone, url)
            VALUES (@id, @title, @state, @assignee, @body, @comments, @updatedAt, @labels, @milestone, @url)`);
        tasks.forEach(task => insert.run({
            assignee: null, body: null, comments: null, updatedAt: null, labels: null, milestone: null, url: null, ...task,
        }));
        const meta = legacy.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
        Object.keys(metadata).forEach(key => meta.run(key, metadata[key]));
        const queue = legacy.prepare('INSERT INTO outbox (taskId, action, payload, status) VALUES (@taskId, @action, @payload, @status)');
        outbox.forEach(item => queue.run(item));
    } finally {
        legacy.close();
    }
}
