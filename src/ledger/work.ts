import * as path from 'path';
import { Ledger, write, nowIso } from './db';
import { recordEvent } from './events';
import { applyPhaseChange, bumpRevision, getTask, insertTaskRow, resolveTaskRef, ChangeContext } from './tasks';
import { setSessionTask } from './sessions';
import { readSetting, SETTING_PLAN_GLOBS } from './settings';
import { getWorkspace } from './workspaces';
import { matchesAnyGlob } from './glob';
import { INTENT_PHASE, Intent, Phase, TaskRow, formatTaskId } from './types';

/** Forward order for automatic phase moves; done and dropped are terminal. */
const PHASE_RANK: Record<Phase, number> = { brainstorming: 0, planned: 1, in_progress: 2, in_review: 3, done: 4, dropped: 4 };
export const CLOSED_PHASES: ReadonlySet<Phase> = new Set<Phase>(['done', 'dropped']);
/** Spec §7.3: attaching new work to a done or dropped task reopens it in this phase. */
export const REOPEN_PHASE: Phase = 'in_progress';
const PLAN_PHASE: Phase = 'planned';
const WORK_PHASE: Phase = 'in_progress';
const REVIEW_PHASE: Phase = 'in_review';
const PARENT_SEGMENT = '..';

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
        // OR IGNORE: a link that collides with one the kept task already has stays behind,
        // so Phase 3 can close that remote item as a duplicate.
        db.prepare('UPDATE OR IGNORE vendor_links SET task_id = ? WHERE task_id = ?').run(into.id, from.id);
        db.prepare('UPDATE sessions SET task_id = ? WHERE task_id = ?').run(into.id, from.id);

        if (from.phase !== MERGED_PHASE) applyPhaseChange(db, from, MERGED_PHASE, ctx, at);
        recordEvent(db, { taskId: into.id, kind: 'merged', source: input.source, sessionId: input.sessionId, payload: { from: from.id } }, at);
        recordEvent(db, { taskId: from.id, kind: 'merged', source: input.source, sessionId: input.sessionId, payload: { into: into.id } }, at);
        bumpRevision(db, from.id, at);
        bumpRevision(db, into.id, at);

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

function isPlanFile(root: string, cwd: string, file: string, globs: readonly string[]): boolean {
    const relative = path.relative(root, path.resolve(cwd, file));
    if (relative.startsWith(PARENT_SEGMENT) || path.isAbsolute(relative)) return false;
    return matchesAnyGlob(relative, globs);
}

/** Spec §7.3 table, strongest evidence first. */
function evidencePhase(input: EvidenceInput, isPlan: (file: string) => boolean): Phase | null {
    if (input.prUrls.length > 0) return REVIEW_PHASE;
    if (input.committed || input.files.some(file => !isPlan(file))) return WORK_PHASE;
    return input.files.length > 0 ? PLAN_PHASE : null;
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
        const target = evidencePhase(input, file => isPlanFile(root, input.cwd, file, globs));
        if (target !== null) {
            advancePhase(db, task, target, { source: input.source, sessionId: input.sessionId, human: false }, at);
        }
        bumpRevision(db, task.id, at);
        return getTask(db, task.id)!;
    });
}
