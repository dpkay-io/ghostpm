import { Ledger, MS_PER_HOUR } from '../ledger/db';
import { listEvents } from '../ledger/events';
import { getTask } from '../ledger/tasks';
import { getWorkspace } from '../ledger/workspaces';
import { formatTaskId, plural } from '../ledger/types';
import { FLAG_SINCE } from '../cli-args';
import { eventDetail, eventFiles } from './render-event';
import { cleanText, formatDateTime, workspaceLabel } from './text';

export const DEFAULT_STANDUP_HOURS = 24;
/** Reads every event in the window; this only bounds a runaway week, and hitting it is reported. */
export const STANDUP_EVENT_LIMIT = 10000;
const TASK_INDENT = '  ';
const ITEM_PREFIX = '    - ';
/** Map key for events whose task has no workspace. */
const NO_WORKSPACE_KEY = -1;

interface TaskActivity {
    taskId: number;
    title: string;
    lastSeq: number;
    details: string[];
    files: string[];
    commits: number;
}

export function defaultStandupSince(now: number = Date.now()): Date {
    return new Date(now - DEFAULT_STANDUP_HOURS * MS_PER_HOUR);
}

/** Spec §9.4: tasks touched, phase changes, commits and PRs, grouped by workspace. No LLM: every word comes from events. */
export function buildStandup(db: Ledger, since: Date): string {
    const header = `Standup since ${formatDateTime(since)}`;
    const entries = listEvents(db, { since: since.toISOString(), limit: STANDUP_EVENT_LIMIT });
    const labels = new Map<number, string>();
    const byWorkspace = new Map<number, Map<number, TaskActivity>>();

    for (const entry of entries) {
        if (entry.task_id === null) continue;
        const key = entry.workspace_id ?? NO_WORKSPACE_KEY;
        if (!labels.has(key)) labels.set(key, cleanText(workspaceLabel(entry.workspace_id === null ? null : getWorkspace(db, entry.workspace_id)?.path)));
        const tasks = byWorkspace.get(key) ?? new Map<number, TaskActivity>();
        byWorkspace.set(key, tasks);
        const activity = tasks.get(entry.task_id)
            ?? { taskId: entry.task_id, title: entry.title ?? '', lastSeq: entry.seq, details: [], files: [], commits: 0 };
        tasks.set(entry.task_id, activity);
        activity.lastSeq = entry.seq;

        const files = eventFiles(entry);
        if (entry.kind === 'commit') {
            activity.commits++;
        } else if (files.length > 0) {
            files.forEach(file => { if (activity.files.indexOf(file) < 0) activity.files.push(file); });
        } else {
            const detail = cleanText(eventDetail(entry));
            if (activity.details.indexOf(detail) < 0) activity.details.push(detail);
        }
    }
    if (byWorkspace.size === 0) return `${header}\n\nNothing recorded.`;

    const body: string[] = [];
    let taskCount = 0;
    const keys = Array.from(byWorkspace.keys()).sort((a, b) => labels.get(a)!.localeCompare(labels.get(b)!));
    keys.forEach(key => {
        const tasks = Array.from(byWorkspace.get(key)!.values()).sort((a, b) => b.lastSeq - a.lastSeq);
        taskCount += tasks.length;
        body.push('', labels.get(key)!);
        tasks.forEach(activity => {
            const task = getTask(db, activity.taskId);
            body.push(`${TASK_INDENT}${formatTaskId(activity.taskId)} ${cleanText(task ? `${task.title} · ${task.phase}` : activity.title)}`);
            activity.details.forEach(detail => body.push(`${ITEM_PREFIX}${detail}`));
            if (activity.files.length > 0) body.push(`${ITEM_PREFIX}edited ${plural(activity.files.length, 'file')}`);
            if (activity.commits > 0) body.push(`${ITEM_PREFIX}${plural(activity.commits, 'commit')}`);
        });
    });
    const lines = [header, `${plural(taskCount, 'task')} in ${plural(byWorkspace.size, 'workspace')}`].concat(body);
    if (entries.length >= STANDUP_EVENT_LIMIT) lines.push('', `Showing the most recent ${STANDUP_EVENT_LIMIT} events; narrow ${FLAG_SINCE} to see earlier ones.`);
    return lines.join('\n');
}
