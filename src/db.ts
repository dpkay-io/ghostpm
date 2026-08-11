import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { Task } from './pm-adapter';
import { findGitRoot } from './init';

export interface OutboxItem {
    id?: number;
    taskId: string;
    action: string;
    payload: string;
    status: 'pending' | 'failed' | 'conflict';
    errorMsg?: string;
    createdAt?: string;
}

export class Db {
    private db: Database.Database;

    constructor(currentPath: string = process.cwd()) {
        const gitRoot = findGitRoot(currentPath);
        if (!gitRoot) {
            throw new Error('Not a git repository. Cannot initialize database.');
        }

        const dbPath = path.join(gitRoot, '.mcp-pm.db');
        this.db = new Database(dbPath);
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                state TEXT NOT NULL,
                assignee TEXT,
                body TEXT,
                comments TEXT,
                updatedAt TEXT
            );

            CREATE TABLE IF NOT EXISTS outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                taskId TEXT NOT NULL,
                action TEXT NOT NULL,
                payload TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                errorMsg TEXT,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);
        this.migrateSchema();
    }

    private migrateSchema() {
        const cols = this.db.pragma('table_info(tasks)') as { name: string }[];
        const existing = new Set(cols.map(c => c.name));
        const additions: [string, string][] = [
            ['labels', 'TEXT'],
            ['milestone', 'TEXT'],
            ['url', 'TEXT'],
        ];
        for (const [col, type] of additions) {
            if (!existing.has(col)) {
                this.db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${type}`);
            }
        }
    }

    public getMetadata(key: string): string | undefined {
        const stmt = this.db.prepare('SELECT value FROM metadata WHERE key = ?');
        const row = stmt.get(key) as { value: string } | undefined;
        return row?.value;
    }

    public setMetadata(key: string, value: string) {
        const stmt = this.db.prepare(`
            INSERT INTO metadata (key, value)
            VALUES (@key, @value)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `);
        stmt.run({ key, value });
    }

    public deleteMetadata(key: string) {
        this.db.prepare('DELETE FROM metadata WHERE key = ?').run(key);
    }

    public getTasks(): Task[] {
        const stmt = this.db.prepare('SELECT * FROM tasks');
        return stmt.all() as Task[];
    }

    public getTask(id: string): Task | undefined {
        const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
        return stmt.get(id) as Task | undefined;
    }

    public upsertTask(task: Task) {
        const stmt = this.db.prepare(`
            INSERT INTO tasks (id, title, state, assignee, body, comments, updatedAt, labels, milestone, url)
            VALUES (@id, @title, @state, @assignee, @body, @comments, @updatedAt, @labels, @milestone, @url)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                state = excluded.state,
                assignee = excluded.assignee,
                body = excluded.body,
                comments = excluded.comments,
                updatedAt = excluded.updatedAt,
                labels = excluded.labels,
                milestone = excluded.milestone,
                url = excluded.url
        `);
        stmt.run({
            id: task.id,
            title: task.title,
            state: task.state,
            assignee: task.assignee ?? null,
            body: task.body ?? null,
            comments: task.comments ?? null,
            updatedAt: task.updatedAt ?? null,
            labels: task.labels ?? null,
            milestone: task.milestone ?? null,
            url: task.url ?? null,
        });
    }

    public addOutboxItem(item: OutboxItem) {
        const stmt = this.db.prepare(`
            INSERT INTO outbox (taskId, action, payload, status)
            VALUES (@taskId, @action, @payload, @status)
        `);
        stmt.run({ ...item, status: item.status ?? 'pending' });
    }

    public getPendingOutboxItems(): OutboxItem[] {
        const stmt = this.db.prepare("SELECT * FROM outbox WHERE status = 'pending' ORDER BY createdAt ASC");
        return stmt.all() as OutboxItem[];
    }
    
    public getConflictedOutboxItems(): OutboxItem[] {
        const stmt = this.db.prepare("SELECT * FROM outbox WHERE status = 'conflict' ORDER BY createdAt ASC");
        return stmt.all() as OutboxItem[];
    }

    public getConflictedOutboxItemByTaskId(taskId: string): OutboxItem | undefined {
        const stmt = this.db.prepare("SELECT * FROM outbox WHERE status = 'conflict' AND taskId = ? ORDER BY createdAt DESC LIMIT 1");
        return stmt.get(taskId) as OutboxItem | undefined;
    }

    public updateOutboxItemStatus(id: number, status: OutboxItem['status'], errorMsg?: string) {
        const stmt = this.db.prepare('UPDATE outbox SET status = @status, errorMsg = @errorMsg WHERE id = @id');
        stmt.run({ id, status, errorMsg: errorMsg || null });
    }

    public clearOutboxItemBaseTime(id: number) {
        const stmt = this.db.prepare('SELECT payload FROM outbox WHERE id = ?');
        const row = stmt.get(id) as { payload: string } | undefined;
        if (!row) return;
        const payload = JSON.parse(row.payload);
        delete payload.baseUpdatedAt;
        const update = this.db.prepare('UPDATE outbox SET payload = @payload WHERE id = @id');
        update.run({ id, payload: JSON.stringify(payload) });
    }

    public deleteOutboxItem(id: number) {
        const stmt = this.db.prepare('DELETE FROM outbox WHERE id = ?');
        stmt.run(id);
    }
    
    public clearCache() {
        this.db.exec('DELETE FROM tasks');
    }

    public close() {
        this.db.close();
    }
}
