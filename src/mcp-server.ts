#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Engine } from "./engine";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const SERVER_INSTRUCTIONS = `You have access to GhostPM — a project management interface connected to this repository's issue tracker (GitHub Issues or Azure DevOps Work Items).

## When to use

Use these tools whenever the user:
- Asks about tasks, issues, work items, tickets, bugs, stories, or backlog ("show my tasks", "what's assigned to me", "list open issues", "any blockers?")
- Wants to start, update, close, or comment on a task ("start working on #42", "close issue 7", "add a comment to that bug", "move it to in review")
- References a specific issue number or task ID ("what's #15 about?", "details on task 123")
- Asks about project status, sprint progress, or workload ("what's in progress?", "pending items", "what needs review?")
- Wants to open a link or attachment from a task ("open that link", "show the attachment")
- Is about to begin development work (check for assigned tasks first)

## How to use

1. **Project context**: Call \`get_project_state\` at session start — returns vendor, user, active sprint, task counts, and sync status. This is the first thing to check.
2. **Set sprint scope**: Call \`set_sprint\` to activate a sprint/milestone. Once set, \`query_tasks\` defaults to that sprint's tasks.
3. **List tasks**: Call \`query_tasks\` — returns a markdown table. Filters by active sprint unless you pass sprint='all'. Supports assignee filter with '@me'.
4. **Task details**: Call \`get_task\` with the task ID — returns full details including description and comments.
5. **Start work**: Call \`start_task\` with the task ID — transitions the task to "in progress" and creates a git branch \`task/<id>\`.
6. **Update task**: Call \`update_task\` with task ID and optional state/comment — changes state or adds a comment.
7. **Open links**: Call \`open_attachment\` with a URL — opens it in the user's browser.
8. **Resolve conflicts**: If a sync conflict is reported, call \`resolve_conflict\` — lets user pick local or remote changes.

## Important

- Tasks are cached locally for instant reads. Data is synced with the remote PM tool in the background.
- Task IDs match the remote system (GitHub issue numbers or Azure DevOps work item IDs).
- When the user says a bare number like "#42" or "42", treat it as a task ID.
- Do NOT ask the user to install or configure anything — GhostPM is already set up for this repo.
- Prefer showing results directly rather than explaining what you could do.
- Project state (active sprint, user identity) persists across sessions in the local database — all sessions share the same state.`;

export class PmServer {
    private server: McpServer;
    private engine: Engine;

    constructor() {
        this.server = new McpServer(
            { name: "ghostpm", version: "1.0.0" },
            { instructions: SERVER_INSTRUCTIONS }
        );
        this.engine = new Engine();
        this.registerTools();
    }

    private renderTaskTable(tasks: any[], columns: string[]): string {
        let markdown = `| ${columns.join(" | ")} |\n`;
        markdown += `| ${columns.map(() => "---").join(" | ")} |\n`;
        for (const task of tasks) {
            const row = columns.map(col => {
                const val = (task as any)[col];
                return val !== undefined && val !== null ? String(val).replace(/\|/g, "\\|") : "";
            });
            markdown += `| ${row.join(" | ")} |\n`;
        }
        return markdown;
    }

