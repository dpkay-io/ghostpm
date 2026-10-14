// src/surfaces/dashboard.ts
import { Ledger, MS_PER_HOUR, iso } from '../ledger/db';
import { listEvents, TimelineEntry } from '../ledger/events';
import { listLiveSessions } from '../ledger/sessions';
import { SETTING_STALE_SESSION_MINUTES, readSetting } from '../ledger/settings';
import { getTask } from '../ledger/tasks';
import { getWorkspace } from '../ledger/workspaces';
import { PHASES, Phase, Vendor, WorkspaceRow, formatTaskId } from '../ledger/types';
import { TASK_MARKER } from '../statusline';
import { eventDetail, eventTask } from './render-event';
import { MachineSyncHealth, SyncHealth, machineSyncHealth, syncDescription, workspaceSyncHealth } from './sync-health';
import { ANSI, ELLIPSIS, cleanText, formatClock, padLeft, padRight, truncate, workspaceLabel } from './text';

export const DASHBOARD_WINDOW_HOURS = 24;
export const RECENT_EVENTS = 12;
export const CROSS_MARKER = '⇄';
/** Bounds the cross-workspace scan on a pathological day; a normal day is far below it. */
const CROSS_SCAN_LIMIT = 2000;
const INDENT = '  ';
const NAME_WIDTH = 20;
const CLIENT_WIDTH = 12;
const COUNT_WIDTH = 6;
/** Wide enough for `99 pending · 99 failed`; a longer state only pushes the counts, which are cut first. */
const SYNC_WIDTH = 22;
const MIN_NAME_WIDTH = 8;
/** The width the plain-text dashboard (pipes, the MCP tool) is laid out for. */
export const DEFAULT_COLUMNS = 80;
const MIN_SIZE = 1;
const NO_TASK = '(no task)';
const PHASE_LABELS: Record<Phase, string> = {
    brainstorming: 'brain', planned: 'plan', in_progress: 'prog', in_review: 'rev', done: 'done', dropped: 'drop',
};

export type Tone = 'title' | 'heading' | 'normal' | 'warn' | 'dim';

export interface DashboardLine {
    text: string;
    tone: Tone;
}

export interface ScreenSize {
    columns: number;
    rows: number;
}

export interface SessionView {
    client: string;
    workspace: string;
    task: string | null;
    lastSeenAt: string;
}

export interface WorkspaceView {
    label: string;
    vendor: Vendor;
    counts: Record<Phase, number>;
    sync: SyncHealth;
    /** Short state from syncDescription: off | ok | N pending · M failed | paused. */
    syncState: string;
    /** Why: the off reason or the pause reason. */
    syncDetail: string | null;
    lastActivityAt: string;
}

export interface CrossWorkspaceView {
    taskId: number;
    title: string;
    owner: string;
    from: string[];
}

export interface DashboardSnapshot {
    at: string;
    sessions: SessionView[];
    workspaces: WorkspaceView[];
    /** Workspaces with no tasks and no live session: counted, not listed. */
    hiddenWorkspaces: number;
    machine: MachineSyncHealth;
    crossWorkspace: CrossWorkspaceView[];
    /** Newest first. */
    recent: TimelineEntry[];
}

export interface SnapshotOptions {
    now?: number;
}

function emptyCounts(): Record<Phase, number> {
    const counts = {} as Record<Phase, number>;
    PHASES.forEach(phase => { counts[phase] = 0; });
    return counts;
}

function later(a: string, b: string): string {
    return a > b ? a : b;
}

