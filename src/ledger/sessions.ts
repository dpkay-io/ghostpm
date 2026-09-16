import { Ledger, nowIso } from './db';
import { SessionRow } from './types';

export const MCP_CLIENT = 'mcp';
export const DEFAULT_STALE_SESSION_MINUTES = 10;
const MS_PER_MINUTE = 60 * 1000;

export const mcpSessionId = (pid: number = process.pid): string => `${MCP_CLIENT}:${pid}`;

export interface SessionInput {
    id: string;
    client: string;
    cwd: string;
    workspaceId: number | null;
    transcriptPath?: string | null;
}

const INSERT_SESSION = `
    INSERT INTO sessions (id, client, cwd, workspace_id, transcript_path, started_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`;
const ON_HEARTBEAT = `
    cwd = excluded.cwd,
    workspace_id = excluded.workspace_id,
    transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path),
    last_seen_at = excluded.last_seen_at,
    ended_at = NULL`;
const ON_RESTART = `${ON_HEARTBEAT},
    client = excluded.client,
    task_id = NULL,
    started_at = excluded.started_at`;

function upsertSession(db: Ledger, session: SessionInput, at: string, onConflict: string): SessionRow {
    db.prepare(`${INSERT_SESSION} ON CONFLICT(id) DO UPDATE SET ${onConflict}`)
        .run(session.id, session.client, session.cwd, session.workspaceId, session.transcriptPath ?? null, at, at);
    return getSession(db, session.id)!;
}

export function getSession(db: Ledger, id: string): SessionRow | undefined {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
}

/** New session, or a reused id (e.g. recycled pid): clears the previous task. */
export function startSession(db: Ledger, session: SessionInput, at: string = nowIso()): SessionRow {
    return upsertSession(db, session, at, ON_RESTART);
}

/** Heartbeat: keeps start time and current task. */
export function touchSession(db: Ledger, session: SessionInput, at: string = nowIso()): SessionRow {
    return upsertSession(db, session, at, ON_HEARTBEAT);
}

/** Plain update: safe inside write(). */
export function setSessionTask(db: Ledger, sessionId: string, taskId: number | null, at: string = nowIso()): void {
    db.prepare('UPDATE sessions SET task_id = ?, last_seen_at = ? WHERE id = ?').run(taskId, at, sessionId);
}

export function endSession(db: Ledger, sessionId: string, at: string = nowIso()): void {
    db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(at, sessionId);
}

export function listLiveSessions(db: Ledger, staleMinutes: number = DEFAULT_STALE_SESSION_MINUTES, now: number = Date.now()): SessionRow[] {
    const cutoff = new Date(now - staleMinutes * MS_PER_MINUTE).toISOString();
    return db.prepare('SELECT * FROM sessions WHERE ended_at IS NULL AND last_seen_at >= ? ORDER BY last_seen_at DESC')
        .all(cutoff) as SessionRow[];
}
