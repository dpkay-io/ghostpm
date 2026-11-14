import * as path from 'path';
import { Ledger, write, nowIso } from './db';
import { recordEvent } from './events';
import { applyPhaseChange, bumpRevision, getTask, getVendorLink, insertTaskRow, recordComment, resolveTaskRef, ChangeContext } from './tasks';
import { getSession, setSessionTask } from './sessions';
import { COMPLETION_ASK, COMPLETION_REVIEW, readSetting, SETTING_PLAN_GLOBS } from './settings';
import { VERIFIED_PHASE, VERIFIED_PREFIX, completionOf } from './completion';
import { followLinks, getWorkspace } from './workspaces';
import { matchesAnyGlob } from './glob';
import { CLOSED_PHASES, EventKind, INTENT_PHASE, Intent, Phase, TaskRow, formatTaskId } from './types';
import { enqueueCloseDuplicate, handOverVendorItem, projectTask } from './projection';

/** Forward order for automatic phase moves; done and dropped are terminal. */
const PHASE_RANK: Record<Phase, number> = { brainstorming: 0, planned: 1, in_progress: 2, in_review: 3, done: 4, dropped: 4 };
/** Spec §7.3: attaching new work to a done or dropped task reopens it in this phase. */
export const REOPEN_PHASE: Phase = 'in_progress';
const PLAN_PHASE: Phase = 'planned';
const WORK_PHASE: Phase = 'in_progress';
const REVIEW_PHASE: Phase = 'in_review';
const PARENT_SEGMENT = '..';
const OUTSIDE_PREFIX = PARENT_SEGMENT + path.sep;

/**
 * Spec §7.3: evidence moves a phase forward only, never out of done/dropped, and never on
 * evidence that is not newer than the last human-sourced phase change (§8.6). `at` is when
 * the move is recorded; `evidenceAt` is when the evidence happened (a PR's merge time).
 * Call inside write().
 */
export function advancePhase(
    db: Ledger,
    task: TaskRow,
    target: Phase,
    ctx: ChangeContext,
    at: string,
    evidenceAt: string = at,
): boolean {
    if (CLOSED_PHASES.has(task.phase)) return false;
    if (PHASE_RANK[target] <= PHASE_RANK[task.phase]) return false;
    if (task.human_phase_at !== null && Date.parse(evidenceAt) <= Date.parse(task.human_phase_at)) return false;
    applyPhaseChange(db, task, target, ctx, at);
    return true;
}

export interface TrackWorkInput {
    sessionId: string;
    source: string;
    workspaceId: number | null;
    title: string;
    intent: Intent;
    taskRef?: string;
}

export interface TrackWorkResult {
    task: TaskRow;
    created: boolean;
    reopened: boolean;
}

export function trackWork(db: Ledger, input: TrackWorkInput): TrackWorkResult {
    return write(db, () => {
        const at = nowIso();
        const ctx: ChangeContext = { source: input.source, sessionId: input.sessionId, human: false };
        const intentPhase = INTENT_PHASE[input.intent];
        const ref = input.taskRef?.trim();

        if (!ref) {
            const task = insertTaskRow(db, {
                title: input.title, phase: intentPhase, workspaceId: input.workspaceId,
                origin: 'local', source: input.source, sessionId: input.sessionId,
            }, at);
            setSessionTask(db, input.sessionId, task.id, at);
            projectTask(db, task, 'change', at);
            return { task, created: true, reopened: false };
        }

        const existing = resolveTaskRef(db, ref, input.workspaceId);
        if (!existing) throw new Error(`Task ${ref} not found`);

        const reopened = CLOSED_PHASES.has(existing.phase);
        if (reopened) {
            applyPhaseChange(db, existing, REOPEN_PHASE, ctx, at);
        } else {
            advancePhase(db, existing, intentPhase, ctx, at);
        }
        recordEvent(db, { taskId: existing.id, kind: 'progress', source: input.source, sessionId: input.sessionId, payload: { intent: input.intent, note: input.title } }, at);
        bumpRevision(db, existing.id, at);
        setSessionTask(db, input.sessionId, existing.id, at);
        return { task: getTask(db, existing.id)!, created: false, reopened };
    });
}

/** Phase the merged-away task ends in. */
export const MERGED_PHASE: Phase = 'dropped';

export interface MergeInput {
    fromRef: string;
    intoRef: string;
    workspaceId: number | null;
    source: string;
    sessionId?: string | null;
}

