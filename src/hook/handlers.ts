import { Ledger, openLedger, ledgerPath, write, nowIso } from '../ledger/db';
import { ensureWorkspace } from '../ledger/workspaces';
import { getTask, bumpRevision } from '../ledger/tasks';
import { getSession, startSession, touchSession, endSession } from '../ledger/sessions';
import { activeTaskFor, currentBranch } from '../ledger/branch';
import { rankCandidates, renderCandidatePrompt } from './candidates';
import { listEvents, recordEvent } from '../ledger/events';
import { TaskRow, formatTaskId } from '../ledger/types';
import { HookPayload } from './payload';

/** Distinguishes hook-captured sessions from the MCP server's own (`mcp`). */
export const HOOK_CLIENT = 'claude-code';

const SESSION_START = 'SessionStart';
const USER_PROMPT_SUBMIT = 'UserPromptSubmit';
const POST_TOOL_BATCH = 'PostToolBatch';
const SESSION_END = 'SessionEnd';

const HOOK_SOURCE = `hook:${HOOK_CLIENT}`;
/** Tools whose use means a file was changed. */
const FILE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit']);
const BASH_TOOL = 'Bash';
/** Word-bounded: `git status` is not a commit. */
const GIT_COMMIT = /\bgit\s+commit\b/;
const PR_CREATE = /\b(?:gh\s+pr\s+create|az\s+repos\s+pr\s+create)\b/;
const FIRST_URL = /https?:\/\/\S+/;

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

interface BatchEvidence {
    files: string[];
    committed: boolean;
    prUrls: string[];
}

function readString(input: Record<string, unknown> | undefined, key: string): string {
    const value = input?.[key];
    return typeof value === 'string' ? value : '';
}

function collectEvidence(payload: HookPayload): BatchEvidence {
    const evidence: BatchEvidence = { files: [], committed: false, prUrls: [] };
    for (const call of payload.toolCalls) {
        const name = call.tool_name ?? '';
        if (FILE_TOOLS.has(name)) {
            const file = readString(call.tool_input, 'file_path');
            if (file.length > 0 && evidence.files.indexOf(file) < 0) evidence.files.push(file);
            continue;
        }
        if (name !== BASH_TOOL) continue;
        const command = readString(call.tool_input, 'command');
        if (GIT_COMMIT.test(command)) evidence.committed = true;
        if (!PR_CREATE.test(command)) continue;
        const printed = typeof call.tool_response === 'string' ? call.tool_response.match(FIRST_URL) : null;
        if (printed) evidence.prUrls.push(printed[0]);
    }
    return evidence;
}

/**
 * Marks the session ended. Deliberately does not ensure a workspace or heartbeat:
 * ending needs only the id, and moving last_seen_at on the way out would work against
 * the staleness fallback that covers SessionEnd never firing (Ctrl+C, crash, closed
 * terminal). endSession is a bare UPDATE, so an id we never saw stays unknown.
 */
function onSessionEnd(db: Ledger, payload: HookPayload): string | null {
    endSession(db, payload.sessionId);
    return null;
}

/** Writes what the batch proves. Injects nothing: evidence is recorded, not narrated back. */
function onPostToolBatch(db: Ledger, payload: HookPayload): string | null {
    const workspace = ensureWorkspace(db, payload.cwd);
    touchSession(db, {
        id: payload.sessionId,
        client: HOOK_CLIENT,
        cwd: payload.cwd,
        workspaceId: workspace.id,
    });

    // Evidence with nothing to attach it to is noise.
    const taskId = getSession(db, payload.sessionId)?.task_id ?? null;
    if (taskId === null) return null;

    const { files, committed, prUrls } = collectEvidence(payload);
    if (files.length === 0 && !committed && prUrls.length === 0) return null;

    // One transaction per batch, so a batch lands whole and updated_at moves once.
    write(db, () => {
        const at = nowIso();
        const common = { taskId, source: HOOK_SOURCE, sessionId: payload.sessionId };
        if (files.length > 0) recordEvent(db, { ...common, kind: 'progress', payload: { files } }, at);
        if (committed) recordEvent(db, { ...common, kind: 'commit', payload: {} }, at);
        for (const url of prUrls) recordEvent(db, { ...common, kind: 'pr', payload: { url } }, at);
        bumpRevision(db, taskId, at);
    });
    return null;
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
        case POST_TOOL_BATCH:
            return onPostToolBatch(db, payload);
        case SESSION_END:
            return onSessionEnd(db, payload);
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