export function buildSnapshot(db: Ledger, options: SnapshotOptions = {}): DashboardSnapshot {
    const now = options.now ?? Date.now();
    const at = iso(now);
    const since = iso(now - DASHBOARD_WINDOW_HOURS * MS_PER_HOUR);
    // One read transaction, so every section describes the same instant. In WAL mode a
    // reader never waits for a writer (verified: a read took 0 ms while another process held
    // BEGIN IMMEDIATE), so this cannot stall behind a hook or the sync runner.
    return db.transaction((): DashboardSnapshot => {
        const rows = new Map<number, WorkspaceRow | undefined>();
        const workspaceRow = (id: number | null): WorkspaceRow | undefined => {
            if (id === null) return undefined;
            if (!rows.has(id)) rows.set(id, getWorkspace(db, id));
            return rows.get(id);
        };
        const label = (id: number | null): string => workspaceLabel(workspaceRow(id)?.path);

        const staleMinutes = readSetting(db, null, SETTING_STALE_SESSION_MINUTES);
        const live = listLiveSessions(db, staleMinutes, now);
        const sessions: SessionView[] = live.map(session => {
            const task = session.task_id === null ? undefined : getTask(db, session.task_id);
            return {
                client: session.client,
                workspace: label(session.workspace_id),
                task: task ? `${formatTaskId(task.id)} ${task.title} · ${task.phase}` : null,
                lastSeenAt: session.last_seen_at,
            };
        });

        const activity = new Map<number, { counts: Record<Phase, number>; lastActivityAt: string }>();
        const touch = (id: number, when: string) => {
            const entry = activity.get(id) ?? { counts: emptyCounts(), lastActivityAt: '' };
            entry.lastActivityAt = later(entry.lastActivityAt, when);
            activity.set(id, entry);
            return entry;
        };
        const grid = db.prepare(`
            SELECT workspace_id AS id, phase, COUNT(*) AS n, MAX(updated_at) AS last
            FROM tasks WHERE workspace_id IS NOT NULL
            GROUP BY workspace_id, phase`).all() as { id: number; phase: Phase; n: number; last: string }[];
        grid.forEach(row => { touch(row.id, row.last).counts[row.phase] = row.n; });
        live.forEach(session => { if (session.workspace_id !== null) touch(session.workspace_id, session.last_seen_at); });

        const workspaces: WorkspaceView[] = [];
        activity.forEach((entry, id) => {
            const row = workspaceRow(id);
            if (row === undefined) return;
            const sync = workspaceSyncHealth(db, id);
            const { state, detail } = syncDescription(db, row, sync);
            workspaces.push({
                label: label(id), vendor: row.vendor, counts: entry.counts,
                sync, syncState: state, syncDetail: detail, lastActivityAt: entry.lastActivityAt,
            });
        });
        workspaces.sort((a, b) => (a.lastActivityAt === b.lastActivityAt ? 0 : a.lastActivityAt < b.lastActivityAt ? 1 : -1));
        const total = (db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n;

        const crossByTask = new Map<number, CrossWorkspaceView>();
        listEvents(db, { since, crossWorkspaceOnly: true, limit: CROSS_SCAN_LIMIT }).forEach(entry => {
            if (entry.task_id === null) return;
            const view = crossByTask.get(entry.task_id)
                ?? { taskId: entry.task_id, title: entry.title ?? '', owner: label(entry.workspace_id), from: [] };
            const from = label(entry.session_workspace_id);
            if (view.from.indexOf(from) < 0) view.from.push(from);
            crossByTask.set(entry.task_id, view);
        });

        return {
            at,
            sessions,
            workspaces,
            hiddenWorkspaces: total - workspaces.length,
            machine: machineSyncHealth(db, at),
            crossWorkspace: Array.from(crossByTask.values()),
            recent: listEvents(db, { since, limit: RECENT_EVENTS }).reverse(),
        };
    })();
}

function isCross(entry: TimelineEntry): boolean {
    return entry.workspace_id !== null && entry.session_workspace_id !== null && entry.workspace_id !== entry.session_workspace_id;
}

function describeMachine(machine: MachineSyncHealth): string {
    const runner = machine.runner ? `runner ${machine.runner.holder} until ${formatClock(new Date(machine.runner.expiresAt))}` : 'no sync runner';
    const queue = machine.pending + machine.failed === 0 ? 'nothing queued' : `${machine.pending} pending · ${machine.failed} failed`;
    return `${runner} · ${queue}`;
}

/** §9.3 sections as lines of plain text. Colour, width and height are applied later. */
export function renderDashboard(snapshot: DashboardSnapshot, columns: number = DEFAULT_COLUMNS): DashboardLine[] {
    const lines: DashboardLine[] = [];
    const add = (text: string, tone: Tone = 'normal'): void => { lines.push({ text: cleanText(text), tone }); };

    add(`GhostPM · ${formatClock(new Date(snapshot.at))} · ${describeMachine(snapshot.machine)}`, snapshot.machine.failed > 0 ? 'warn' : 'title');
    add('');

    add(`LIVE SESSIONS (${snapshot.sessions.length})`, 'heading');
    if (snapshot.sessions.length === 0) add(`${INDENT}none`, 'dim');
    snapshot.sessions.forEach(session => add(
        `${INDENT}${padRight(session.client, CLIENT_WIDTH)} ${padRight(truncate(session.workspace, NAME_WIDTH), NAME_WIDTH)} `
        + `${formatClock(new Date(session.lastSeenAt))}  ${session.task ? `${TASK_MARKER} ${session.task}` : NO_TASK}`,
    ));
    add('');

    // Name, then SYNC, then the counts: on a narrow screen the counts are what gets cut.
    const nameWidth = Math.max(MIN_NAME_WIDTH, Math.min(NAME_WIDTH, columns - INDENT.length - 1 - SYNC_WIDTH - PHASES.length * COUNT_WIDTH));
    add(`${INDENT}${padRight('TASKS', nameWidth)} ${padRight('SYNC', SYNC_WIDTH)}${PHASES.map(phase => padLeft(PHASE_LABELS[phase], COUNT_WIDTH)).join('')}`, 'heading');
    if (snapshot.workspaces.length === 0) add(`${INDENT}no tasks yet`, 'dim');
    snapshot.workspaces.forEach(workspace => {
        const warn = workspace.sync.failed > 0 || workspace.sync.paused !== null;
        add(`${INDENT}${padRight(truncate(workspace.label, nameWidth), nameWidth)} ${padRight(workspace.syncState, SYNC_WIDTH)}`
            + `${PHASES.map(phase => padLeft(String(workspace.counts[phase]), COUNT_WIDTH)).join('')}`, warn ? 'warn' : 'normal');
    });
    snapshot.workspaces.forEach(workspace => {
        if (workspace.syncDetail !== null) add(`${INDENT}${workspace.label}: ${workspace.syncDetail}`, workspace.sync.paused !== null ? 'warn' : 'dim');
    });
    if (snapshot.hiddenWorkspaces > 0) add(`${INDENT}+${snapshot.hiddenWorkspaces} workspace(s) with no tasks and no live session`, 'dim');

    if (snapshot.crossWorkspace.length > 0) {
        add('');
        add(`CROSS-WORKSPACE (last ${DASHBOARD_WINDOW_HOURS}h)`, 'heading');
        snapshot.crossWorkspace.forEach(view => add(
            `${INDENT}${CROSS_MARKER} ${formatTaskId(view.taskId)} ${view.title} (${view.owner}) ← ${view.from.join(', ')}`, 'warn'));
    }

    add('');
    add(`RECENT (last ${DASHBOARD_WINDOW_HOURS}h)`, 'heading');
    if (snapshot.recent.length === 0) add(`${INDENT}nothing recorded`, 'dim');
    snapshot.recent.forEach(entry => {
        const cross = isCross(entry);
        add(`${INDENT}${formatClock(new Date(entry.at))} ${cross ? `${CROSS_MARKER} ` : ''}${eventTask(entry)}${eventDetail(entry)}`, cross ? 'warn' : 'normal');
    });
    return lines;
}

/** Every line within `columns`, the frame within `rows`; the last row says how much did not fit. */
export function fitToScreen(lines: DashboardLine[], size: ScreenSize): DashboardLine[] {
    const width = Math.max(MIN_SIZE, size.columns);
    const height = Math.max(MIN_SIZE, size.rows);
    const fitted = lines.map(line => ({ text: truncate(line.text, width), tone: line.tone }));
    if (fitted.length <= height) return fitted;
    const kept = fitted.slice(0, height - 1);
    kept.push({ text: truncate(`${ELLIPSIS} ${fitted.length - kept.length} more lines: enlarge the terminal`, width), tone: 'dim' });
    return kept;
}

const TONE_STYLE: Record<Tone, string> = {
    title: ANSI.bold,
    heading: `${ANSI.bold}${ANSI.cyan}`,
    normal: '',
    warn: ANSI.yellow,
    dim: ANSI.dim,
};

export function paint(line: DashboardLine, color: boolean): string {
    const style = TONE_STYLE[line.tone];
    if (!color || style.length === 0 || line.text.length === 0) return line.text;
    return `${style}${line.text}${ANSI.reset}`;
}

/** Plain text, no colour and no fitting: for pipes and for the MCP tool. */
export function dashboardText(db: Ledger, options: SnapshotOptions = {}): string {
    return renderDashboard(buildSnapshot(db, options)).map(line => line.text).join('\n');
}
