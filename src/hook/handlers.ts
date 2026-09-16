import { Ledger, openLedger, ledgerPath } from '../ledger/db';
import { ensureWorkspace } from '../ledger/workspaces';
import { startSession } from '../ledger/sessions';
import { activeTaskFor, currentBranch } from '../ledger/branch';
import { listEvents } from '../ledger/events';
import { TaskRow, formatTaskId } from '../ledger/types';
import { HookPayload } from './payload';

/** Distinguishes hook-captured sessions from the MCP server's own (`mcp`). */
export const HOOK_CLIENT = 'claude-code';

const SESSION_START = 'SessionStart';

function resumeLine(db: Ledger, task: TaskRow): string {
    const [latest] = listEvents(db, { taskId: task.id, limit: 1 });
    const tail = latest ? ` · last: ${latest.kind}` : '';
    return `Resuming ${formatTaskId(task.id)} ${task.title} · ${task.phase}${tail}`;
}

function onSessionStart(db: Ledger, payload: HookPayload): string | null {
    const workspace = ensureWorkspace(db, payload.cwd);
    const transcriptPath = payload.raw.transcript_path;
    startSession(db, {
        id: payload.sessionId,
        client: HOOK_CLIENT,
        cwd: payload.cwd,
        workspaceId: workspace.id,
        transcriptPath: typeof transcriptPath === 'string' ? transcriptPath : null,
    });
    const task = activeTaskFor(db, payload.sessionId, currentBranch(payload.cwd), workspace.id);
    return task ? resumeLine(db, task) : null;
}

/**
 * Ledger-injected entry, so tests drive a temp ledger rather than the real one.
 * Returns the text to inject, or null when there is nothing to say.
 */
export function handleWith(db: Ledger, payload: HookPayload): string | null {
    // Without a session id nothing can be correlated later, and every such hook would
    // share one row keyed on the empty string.
    if (payload.sessionId.length === 0) return null;
    switch (payload.event) {
        case SESSION_START:
            return onSessionStart(db, payload);
        default:
            return null;
    }
}

export function handle(payload: HookPayload): string | null {
    const db = openLedger(ledgerPath());
    try {
        return handleWith(db, payload);
    } finally {
        db.close();
    }
}
