// Shared task columns and phase summary: the CLI tables and the MCP markdown cannot drift apart.
import { Ledger, schemaVersion } from '../ledger/db';
import { listLiveSessions } from '../ledger/sessions';
import {
    explainSetting, getWorkspaceSetting, readSetting, SETTING_ACTIVE_SPRINT, SETTING_CURRENT_USER, SETTING_LAST_SYNC,
    SETTING_STALE_SESSION_MINUTES, SETTING_SYNC_POLICY,
} from '../ledger/settings';
import { getVendorLink, listTasks } from '../ledger/tasks';
import { getWorkspace } from '../ledger/workspaces';
import { CLOSED_PHASES, PHASES, Phase, TaskRow, WorkspaceRow, formatTaskId } from '../ledger/types';
import { FLAG_ALL } from '../cli-args';
import { describeSync, machineSyncHealth } from './sync-health';
import { alignColumns, formatClock, formatDateTime, padRight, workspaceLabel } from './text';

/** The columns of every task table: the CLI list and the MCP query_tasks markdown. */
export const TASK_COLUMNS = ['id', 'phase', 'title', 'assignee', 'remote'] as const;
export type TaskColumn = typeof TASK_COLUMNS[number];
export const MAX_CELL_WIDTH = 50;
export const NOT_A_WORKSPACE =
    `This folder is not a GhostPM workspace yet: no session has run here. Run \`ghostpm init\` to register it, or \`ghostpm tasks ${FLAG_ALL}\` for every workspace.`;
const WORKSPACE_COLUMN = 'workspace';
const STATUS_LABEL_WIDTH = 11;
const NOT_DETECTED = '(not detected)';
const NONE = 'none';
const NEVER = 'never';

export function taskCell(db: Ledger, task: TaskRow, column: TaskColumn): string {
    switch (column) {
        case 'id': return formatTaskId(task.id);
        case 'phase': return task.phase;
        case 'title': return task.title;
        case 'assignee': return task.assignee ?? '';
        case 'remote': {
            const link = getVendorLink(db, task.id);
            return link ? `#${link.remote_id}` : '';
        }
    }
}

/** `2 planned, 1 in_progress`, in phase order. */
export function phaseSummary(tasks: TaskRow[]): string {
    const counts = new Map<Phase, number>();
    for (const task of tasks) counts.set(task.phase, (counts.get(task.phase) ?? 0) + 1);
    return PHASES.filter(phase => counts.has(phase)).map(phase => `${counts.get(phase)} ${phase}`).join(', ');
}

/** `ghostpm tasks`: open tasks, one aligned row each; `workspaceId` undefined means every workspace. */
export function renderTaskList(db: Ledger, workspaceId: number | undefined): string {
    const all = listTasks(db, { workspaceId });
    const open = all.filter(task => !CLOSED_PHASES.has(task.phase));
    const closed = all.length - open.length;
    const footer = closed > 0 ? `\n${closed} done or dropped not shown.` : '';
    if (open.length === 0) return `No open tasks.${footer}`;

    const everyWorkspace = workspaceId === undefined;
    const columns: string[] = TASK_COLUMNS.slice();
    if (everyWorkspace) columns.push(WORKSPACE_COLUMN);
    const rows = open.map(task => {
        const cells: string[] = TASK_COLUMNS.map(column => taskCell(db, task, column));
        if (everyWorkspace) cells.push(workspaceLabel(task.workspace_id === null ? null : getWorkspace(db, task.workspace_id)?.path));
        return cells;
    });
    return `${alignColumns([columns.map(column => column.toUpperCase())].concat(rows), MAX_CELL_WIDTH).join('\n')}${footer}`;
}

/** `ghostpm status`: everything about one workspace, read from the ledger alone. */
export function renderStatus(db: Ledger, workspace: WorkspaceRow, ledgerFile: string, now: number = Date.now()): string {
    const tasks = listTasks(db, { workspaceId: workspace.id });
    const summary = phaseSummary(tasks);
    const staleMinutes = readSetting(db, workspace.id, SETTING_STALE_SESSION_MINUTES);
    const live = listLiveSessions(db, staleMinutes, now).filter(session => session.workspace_id === workspace.id).length;
    const runner = machineSyncHealth(db, new Date(now).toISOString()).runner;
    const policy = explainSetting(db, workspace.id, SETTING_SYNC_POLICY);
    const lastPull = getWorkspaceSetting<string>(db, workspace.id, SETTING_LAST_SYNC);
    const rows: [string, string][] = [
        ['Workspace', workspace.path],
        ['Vendor', workspace.git_remote ? `${workspace.vendor} (${workspace.git_remote})` : workspace.vendor],
        ['User', getWorkspaceSetting<string>(db, workspace.id, SETTING_CURRENT_USER) ?? NOT_DETECTED],
        ['Sprint', getWorkspaceSetting<string>(db, workspace.id, SETTING_ACTIVE_SPRINT) ?? NONE],
        ['Tasks', `${tasks.length} total${summary ? ` (${summary})` : ''}`],
        ['Sessions', `${live} live here`],
        ['Policy', `${policy.value} (${policy.source})`],
        ['Sync', describeSync(db, workspace)],
        ['Last pull', lastPull ? formatDateTime(new Date(lastPull)) : NEVER],
        ['Runner', runner ? `${runner.holder} until ${formatClock(new Date(runner.expiresAt))}` : NONE],
        ['Ledger', `${ledgerFile} (schema ${schemaVersion(db)})`],
    ];
    return rows.map(([label, value]) => `${padRight(`${label}:`, STATUS_LABEL_WIDTH)}${value}`).join('\n');
}