    private registerTools() {
        this.server.tool("get_project_state", "Get the current project context: vendor, user identity, active sprint, task summary, and sync status. Call this at the start of a session to understand the project state.", {}, async () => {
            const state = this.engine.getProjectState();

            let currentBranch: string | null = null;
            try {
                const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
                currentBranch = stdout.trim();
            } catch { /* not in a git repo or git not available */ }

            const taskMatch = currentBranch?.match(/^task\/(.+)$/);
            if (taskMatch) state.activeTask = taskMatch[1];

            const summary = this.engine.getSprintSummary(state.activeSprint?.name);
            const availableSprints = this.engine.getAvailableSprints();

            const lines = [
                `**Vendor:** ${state.vendor}`,
                `**User:** ${state.currentUser || '_not detected yet — will resolve on next sync_'}`,
                `**Active Sprint:** ${state.activeSprint?.name || '_none set_'}`,
                state.activeSprint?.endDate ? `**Sprint Ends:** ${state.activeSprint.endDate}` : null,
                `**Current Branch:** ${currentBranch || '_unknown_'}`,
                state.activeTask ? `**Active Task:** #${state.activeTask}` : null,
                `**Last Sync:** ${state.lastSync || '_never_'}`,
                '',
                `**Tasks:** ${summary.total} total` + (Object.keys(summary.byState).length
                    ? ' — ' + Object.entries(summary.byState).map(([s, n]) => `${n} ${s}`).join(', ')
                    : ''),
                availableSprints.length > 0
                    ? `**Available Sprints:** ${availableSprints.join(', ')}`
                    : null,
            ].filter(Boolean);

            return { content: [{ type: "text", text: lines.join('\n') }] };
        });

        this.server.tool("set_sprint", "Set or clear the active sprint/milestone. When set, query_tasks defaults to showing only that sprint's tasks. Omit sprint_name to list available sprints.", {
            sprint_name: z.string().optional().describe("Sprint/milestone name to activate. Omit to list available sprints. Use '__clear__' to unset.")
        }, async ({ sprint_name }) => {
            if (!sprint_name) {
                const sprints = this.engine.getAvailableSprints();
                if (sprints.length === 0) return { content: [{ type: "text", text: "No sprints/milestones found in cached tasks. Sync first." }] };
                const active = this.engine.getProjectState().activeSprint?.name;
                const list = sprints.map(s => `${s === active ? '→ ' : '  '}${s}`).join('\n');
                return { content: [{ type: "text", text: `Available sprints:\n${list}` }] };
            }
            if (sprint_name === '__clear__') {
                this.engine.setActiveSprint(null);
                return { content: [{ type: "text", text: "Active sprint cleared." }] };
            }
            this.engine.setActiveSprint({ name: sprint_name });
            const summary = this.engine.getSprintSummary(sprint_name);
            return { content: [{ type: "text", text: `Active sprint set to **${sprint_name}** (${summary.total} tasks: ${Object.entries(summary.byState).map(([s, n]) => `${n} ${s}`).join(', ')})` }] };
        });

        this.server.tool("query_tasks", "List tasks/issues from the project's issue tracker. Returns a markdown table. Defaults to active sprint if one is set; pass sprint='all' to see everything.", {
            sprint: z.string().optional().describe("Filter by sprint/milestone. Defaults to active sprint. Use 'all' to show all tasks."),
            assignee: z.string().optional().describe("Filter by assignee. Use '@me' for the current user."),
        }, async ({ sprint, assignee }) => {
            const db = this.engine.getDb();
            const config = this.engine.getConfig();
            let tasks = db.getTasks();

            const activeSprint = this.engine.getProjectState().activeSprint;
            if (sprint !== 'all') {
                const filterSprint = sprint || activeSprint?.name;
                if (filterSprint) {
                    tasks = tasks.filter(t => t.milestone === filterSprint);
                }
            }

            if (assignee) {
                const resolvedAssignee = assignee === '@me'
                    ? this.engine.getProjectState().currentUser
                    : assignee;
                if (resolvedAssignee) {
                    tasks = tasks.filter(t => t.assignee === resolvedAssignee);
                }
            }

            const columns = config.views.list_columns || ["id", "state", "title", "assignee"];

            if (tasks.length === 0) {
                const context = sprint === 'all' ? '' : activeSprint?.name ? ` in sprint "${activeSprint.name}"` : '';
                return { content: [{ type: "text", text: `No tasks found${context}.` }] };
            }

            const header = sprint !== 'all' && activeSprint?.name && !sprint
                ? `_Showing sprint: ${activeSprint.name}_\n\n`
                : '';

            return {
                content: [{ type: "text", text: header + this.renderTaskTable(tasks, columns) }]
            };
        });

        this.server.tool("get_task", "Get full details of a specific task/issue including description and comments. Use when the user asks about a particular issue number or wants details on a task.", {
            task_id: z.string().describe("The task/issue ID (e.g. '42' for GitHub issue #42)")
        }, async ({ task_id }) => {
            const db = this.engine.getDb();
            const task = db.getTask(task_id);
            if (!task) {
                return { content: [{ type: "text", text: `Task ${task_id} not found.` }] };
            }
            
            const config = this.engine.getConfig();
            const detailFields = config.views.detail_fields || ["id", "title", "body", "comments"];
            const filteredTask: any = {};
            for (const field of detailFields) {
                if ((task as any)[field] !== undefined) {
                    filteredTask[field] = (task as any)[field];
                }
            }
            
            return { content: [{ type: "text", text: JSON.stringify(filteredTask, null, 2) }] };
        });

        this.server.tool("start_task", "Begin working on a task: transitions it to 'in progress' and creates a git branch task/<id>. Use when the user says they want to start, pick up, or work on a specific task.", {
            task_id: z.string().describe("The task/issue ID to start working on")
        }, async ({ task_id }) => {
            const config = this.engine.getConfig();
            const startState = config.workflow?.transitions?.start_task || "in_progress";
            await this.engine.queueUpdateTask(task_id, startState);
            
            let branchOutput = "";
            try {
                const branchName = `task/${task_id.replace(/[^a-zA-Z0-9-]/g, '-')}`;
                await execFileAsync('git', ['checkout', '-b', branchName]);
                branchOutput = `\nChecked out new branch: ${branchName}`;
            } catch (err: any) {
                branchOutput = `\n(Note: Failed to checkout git branch: ${err.message})`;
            }
            
            return { content: [{ type: "text", text: `Task ${task_id} queued for start (state: ${startState}). Background sync triggered.${branchOutput}` }] };
        });

        this.server.tool("update_task", "Update a task's state or add a comment. Use when the user wants to close, reopen, move, or comment on a task/issue.", {
            task_id: z.string().describe("The task/issue ID to update"),
            state: z.string().optional().describe("New state (e.g. 'closed', 'in_review', 'open')"),
            comment: z.string().optional().describe("Comment text to add to the task")
        }, async ({ task_id, state, comment }) => {
            if (!state && !comment) {
                return { content: [{ type: "text", text: `Must provide state or comment to update task ${task_id}.` }] };
            }
            await this.engine.queueUpdateTask(task_id, state, comment);
            return { content: [{ type: "text", text: `Task ${task_id} update queued. Background sync triggered.` }] };
        });

        this.server.tool("open_attachment", "Open a URL from a task in the user's local browser. Use when the user wants to view a link, attachment, or external resource referenced in a task.", {
            url: z.string().url().describe("URL to open in the browser")
        }, async ({ url }) => {
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
                return { content: [{ type: "text", text: `Attachment opened successfully in local browser.` }] };
            } catch (error: any) {
                return { content: [{ type: "text", text: `Failed to open attachment: ${error.message}` }] };
            }
        });

