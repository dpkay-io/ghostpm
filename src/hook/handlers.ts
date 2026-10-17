import { Ledger, openLedger, ledgerPath } from '../ledger/db';
import { ensureWorkspace } from '../ledger/workspaces';
import { getTask } from '../ledger/tasks';
import { HOOK_CLIENT, SessionInput, getSession, startSession, touchSession, endSession } from '../ledger/sessions';
import { activeTaskFor, currentBranch } from '../ledger/branch';
import type * as Work from '../ledger/work';
import { rankCandidates, renderCandidatePrompt } from './candidates';
import { listEvents } from '../ledger/events';
import { TaskRow, WorkspaceRow, formatTaskId } from '../ledger/types';
import type * as Schedule from '../sync/schedule';
import { HookPayload } from './payload';
import type * as Spawn from './spawn';
import { logHookError } from './log';

export { HOOK_CLIENT };

export const SESSION_START = 'SessionStart';
const USER_PROMPT_SUBMIT = 'UserPromptSubmit';
const POST_TOOL_BATCH = 'PostToolBatch';
const SESSION_END = 'SessionEnd';
/**
 * SessionStart sources that go on with the same conversation under the same id (observed: `claude --resume`, and
 * /compact), so the session keeps its task. startup and clear begin afresh.
 */
const CONTINUING_SOURCES: ReadonlySet<unknown> = new Set(['resume', 'compact']);

const HOOK_SOURCE = `hook:${HOOK_CLIENT}`;
/** Tools whose use means a file was changed. */
const FILE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit']);
/** Claude Code's shell tools: both take `command` and answer with the printed output as a string (observed). */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);
/**
 * Word-bounded: `git status` is not a commit. Global options may come first (`git -C <path> commit`,
 * `git -c k=v commit`, `--git-dir=…`), each with an optional value, quoted or not, that is never `commit` itself.
 */
