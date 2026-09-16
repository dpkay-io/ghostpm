import { Ledger, nowIso } from './db';
import { EventKind } from './types';

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
