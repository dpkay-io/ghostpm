import { Ledger } from '../ledger/db';
import { resolveSetting, SETTING_CURRENT_USER } from '../ledger/settings';
import { taskRefFromBranch } from '../ledger/branch';
import { resolveTaskRef } from '../ledger/tasks';
import { CLOSED_PHASES, TaskRow, formatTaskId } from '../ledger/types';

export const CANDIDATE_LIMIT = 5;
export const RECENT_DAYS = 14;
export const INJECTION_CHAR_BUDGET = 600;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TITLE_LIMIT = 60;
const ELLIPSIS = '…';
const VENDOR_ORIGIN = 'vendor';

/** Spec §7.4: what the model is told to do when the session has no task yet. */
const INSTRUCTION = [
    'If this prompt starts work (brainstorm, plan, detail out, implement, fix), call track_work.',
    'If it is a question or a lookup, do nothing.',
    'If you are unsure which task it belongs to, ask once inline.',
].join(' ');

export interface CandidateQuery {
    workspaceId: number;
    sessionId: string;
    branch: string | null;
    now?: number;
}

const closedPhases = Array.from(CLOSED_PHASES);
const NOT_CLOSED = `phase NOT IN (${closedPhases.map(() => '?').join(', ')})`;

/** Tasks this session has already touched, most recently first. */
function fromThisSession(db: Ledger, query: CandidateQuery): TaskRow[] {
    return db.prepare(`
        SELECT t.* FROM tasks t JOIN events e ON e.task_id = t.id
        WHERE e.session_id = ? AND t.workspace_id = ? AND t.${NOT_CLOSED}
        GROUP BY t.id
        ORDER BY MAX(e.seq) DESC`)
        .all(query.sessionId, query.workspaceId, ...closedPhases) as TaskRow[];
}

/**
 * Recent work in the workspace. Items pulled from the vendor count only when they are the
 * user's, or someone here already worked on them (spec §8.5: hidden from "my work").
 */
function recentlyTouched(db: Ledger, query: CandidateQuery): TaskRow[] {
    const cutoff = new Date((query.now ?? Date.now()) - RECENT_DAYS * MS_PER_DAY).toISOString();
    const user = resolveSetting<string>(db, query.workspaceId, SETTING_CURRENT_USER, '');
    return db.prepare(`
        SELECT * FROM tasks
        WHERE workspace_id = ? AND updated_at >= ? AND ${NOT_CLOSED}
          AND (origin <> ? OR assignee = ? OR EXISTS (SELECT 1 FROM events e WHERE e.task_id = tasks.id AND e.session_id IS NOT NULL))
        ORDER BY updated_at DESC`)
        .all(query.workspaceId, cutoff, ...closedPhases, VENDOR_ORIGIN, user) as TaskRow[];
}

/** Vendor items assigned to the current user stay eligible however old they are. */
function assignedToMe(db: Ledger, query: CandidateQuery): TaskRow[] {
    const user = resolveSetting<string>(db, query.workspaceId, SETTING_CURRENT_USER, '');
    if (user.length === 0) return [];
    return db.prepare(`
        SELECT * FROM tasks
        WHERE workspace_id = ? AND origin = ? AND assignee = ? AND ${NOT_CLOSED}
        ORDER BY updated_at DESC`)
        .all(query.workspaceId, VENDOR_ORIGIN, user, ...closedPhases) as TaskRow[];
}

function fromBranch(db: Ledger, query: CandidateQuery): TaskRow[] {
    const ref = taskRefFromBranch(query.branch);
    if (ref === null) return [];
    const task = resolveTaskRef(db, ref, query.workspaceId);
    return task && !CLOSED_PHASES.has(task.phase) ? [task] : [];
}

/**
 * Spec §7.4, in order: the branch's task, then what this session already worked on,
 * then recent work in this workspace, then vendor items assigned to the user.
 * A task qualifying twice keeps its highest placing.
 */
export function rankCandidates(db: Ledger, query: CandidateQuery): TaskRow[] {
    const ranked: TaskRow[] = [];
    const seen = new Set<number>();
    for (const tier of [fromBranch, fromThisSession, recentlyTouched, assignedToMe]) {
        for (const task of tier(db, query)) {
            if (seen.has(task.id)) continue;
            seen.add(task.id);
            ranked.push(task);
            if (ranked.length === CANDIDATE_LIMIT) return ranked;
        }
    }
    return ranked;
}

function shortTitle(title: string): string {
    return title.length <= TITLE_LIMIT ? title : `${title.slice(0, TITLE_LIMIT - 1)}${ELLIPSIS}`;
}

/**
 * The instruction is what makes track_work fire, so it is never the part that gets
 * truncated: candidates are added only while they fit the budget.
 */
export function renderCandidatePrompt(candidates: TaskRow[]): string {
    let text = INSTRUCTION;
    if (candidates.length === 0) return text;
    const header = '\nCandidates:';
    if (text.length + header.length > INJECTION_CHAR_BUDGET) return text;
    text += header;
    for (const task of candidates) {
        const line = `\n- ${formatTaskId(task.id)} ${shortTitle(task.title)} · ${task.phase}`;
        if (text.length + line.length > INJECTION_CHAR_BUDGET) break;
        text += line;
    }
    return text;
}