const GIT_COMMIT = /\bgit(?:\s+-[^\s=]+(?:=\S*|\s+(?!-|commit\b)(?:"[^"]*"|'[^']*'|\S+))?)*\s+commit\b/;
const PR_CREATE = /\b(?:gh\s+pr\s+create|az\s+repos\s+pr\s+create)\b/;
/**
 * A pull request's own URL (ruling F9): GitHub `/pull/<n>`, Azure DevOps `/pullrequest/<n>`. Not any URL: git push
 * prints GitHub's `/pull/new/<branch>` hint first. Stops at quotes, so a URL inside printed JSON stays one URL.
 */
const PR_URL = /https?:\/\/[^\s"'<>]+?\/(?:pull|pullrequest)\/\d+(?!\w)/i;

export interface HookOptions {
    /** Starts a detached one-shot `ghostpm sync --background`. Injected so tests never spawn. */
    startSync?: () => void;
    now?: number;
}

/**
 * Spec §8.1: pull on SessionStart through a detached `ghostpm sync`, never inline, and only when nobody holds the
 * sync lease. The hook itself makes no vendor call. Required here, not imported: the prompt hook runs on every
 * prompt and never needs the schedule, the lease, the outbox or the spawner (spec §15, ruling M5).
 */
function startSyncIfDue(db: Ledger, workspace: WorkspaceRow, options: HookOptions): void {
    const schedule = require('../sync/schedule') as typeof Schedule;
    if (!schedule.shouldStartSync(db, workspace, options.now ?? Date.now())) return;
    if (options.startSync !== undefined) options.startSync();
    else (require('./spawn') as typeof Spawn).spawnCliDetached(schedule.SYNC_COMMAND, schedule.BACKGROUND_FLAG);
}

function resumeLine(db: Ledger, task: TaskRow): string {
    const [latest] = listEvents(db, { taskId: task.id, limit: 1 });
    const tail = latest ? ` · last: ${latest.kind}` : '';
    return `Resuming ${formatTaskId(task.id)} ${task.title} · ${task.phase}${tail}`;
}

/** The session this hook reports, as every handler registers it. */
function sessionOf(payload: HookPayload, workspace: WorkspaceRow): SessionInput {
    return { id: payload.sessionId, client: HOOK_CLIENT, cwd: payload.cwd, workspaceId: workspace.id, clientPid: payload.clientPid };
}

function onSessionStart(db: Ledger, payload: HookPayload, options: HookOptions): string | null {
    const workspace = ensureWorkspace(db, payload.cwd);
    const transcriptPath = payload.raw.transcript_path;
    const session = { ...sessionOf(payload, workspace), transcriptPath: typeof transcriptPath === 'string' ? transcriptPath : null };
    // Spec §5: a resumed (or compacted) conversation is the same work, so it keeps its task.
    if (CONTINUING_SOURCES.has(payload.raw.source)) touchSession(db, session);
    else startSession(db, session);
    try {
        startSyncIfDue(db, workspace, options);
    } catch (error) {
        logHookError(error);   // a failed spawn must not cost the resume line
    }
    const task = activeTaskFor(db, payload.sessionId, currentBranch(payload.cwd), workspace.id);
    return task ? resumeLine(db, task) : null;
}

function onUserPromptSubmit(db: Ledger, payload: HookPayload): string | null {
    const workspace = ensureWorkspace(db, payload.cwd);
    // touchSession, not startSession: a prompt is not a new session, and restarting one
    // clears task_id, which would drop the attachment on every prompt.
    touchSession(db, sessionOf(payload, workspace));

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
        if (!SHELL_TOOLS.has(name)) continue;
        const command = readString(call.tool_input, 'command');
        if (GIT_COMMIT.test(command)) evidence.committed = true;
        if (!PR_CREATE.test(command)) continue;
        const printed = typeof call.tool_response === 'string' ? call.tool_response.match(PR_URL) : null;
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
    touchSession(db, sessionOf(payload, workspace));

    // Evidence with nothing to attach it to is noise.
    const taskId = getSession(db, payload.sessionId)?.task_id ?? null;
    if (taskId === null) return null;

    const { files, committed, prUrls } = collectEvidence(payload);
    if (files.length === 0 && !committed && prUrls.length === 0) return null;

    // One transaction per batch: the batch lands whole, with the phase it proves. Required here: the prompt hook never writes evidence (spec §15).
    (require('../ledger/work') as typeof Work).recordEvidence(db, {
        taskId, sessionId: payload.sessionId, source: HOOK_SOURCE, workspaceId: workspace.id,
        cwd: payload.cwd, files, committed, prUrls,
    });
    return null;
}

type Handler = (db: Ledger, payload: HookPayload, options: HookOptions) => string | null;

const HANDLERS: { [event: string]: Handler } = {
    [SESSION_START]: onSessionStart,
    [USER_PROMPT_SUBMIT]: onUserPromptSubmit,
    [POST_TOOL_BATCH]: onPostToolBatch,
    [SESSION_END]: onSessionEnd,
};

/**
 * The events this hook implements. Derived from the dispatch table rather than listed
 * separately, so the plugin's hooks.json can be checked against it without the two
 * drifting apart.
 */
export const HANDLED_EVENTS: string[] = Object.keys(HANDLERS);

/**
 * Ledger-injected entry, so tests drive a temp ledger rather than the real one.
 * Returns the text to inject, or null when there is nothing to say.
 */
export function handleWith(db: Ledger, payload: HookPayload, options: HookOptions = {}): string | null {
    // Without a session id nothing can be correlated later, and every such hook would
    // share one row keyed on the empty string.
    if (payload.sessionId.length === 0) return null;
    const handler = HANDLERS[payload.event];
    return handler === undefined ? null : handler(db, payload, options);
}

export function handle(payload: HookPayload): string | null {
    const db = openLedger(ledgerPath());
    try {
        return handleWith(db, payload);
    } finally {
        db.close();
    }
}
