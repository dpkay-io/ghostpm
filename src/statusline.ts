import { spawnSync } from 'child_process';
import { Ledger, openLedgerReadOnly, schemaStatus } from './ledger/db';
import { getSession } from './ledger/sessions';
import { getSetting, SETTING_PREVIOUS_STATUSLINE } from './ledger/settings';
import { getTask } from './ledger/tasks';
import { SessionRow, formatTaskId } from './ledger/types';
import { getWorkspace } from './ledger/workspaces';
import { SYNC_OFF, syncOffReason, workspaceSyncHealth } from './surfaces/sync-health';
import { cleanText, truncate } from './surfaces/text';

export const SEPARATOR = ' │ ';
export const TASK_MARKER = '▶';
export const WARNING_MARKER = '⚠';
/** Shown when this copy is older than the ledger: capture has stopped, and this is the one place a user will see that. */
export const UPDATE_HINT = `${WARNING_MARKER} update GhostPM: the ledger is newer than this copy`;
const PAUSE_REASON_CHARS = 40;
const SEGMENT_GAP = ' ';
const SYNC_PAUSED = 'sync paused:';
/** After `⚠<failed>` where sync is off: nothing retries those pushes until a person turns sync on. */
const SYNC_OFF_NOTE = `sync ${SYNC_OFF}`;

/** Runs the statusline command that was configured before ghostpm chained itself in. */
export type RunPrevious = (command: string, input: string) => string;

export interface StatuslineOptions {
    stdin: string;
    previousCommand: string | null;
    run: RunPrevious;
}

export interface StatuslineRun {
    stdin: string;
    ledgerFile: string;
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

function taskSegment(db: Ledger, session: SessionRow | undefined): string {
    if (session === undefined || session.task_id === null) return '';
    const task = getTask(db, session.task_id);
    return task === undefined ? '' : `${TASK_MARKER} ${formatTaskId(task.id)} ${task.title} · ${task.phase}`;
}

/**
 * Spec §9.2 `⚠<failed>` plus the pause reason §12 asks for, scoped to the session's own workspace. Off comes
 * first, as describeSync says it: there no pause applies, and failures wait for a person to turn sync on.
 */
function warningSegment(db: Ledger, session: SessionRow | undefined): string {
    if (session === undefined || session.workspace_id === null) return '';
    const health = workspaceSyncHealth(db, session.workspace_id);
    if (health.failed === 0 && health.paused === null) return '';
    const workspace = getWorkspace(db, session.workspace_id);
    const off = workspace === undefined || syncOffReason(db, workspace) !== null;
    const parts: string[] = [];
    if (health.failed > 0) parts.push(`${WARNING_MARKER}${health.failed}${off ? `${SEGMENT_GAP}${SYNC_OFF_NOTE}` : ''}`);
    if (!off && health.paused !== null) {
        parts.push(`${WARNING_MARKER} ${SYNC_PAUSED} ${truncate(health.paused, PAUSE_REASON_CHARS)}`);
    }
    return parts.join(SEGMENT_GAP);
}

function ghostpmSegment(db: Ledger, stdin: string): string {
    const sessionId = sessionIdFrom(stdin);
    const session = sessionId.length === 0 ? undefined : getSession(db, sessionId);
    return cleanText([taskSegment(db, session), warningSegment(db, session)].filter(part => part.length > 0).join(SEGMENT_GAP));
}

function joinSegments(previous: string, ours: string): string {
    if (ours.length === 0) return previous;
    if (previous.length === 0) return ours;
    return `${previous}${SEPARATOR}${ours}`;
}

/**
 * The previous command is a shell string out of the user's own settings.json, which
 * Claude Code already runs through a shell; chaining preserves that trust boundary
 * rather than widening it (spec §8.9 bars building command strings from data we do
 * not control, which this is not). The one part of this path no test covers.
 */
export const runPreviousCommand: RunPrevious = (command, input) =>
    spawnSync(command, { shell: true, input, encoding: 'utf8' }).stdout ?? '';

/** One indexed lookup by session id, then `<previous output> │ ▶ T42 <title> · <phase> ⚠<failed>`. */
export function buildStatusline(db: Ledger, options: StatuslineOptions): string {
    return joinSegments(previousOutput(options), ghostpmSegment(db, options.stdin));
}

/** The settings table exists in every schema version, so the previous command stays readable when nothing else is. */
function readPreviousCommand(db: Ledger): string | null {
    try {
        return getSetting<string>(db, SETTING_PREVIOUS_STATUSLINE) ?? null;
    } catch {
        return null;
    }
}

function tryOpen(ledgerFile: string): Ledger | null {
    try {
        return openLedgerReadOnly(ledgerFile);
    } catch {
        return null;
    }
}

/**
 * The CLI entry. A ledger this copy cannot fully read must never cost the user their own
 * statusline: the previous command still comes out of `settings`, and the ghostpm segment
 * falls back to an update hint (newer schema) or to nothing (older schema, unreadable rows).
 */
export function runStatusline(options: StatuslineRun): string {
    const db = tryOpen(options.ledgerFile);
    // No ledger, or SQLite cannot load at all. The previous command lives in the ledger, so
    // there is nothing to chain. ponytail: mirror it outside the ledger if the missing-addon
    // window right after a fresh plugin install turns out to matter.
    if (db === null) return '';
    try {
        const previous = previousOutput({ stdin: options.stdin, previousCommand: readPreviousCommand(db), run: options.run });
        let ours = '';
        try {
            ours = schemaStatus(db) === 'newer' ? UPDATE_HINT : ghostpmSegment(db, options.stdin);
        } catch {
            // Not a database, or a ledger not yet migrated that lacks what the segment reads: `previous` still shows.
        }
        return joinSegments(previous, ours);
    } finally {
        db.close();
    }
}
