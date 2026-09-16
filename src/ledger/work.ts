import { Ledger, write, nowIso } from './db';
import { recordEvent } from './events';
import { applyPhaseChange, bumpRevision, getTask, insertTaskRow, resolveTaskRef, ChangeContext } from './tasks';
import { setSessionTask } from './sessions';
import { INTENT_PHASE, Intent, Phase, TaskRow } from './types';

/** Forward order for automatic phase moves; done and dropped are terminal. */
const PHASE_RANK: Record<Phase, number> = { brainstorming: 0, planned: 1, in_progress: 2, in_review: 3, done: 4, dropped: 4 };
const CLOSED_PHASES: ReadonlySet<Phase> = new Set<Phase>(['done', 'dropped']);
/** Spec §7.3: attaching new work to a done or dropped task reopens it in this phase. */
export const REOPEN_PHASE: Phase = 'in_progress';

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
        } else if (PHASE_RANK[intentPhase] > PHASE_RANK[existing.phase]) {
            applyPhaseChange(db, existing, intentPhase, ctx, at);
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
