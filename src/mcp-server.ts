#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import { Ledger, openLedger } from "./ledger/db";
import { ensureWorkspace } from "./ledger/workspaces";
import { getTask, getVendorLink, listTasks, resolveTaskRef } from "./ledger/tasks";
import { listEvents } from "./ledger/events";
import {
    DEFAULT_STALE_SESSION_MINUTES, MCP_CLIENT, endSession, getSession, listLiveSessions,
    mcpSessionId, startSession, touchSession,
} from "./ledger/sessions";
import {
    SETTING_ACTIVE_SPRINT, SETTING_CURRENT_USER, SETTING_STALE_SESSION_MINUTES,
    getWorkspaceSetting, resolveSetting, setWorkspaceSetting,
} from "./ledger/settings";
import { runLegacyImportOnce } from "./ledger/legacy-import";
import { PHASES, Phase, TaskRow, WorkspaceRow, formatTaskId } from "./ledger/types";

const execFileAsync = promisify(execFile);

export const SERVER_NAME = "ghostpm";
export const SERVER_VERSION = "2.0.0";
export const ALL_SPRINTS = "all";
export const CLEAR_SPRINT = "__clear__";
export const CURRENT_USER_REF = "@me";

const TASK_COLUMNS = ["id", "phase", "title", "assignee", "remote"] as const;
type TaskColumn = typeof TASK_COLUMNS[number];
const BRANCH_TASK = /^task\/(.+)$/;
const UNKNOWN = "_unknown_";
const NONE_SET = "_none set_";

const SERVER_INSTRUCTIONS = `You have access to GhostPM — a local-first task log shared by every session on this machine.

## When to use

- The user asks about tasks, issues, work items, tickets, bugs, backlog, sprint or project status
- The user names a task (T42, #42, 42)
- Before starting development work: check what is already tracked

## Reading

1. \`get_project_state\` — workspace, user, sprint, branch, active task, counts, live sessions, pending sync. Call it first in a session.
2. \`set_sprint\` — activate a milestone; omit the name to list them; '${CLEAR_SPRINT}' unsets it.
3. \`query_tasks\` — markdown table. Defaults to the active sprint and this workspace; supports sprint='${ALL_SPRINTS}', assignee='${CURRENT_USER_REF}', phase and all_workspaces.
4. \`get_task\` — full details, vendor link and comments.
5. \`open_attachment\` — open a URL in the user's browser.

## Important

- Task ids are local: T42. \`#42\` or a bare \`42\` means the vendor's id in the current workspace.
- Phases are: ${PHASES.join(', ')}.
- Everything is read from the local ledger; reading never calls GitHub or Azure DevOps.
- Do NOT ask the user to install or configure anything — GhostPM is already set up.
- Show results directly rather than describing what you are about to do.`;

export interface PmServerOptions {
    db?: Ledger;
    cwd?: string;
    sessionId?: string;
    /** Import legacy per-repo databases on start. Tests disable this. */
    legacyImport?: boolean;
}

interface ToolResult {
    [key: string]: unknown;
    content: { type: "text"; text: string }[];
    isError?: boolean;
}

const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });

export class PmServer {
    private readonly server: McpServer;
    private readonly db: Ledger;
    private readonly cwd: string;
    private readonly sessionId: string;
    private readonly legacyImport: boolean;

    constructor(options: PmServerOptions = {}) {
        this.server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
        this.db = options.db ?? openLedger();
        this.cwd = options.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
        this.sessionId = options.sessionId ?? mcpSessionId();
        this.legacyImport = options.legacyImport ?? true;
        startSession(this.db, {
            id: this.sessionId,
            client: MCP_CLIENT,
            cwd: this.cwd,
            workspaceId: ensureWorkspace(this.db, this.cwd).id,
        });
        this.registerTools();
    }

    /** Heartbeat plus the workspace every tool call works against. */
    private context(): WorkspaceRow {
        const workspace = ensureWorkspace(this.db, this.cwd);
        touchSession(this.db, { id: this.sessionId, client: MCP_CLIENT, cwd: this.cwd, workspaceId: workspace.id });
        return workspace;
    }

