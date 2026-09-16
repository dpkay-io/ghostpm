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
