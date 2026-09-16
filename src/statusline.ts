import { spawnSync } from 'child_process';
import { Ledger } from './ledger/db';
import { getSession } from './ledger/sessions';
import { getTask } from './ledger/tasks';
import { formatTaskId } from './ledger/types';

export const SEPARATOR = ' │ ';
export const TASK_MARKER = '▶';

/** Runs the statusline command that was configured before ghostpm chained itself in. */
export type RunPrevious = (command: string, input: string) => string;

export interface StatuslineOptions {
    stdin: string;
    previousCommand: string | null;
    run: RunPrevious;
}

const BOM = /^﻿/;

function sessionIdFrom(stdin: string): string {
    try {
        const parsed = JSON.parse(stdin.replace(BOM, ''));
        const id = parsed === null ? undefined : parsed.session_id;
        return typeof id === 'string' ? id : '';
    } catch {
        return '';
    }
}

/** A previous command that is missing, broken or silent must not cost the user their statusline. */
function previousOutput(options: StatuslineOptions): string {
    if (options.previousCommand === null) return '';
    try {
        return options.run(options.previousCommand, options.stdin).trim();
    } catch {
        return '';
    }
}

function taskSegment(db: Ledger, sessionId: string): string {
    if (sessionId.length === 0) return '';
    const taskId = getSession(db, sessionId)?.task_id ?? null;
    if (taskId === null) return '';
    const task = getTask(db, taskId);
    return task === undefined
        ? ''
        : `${TASK_MARKER} ${formatTaskId(task.id)} ${task.title} · ${task.phase}`;
}

/**
 * The previous command is a shell string out of the user's own settings.json, which
 * Claude Code already runs through a shell; chaining preserves that trust boundary
 * rather than widening it (spec §8.9 bars building command strings from data we do
 * not control, which this is not). The one part of this path no test covers.
 */
export const runPreviousCommand: RunPrevious = (command, input) =>
    spawnSync(command, { shell: true, input, encoding: 'utf8' }).stdout ?? '';

/** One indexed lookup by session id, then `<previous output> │ ▶ T42 <title> · <phase>`. */
export function buildStatusline(db: Ledger, options: StatuslineOptions): string {
    const previous = previousOutput(options);
    const segment = taskSegment(db, sessionIdFrom(options.stdin));
    if (segment.length === 0) return previous;
    if (previous.length === 0) return segment;
    return `${previous}${SEPARATOR}${segment}`;
}