export interface MergeResult {
    from: TaskRow;
    into: TaskRow;
}

export function mergeTask(db: Ledger, input: MergeInput): MergeResult {
    return write(db, () => {
        const from = resolveTaskRef(db, input.fromRef, input.workspaceId);
        if (!from) throw new Error(`Task ${input.fromRef} not found`);
        const into = resolveTaskRef(db, input.intoRef, input.workspaceId);
        if (!into) throw new Error(`Task ${input.intoRef} not found`);
        if (from.id === into.id) throw new Error('Cannot merge a task into itself');

        const at = nowIso();
        // Merging is an explicit user instruction ("this is part of T12"), so it counts as human (spec §8.6).
        const ctx: ChangeContext = { source: input.source, sessionId: input.sessionId, human: true };

        db.prepare('UPDATE events SET task_id = ? WHERE task_id = ?').run(into.id, from.id);
        // Spec §8.7: a bare remote id means nothing in another repo, so the link moves within one workspace only.
        // OR IGNORE: a link that collides with one the kept task already has stays behind,
        // and that remote item is closed as a duplicate below.
        const sameWorkspace = from.workspace_id === into.workspace_id;
        const linkMoved = sameWorkspace
            && db.prepare('UPDATE OR IGNORE vendor_links SET task_id = ? WHERE task_id = ?').run(into.id, from.id).changes > 0;
        db.prepare('UPDATE sessions SET task_id = ? WHERE task_id = ?').run(into.id, from.id);

        if (from.phase !== MERGED_PHASE) applyPhaseChange(db, from, MERGED_PHASE, ctx, at);
        recordEvent(db, { taskId: into.id, kind: 'merged', source: input.source, sessionId: input.sessionId, payload: { from: from.id } }, at);
        recordEvent(db, { taskId: from.id, kind: 'merged', source: input.source, sessionId: input.sessionId, payload: { into: into.id } }, at);
        bumpRevision(db, from.id, at);
        bumpRevision(db, into.id, at);

        // Spec §8.7, within one workspace as above.
        const fromLink = getVendorLink(db, from.id);
        const intoLink = getVendorLink(db, into.id);
        if (fromLink !== undefined && intoLink !== undefined && fromLink.vendor === intoLink.vendor && sameWorkspace) {
            enqueueCloseDuplicate(db, getTask(db, from.id)!, intoLink.remote_id, at);
        }
        if (linkMoved) handOverVendorItem(db, from.id, getTask(db, into.id)!, at);

        return { from: getTask(db, from.id)!, into: getTask(db, into.id)! };
    });
}

export interface EvidenceInput {
    taskId: number;
    sessionId: string;
    source: string;
    /** The session's workspace: plan files are matched relative to its root. */
    workspaceId: number;
    /** Folder relative tool paths are resolved against. */
    cwd: string;
    files: string[];
    committed: boolean;
    prUrls: string[];
}

/** The path relative to the workspace root, or null when the file lives outside it. The root is stored with links followed, so the file is too. */
function relativeToRoot(root: string, cwd: string, file: string): string | null {
    const relative = path.relative(root, followLinks(path.resolve(cwd, file)));
    const outside = relative === PARENT_SEGMENT || relative.startsWith(OUTSIDE_PREFIX) || path.isAbsolute(relative);
    return outside ? null : relative;
}

/**
 * Spec §7.3 table, strongest evidence first. Files outside the workspace (Claude Code's
 * plan mode writes to ~/.claude/plans) are progress, never phase evidence.
 */
function evidencePhase(input: EvidenceInput, insideFiles: readonly string[], isPlan: (relative: string) => boolean): Phase | null {
    if (input.prUrls.length > 0) return REVIEW_PHASE;
    if (input.committed || insideFiles.some(file => !isPlan(file))) return WORK_PHASE;
    return insideFiles.length > 0 ? PLAN_PHASE : null;
}

