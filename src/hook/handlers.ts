import { Ledger, openLedger, ledgerPath } from '../ledger/db';
import { ensureWorkspace } from '../ledger/workspaces';
import { getTask } from '../ledger/tasks';
import { getSession, startSession, touchSession } from '../ledger/sessions';
import { activeTaskFor, currentBranch } from '../ledger/branch';
import { rankCandidates, renderCandidatePrompt } from './candidates';
import { listEvents } from '../ledger/events';
import { TaskRow, formatTaskId } from '../ledger/types';
import { HookPayload } from './payload';

/** Distinguishes hook-captured sessions from the MCP server's own (`mcp`). */
export const HOOK_CLIENT = 'claude-code';

const SESSION_START = 'SessionStart';
const USER_PROMPT_SUBMIT = 'UserPromptSubmit';

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

function onUserPromptSubmit(db: Ledger, payload: HookPayload): string | null {
    const workspace = ensureWorkspace(db, payload.cwd);
    // touchSession, not startSession: a prompt is not a new session, and restarting one
    // clears task_id, which would drop the attachment on every prompt.
    touchSession(db, {
        id: payload.sessionId,
        client: HOOK_CLIENT,
        cwd: payload.cwd,
        workspaceId: workspace.id,
    });

    // "Has a task" means the session is attached to one. A task/<ref> branch is only a
    // candidate signal (spec §7.4 tier 1), not an attachment.
    const attachedId = getSession(db, payload.sessionId)?.task_id ?? null;
    if (attachedId !== null) {
        const attached = getTask(db, attachedId);
        if (attached) return `Active: ${formatTaskId(attached.id)} ${attached.title} · ${attached.phase}`;
    }

    return renderCandidatePrompt(rankCandidates(db, {
        workspaceId: workspace.id,
        sessionId: payload.sessionId,
        branch: currentBranch(payload.cwd),
    }));
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
        case USER_PROMPT_SUBMIT:
            return onUserPromptSubmit(db, payload);
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