    private async currentBranch(): Promise<string | null> {
        try {
            // execFile's util.promisify.custom resolves { stdout, stderr }; a plain jest.fn()
            // mock of child_process (no custom symbol) resolves the raw stdout string instead.
            const result = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.cwd });
            const stdout = typeof result === 'string' ? result : result.stdout;
            return stdout.trim();
        } catch {
            return null;
        }
    }

    /** The session's task, or the task named by a task/<ref> branch. */
    private activeTask(branch: string | null, workspaceId: number): TaskRow | undefined {
        const sessionTaskId = getSession(this.db, this.sessionId)?.task_id ?? null;
        if (sessionTaskId !== null) return getTask(this.db, sessionTaskId);
        const match = branch === null ? null : branch.match(BRANCH_TASK);
        return match ? resolveTaskRef(this.db, match[1], workspaceId) : undefined;
    }

    private phaseSummary(tasks: TaskRow[]): string {
        const counts = new Map<Phase, number>();
        for (const task of tasks) counts.set(task.phase, (counts.get(task.phase) ?? 0) + 1);
        return PHASES.filter(phase => counts.has(phase)).map(phase => `${counts.get(phase)} ${phase}`).join(', ');
    }

    private cell(task: TaskRow, column: TaskColumn): string {
        switch (column) {
            case 'id': return formatTaskId(task.id);
            case 'phase': return task.phase;
            case 'title': return task.title;
            case 'assignee': return task.assignee ?? '';
            case 'remote': {
                const link = getVendorLink(this.db, task.id);
                return link ? `#${link.remote_id}` : '';
            }
        }
    }

    private renderTable(tasks: TaskRow[]): string {
        const header = `| ${TASK_COLUMNS.join(' | ')} |\n| ${TASK_COLUMNS.map(() => '---').join(' | ')} |\n`;
        const rows = tasks.map(task => `| ${TASK_COLUMNS.map(column => this.cell(task, column).replace(/\|/g, '\\|')).join(' | ')} |`);
        return `${header}${rows.join('\n')}\n`;
    }

    private sprintsOf(workspaceId: number): string[] {
        const milestones = listTasks(this.db, { workspaceId })
            .map(task => task.milestone)
            .filter((milestone): milestone is string => milestone !== null && milestone !== '');
        return Array.from(new Set(milestones)).sort();
    }

    private registerTools(): void {
        this.server.tool(
            "get_project_state",
            "Current workspace, user, sprint, branch, active task, task counts, live sessions and pending sync work. Call this first in a session.",
            {},
            async () => {
                const workspace = this.context();
                const branch = await this.currentBranch();
                const active = this.activeTask(branch, workspace.id);
                const tasks = listTasks(this.db, { workspaceId: workspace.id });
                const summary = this.phaseSummary(tasks);
                const staleMinutes = resolveSetting(this.db, workspace.id, SETTING_STALE_SESSION_MINUTES, DEFAULT_STALE_SESSION_MINUTES);
                const outbox = this.db.prepare('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status ORDER BY status')
                    .all() as { status: string; n: number }[];
                return text([
                    `**Workspace:** ${workspace.path} (vendor: ${workspace.vendor})`,
                    `**User:** ${getWorkspaceSetting<string>(this.db, workspace.id, SETTING_CURRENT_USER) ?? UNKNOWN}`,
                    `**Active Sprint:** ${getWorkspaceSetting<string>(this.db, workspace.id, SETTING_ACTIVE_SPRINT) ?? NONE_SET}`,
                    `**Current Branch:** ${branch ?? UNKNOWN}`,
                    active ? `**Active Task:** ${formatTaskId(active.id)} ${active.title} · ${active.phase}` : '**Active Task:** _none_',
                    `**Tasks:** ${tasks.length} total${summary ? ` — ${summary}` : ''}`,
                    `**Live Sessions:** ${listLiveSessions(this.db, staleMinutes).length}`,
                    `**Outbox:** ${outbox.length > 0 ? outbox.map(row => `${row.n} ${row.status}`).join(', ') : 'empty'}`,
                ].join('\n'));
            },
        );

        this.server.tool(
            "set_sprint",
            "Activate a sprint/milestone for this workspace. Omit the name to list available sprints.",
            {
                sprint_name: z.string().optional().describe(`Milestone to activate. Omit to list; '${CLEAR_SPRINT}' clears it.`),
            },
            async ({ sprint_name }) => {
                const workspace = this.context();
                if (!sprint_name) {
                    const sprints = this.sprintsOf(workspace.id);
                    if (sprints.length === 0) return text('No sprints found in this workspace.');
                    const active = getWorkspaceSetting<string>(this.db, workspace.id, SETTING_ACTIVE_SPRINT);
                    return text(sprints.map(sprint => `${sprint === active ? '→ ' : '  '}${sprint}`).join('\n'));
                }
                if (sprint_name === CLEAR_SPRINT) {
                    setWorkspaceSetting(this.db, workspace.id, SETTING_ACTIVE_SPRINT, undefined);
                    return text('Active sprint cleared.');
                }
                setWorkspaceSetting(this.db, workspace.id, SETTING_ACTIVE_SPRINT, sprint_name);
                const count = listTasks(this.db, { workspaceId: workspace.id, milestone: sprint_name }).length;
                return text(`Active sprint set to **${sprint_name}** (${count} task${count === 1 ? '' : 's'}).`);
            },
        );

        this.server.tool(
            "query_tasks",
            "List tasks as a markdown table. Defaults to the active sprint and the current workspace.",
            {
                sprint: z.string().optional().describe(`Milestone filter. Defaults to the active sprint; '${ALL_SPRINTS}' ignores it.`),
                assignee: z.string().optional().describe(`Assignee filter. '${CURRENT_USER_REF}' resolves to the detected user.`),
                phase: z.enum(PHASES).optional().describe('Phase filter.'),
                all_workspaces: z.boolean().optional().describe('Include tasks from every workspace on this machine.'),
            },
            async ({ sprint, assignee, phase, all_workspaces }) => {
                const workspace = this.context();
                const activeSprint = getWorkspaceSetting<string>(this.db, workspace.id, SETTING_ACTIVE_SPRINT);
                const milestone = sprint === ALL_SPRINTS ? undefined : sprint ?? activeSprint;
                let resolvedAssignee = assignee;
                if (assignee === CURRENT_USER_REF) {
                    resolvedAssignee = getWorkspaceSetting<string>(this.db, workspace.id, SETTING_CURRENT_USER);
                    if (!resolvedAssignee) {
                        return text(`The current user is not detected for this workspace, so ${CURRENT_USER_REF} cannot be resolved.`);
                    }
                }
                const tasks = listTasks(this.db, {
                    workspaceId: all_workspaces ? undefined : workspace.id,
                    milestone,
                    assignee: resolvedAssignee,
                    phases: phase ? [phase] : undefined,
                });
                if (tasks.length === 0) return text('No tasks found.');
                return text(`${milestone ? `_Sprint: ${milestone}_\n\n` : ''}${this.renderTable(tasks)}`);
            },
        );

        this.server.tool(
            "get_task",
            "Full details of one task: phase, vendor link, description and comments.",
            {
                task_id: z.string().describe('T42 for a local id, or #42 / 42 for the vendor id in this workspace.'),
            },
            async ({ task_id }) => {
                const workspace = this.context();
                const task = resolveTaskRef(this.db, task_id, workspace.id);
                if (!task) return text(`Task ${task_id} not found.`);
                const link = getVendorLink(this.db, task.id);
                const comments = listEvents(this.db, { taskId: task.id, kinds: ['comment'] }).map(event => ({
                    at: event.at,
                    source: event.source,
                    text: (JSON.parse(event.payload ?? '{}') as { text?: string }).text ?? '',
                }));
                return text(JSON.stringify({
                    id: formatTaskId(task.id),
                    title: task.title,
                    phase: task.phase,
                    origin: task.origin,
                    workspace: workspace.path,
                    assignee: task.assignee,
                    milestone: task.milestone,
                    body: task.body,
                    vendor: link ? { vendor: link.vendor, id: link.remote_id, url: link.remote_url, state: link.remote_state } : null,
                    comments,
                }, null, 2));
            },
        );

        this.server.tool(
            "open_attachment",
            "Open a URL from a task in the user's local browser.",
            {
                url: z.string().url().describe('URL to open in the browser'),
            },
            async ({ url }) => {
                try {
                    let cmd: string;
                    let args: string[];
                    if (process.platform === "win32") {
                        cmd = "cmd";
                        args = ["/c", "start", "", url];
                    } else if (process.platform === "darwin") {
                        cmd = "open";
                        args = [url];
                    } else {
                        cmd = "xdg-open";
                        args = [url];
                    }
                    await execFileAsync(cmd, args);
                    return text('Attachment opened successfully in local browser.');
                } catch (error) {
                    return text(`Failed to open attachment: ${(error as Error).message}`);
                }
            },
        );
    }

    public async run(transport?: Transport): Promise<void> {
        if (this.legacyImport) runLegacyImportOnce(this.db);
        const stdio = transport === undefined;
        if (stdio) process.once('exit', () => endSession(this.db, this.sessionId));
        await this.server.connect(transport ?? new StdioServerTransport());
        if (stdio) console.error(`GhostPM MCP server running on stdio (${this.sessionId})`);
    }
}

if (require.main === module) {
    new PmServer().run().catch(console.error);
}