/** One tool batch's evidence, and the phase it proves, as one transaction. */
export function recordEvidence(db: Ledger, input: EvidenceInput): TaskRow {
    return write(db, () => {
        const task = getTask(db, input.taskId);
        if (!task) throw new Error(`Task ${formatTaskId(input.taskId)} not found`);
        const at = nowIso();
        const common = { taskId: task.id, source: input.source, sessionId: input.sessionId };
        if (input.files.length > 0) recordEvent(db, { ...common, kind: 'progress', payload: { files: input.files } }, at);
        if (input.committed) recordEvent(db, { ...common, kind: 'commit', payload: {} }, at);
        for (const url of input.prUrls) recordEvent(db, { ...common, kind: 'pr', payload: { url } }, at);

        const root = getWorkspace(db, input.workspaceId)?.path ?? input.cwd;
        const globs = readSetting(db, input.workspaceId, SETTING_PLAN_GLOBS);
        const insideFiles = input.files.flatMap(file => relativeToRoot(root, input.cwd, file) ?? []);
        const target = evidencePhase(input, insideFiles, relative => matchesAnyGlob(relative, globs));
        if (target !== null) {
            advancePhase(db, task, target, { source: input.source, sessionId: input.sessionId, human: false }, at);
        }
        bumpRevision(db, task.id, at);
        const recorded = getTask(db, task.id)!;
        // Spec §8.2 promote: the first commit or PR publishes a task that was not pushed yet.
        if (input.committed || input.prUrls.length > 0) projectTask(db, recorded, 'evidence', at);
        return recorded;
    });
}

/** What counts as delivered work: a commit, or a pull request. */
const DELIVERY_KINDS: readonly EventKind[] = ['commit', 'pr'];
const PHASE_KIND: EventKind = 'phase';

export interface VerifiedInput {
    taskId: number;
    sessionId: string;
    source: string;
    /** What Claude checked: the tests or build it ran and their result. Recorded and posted as the task's comment. */
    verified: string;
}

export interface VerifiedResult {
    task: TaskRow;
    /** False when the task already was in_review: only the verification was recorded. */
    moved: boolean;
}

/** Whether the task has a commit or PR recorded since it last left done or dropped (older work was already delivered). */
function hasDeliverySinceReopen(db: Ledger, taskId: number): boolean {
    const closed = Array.from(CLOSED_PHASES);
    return db.prepare(`
        SELECT 1 FROM events
        WHERE task_id = ? AND kind IN (${DELIVERY_KINDS.map(() => '?').join(', ')})
          AND seq > COALESCE((
              SELECT MAX(seq) FROM events
              WHERE task_id = ? AND kind = ? AND json_extract(payload, '$.from') IN (${closed.map(() => '?').join(', ')})), 0)
        LIMIT 1`)
        .get(taskId, ...DELIVERY_KINDS, taskId, PHASE_KIND, ...closed) !== undefined;
}

/**
 * Claude's own move of verified work to in_review, allowed only when every guard holds, so nothing moves by accident:
 * completion is review for the task's workspace, the task is the one this session works on, it is open, it has a
 * commit or PR since it was last reopened, and the verification says what was checked. Not a human change: a later
 * edit by a person, or a merged PR, still moves it on.
 */
export function markVerified(db: Ledger, input: VerifiedInput): VerifiedResult {
    return write(db, () => {
        const task = getTask(db, input.taskId);
        if (!task) throw new Error(`Task ${formatTaskId(input.taskId)} not found`);
        const id = formatTaskId(task.id);
        const verified = input.verified.trim();
        if (verified.length === 0) throw new Error('verified must say what you checked (the tests or build you ran, and their result).');
        if (completionOf(db, task) !== COMPLETION_REVIEW) {
            throw new Error(`completion is ${COMPLETION_ASK} for ${id}'s workspace: change its phase only when the user asks.`);
        }
        if (getSession(db, input.sessionId)?.task_id !== task.id) {
            throw new Error(`${id} is not the task this session works on: only the session's own task can be marked verified. Ask the user.`);
        }
        if (CLOSED_PHASES.has(task.phase)) throw new Error(`${id} is ${task.phase}: verified work goes to ${VERIFIED_PHASE} only from an open phase.`);
        if (!hasDeliverySinceReopen(db, task.id)) {
            throw new Error(`${id} has no commit or PR recorded yet: commit the verified work first, then mark it verified.`);
        }
        const at = nowIso();
        const ctx: ChangeContext = { source: input.source, sessionId: input.sessionId, human: false };
        const moved = advancePhase(db, task, VERIFIED_PHASE, ctx, at);
        if (!moved && task.phase !== VERIFIED_PHASE) {
            throw new Error(`${id} was not moved to ${VERIFIED_PHASE}: the user changed its phase after this evidence. Ask the user.`);
        }
        bumpRevision(db, task.id, at);
        recordComment(db, getTask(db, task.id)!, `${VERIFIED_PREFIX}${verified}`, ctx, at);
        return { task: getTask(db, task.id)!, moved };
    });
}