        this.server.tool("resolve_conflict", "Resolve a sync conflict when local and remote changes clash. Use when a previous update reported a conflict.", {
            task_id: z.string().describe("The task ID with the conflict"),
            winning_state: z.enum(["local", "remote"]).describe("'local' to keep your changes, 'remote' to accept the server's version")
        }, async ({ task_id, winning_state }) => {
            const outboxItem = this.engine.getDb().getConflictedOutboxItemByTaskId(task_id);
            if (!outboxItem || !outboxItem.id) {
                return { content: [{ type: "text", text: `No conflicting outbox item found for task ${task_id}.` }] };
            }
            
            if (winning_state === "local") {
                this.engine.resolveConflict(outboxItem.id, 'force_push');
                return { content: [{ type: "text", text: `Conflict resolved by forcing local changes for task ${task_id}.` }] };
            } else {
                this.engine.resolveConflict(outboxItem.id, 'drop');
                return { content: [{ type: "text", text: `Conflict resolved by dropping local changes in favor of remote for task ${task_id}.` }] };
            }
        });
    }

    public async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("GhostPM MCP server running on stdio");

        const syncInterval = setInterval(() => {
            this.engine.sync().catch(e => console.error("Sync daemon error:", e));
        }, 5 * 60 * 1000);
        syncInterval.unref();

        this.engine.sync().catch(e => console.error("Initial sync error:", e));
    }
}

if (require.main === module) {
    new PmServer().run().catch(console.error);
}
