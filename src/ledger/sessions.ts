import { Ledger, MS_PER_MINUTE, nowIso } from './db';
import { SessionRow } from './types';

export const MCP_CLIENT = 'mcp';
/** Claude Code sessions, as its hooks register them; the MCP server it starts works in the same row. */
export const HOOK_CLIENT = 'claude-code';
/** Claude Code's session id, in the environment of every process it starts, MCP servers included. */
export const CLAUDE_SESSION_ENV = 'CLAUDE_CODE_SESSION_ID';
/** Claude Code's process id. Only its hooks get it: an MCP server inherits whatever its parent had (observed). */
export const CLAUDE_PID_ENV = 'CLAUDE_PID';
export const DEFAULT_STALE_SESSION_MINUTES = 10;

export const mcpSessionId = (pid: number = process.pid): string => `${MCP_CLIENT}:${pid}`;

export interface SessionInput {
    id: string;
    client: string;
    cwd: string;
    workspaceId: number | null;
    transcriptPath?: string | null;
    /** The client process the session runs in, when the client says (Claude Code's hooks do). */
    clientPid?: number | null;
}

const INSERT_SESSION = `
    INSERT INTO sessions (id, client, cwd, workspace_id, transcript_path, client_pid, started_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const ON_HEARTBEAT = `
    cwd = excluded.cwd,
    workspace_id = excluded.workspace_id,
    transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path),
    client_pid = COALESCE(excluded.client_pid, sessions.client_pid),
    last_seen_at = excluded.last_seen_at,
    ended_at = NULL`;
const ON_SEEN = `
    last_seen_at = excluded.last_seen_at`;
const ON_RESTART = `${ON_HEARTBEAT},
    client = excluded.client,
    task_id = NULL,
    started_at = excluded.started_at`;

function upsertSession(db: Ledger, session: SessionInput, at: string, onConflict: string): SessionRow {
    db.prepare(`${INSERT_SESSION} ON CONFLICT(id) DO UPDATE SET ${onConflict}`)
        .run(session.id, session.client, session.cwd, session.workspaceId, session.transcriptPath ?? null, session.clientPid ?? null, at, at);
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

/** Heartbeat from a process that does not own the row (Claude Code's MCP server; its hooks own it): creates it when missing, else moves last_seen_at only. */
export function seeSession(db: Ledger, session: SessionInput, at: string = nowIso()): SessionRow {
    return upsertSession(db, session, at, ON_SEEN);
}

/**
 * The newest session of the client process `sessionId` runs in: Claude Code keeps one process (and one MCP server)
 * across /clear, which starts a session with a new id. `sessionId` itself when no process is known.
 */
export function currentSessionOf(db: Ledger, sessionId: string): string {
    // ponytail: no index on client_pid; the sessions table is small and this runs per MCP tool call, never in a hook.
    const row = db.prepare(`
        SELECT id FROM sessions WHERE client_pid = (SELECT client_pid FROM sessions WHERE id = ?)
        ORDER BY last_seen_at DESC, started_at DESC LIMIT 1`).get(sessionId) as { id: string } | undefined;
    return row?.id ?? sessionId;
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
