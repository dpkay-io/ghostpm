import { Ledger, Where, nowIso } from './db';
import { EventKind, EventRow } from './types';

export interface EventInput {
    taskId: number | null;
    kind: EventKind;
    source: string;
    sessionId?: string | null;
    payload?: unknown;
}

/** Plain insert: call inside write() together with the projection change it describes. */
export function recordEvent(db: Ledger, event: EventInput, at: string = nowIso()): void {
    db.prepare('INSERT INTO events (task_id, session_id, source, kind, payload, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(
            event.taskId,
            event.sessionId ?? null,
            event.source,
            event.kind,
            event.payload === undefined ? null : JSON.stringify(event.payload),
            at,
        );
}

export const DEFAULT_TIMELINE_LIMIT = 200;

export interface EventFilter {
    taskId?: number;
    workspaceId?: number;
    kinds?: EventKind[];
    since?: string;
    limit?: number;
    /** Only events a session recorded on a task that belongs to a different workspace (spec §9.3). */
    crossWorkspaceOnly?: boolean;
}

export interface TimelineEntry extends EventRow {
    /** Title of the task the event belongs to; null for events with no task. */
    title: string | null;
    /** Workspace of that task. */
    workspace_id: number | null;
    /** Workspace of the session that recorded the event. */
    session_workspace_id: number | null;
}

// ponytail: sessions.workspace_id is the session's latest workspace, not the one at event
// time. A Claude Code session or an MCP server keeps one project folder, so they agree in
// practice; store the workspace on the event if sessions ever move between workspaces.
const CROSS_WORKSPACE = 's.workspace_id IS NOT NULL AND t.workspace_id IS NOT NULL AND s.workspace_id != t.workspace_id';

/** Oldest first. When more events match than `limit`, the most recent ones are returned. */
export function listEvents(db: Ledger, filter: EventFilter = {}): TimelineEntry[] {
    const where = new Where().in('e.kind', filter.kinds);
    if (filter.taskId !== undefined) where.add('e.task_id = ?', filter.taskId);
    if (filter.workspaceId !== undefined) where.add('t.workspace_id = ?', filter.workspaceId);
    if (filter.since !== undefined) where.add('e.at >= ?', filter.since);
    if (filter.crossWorkspaceOnly) where.add(CROSS_WORKSPACE);
    const rows = db.prepare(`
        SELECT e.*, t.title AS title, t.workspace_id AS workspace_id, s.workspace_id AS session_workspace_id
        FROM events e
        LEFT JOIN tasks t ON t.id = e.task_id
        LEFT JOIN sessions s ON s.id = e.session_id
        ${where}
        ORDER BY e.seq DESC
        LIMIT ?`).all(...where.params, filter.limit ?? DEFAULT_TIMELINE_LIMIT) as TimelineEntry[];
    return rows.reverse();
}
