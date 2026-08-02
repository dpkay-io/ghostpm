#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Engine } from "./engine";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export class PmServer {
    private server: McpServer;
    private engine: Engine;

    constructor() {
        this.server = new McpServer({
            name: "unified-pm-mcp",
            version: "1.0.0",
        });
        this.engine = new Engine();
        this.registerTools();
    }

    private registerTools() {
        this.server.tool("query_tasks", {}, async () => {
            const db = this.engine.getDb();
            const config = this.engine.getConfig();
            const tasks = db.getTasks();
            
            const columns = config.views.list_columns || ["id", "state", "title", "assignee"];
            
            let markdown = `| ${columns.join(" | ")} |\n`;
            markdown += `| ${columns.map(() => "---").join(" | ")} |\n`;
            
            for (const task of tasks) {
                const row = columns.map(col => {
                    const val = (task as any)[col];
                    return val !== undefined && val !== null ? String(val).replace(/\|/g, "\\|") : "";
                });
                markdown += `| ${row.join(" | ")} |\n`;
            }

            return {
                content: [{ type: "text", text: markdown }]
            };
        });

        this.server.tool("get_task", {
            task_id: z.string().describe("The ID of the task")
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

        this.server.tool("start_task", {
            task_id: z.string().describe("The ID of the task")
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

        this.server.tool("update_task", {
            task_id: z.string().describe("The ID of the task"),
            state: z.string().optional().describe("New state"),
            comment: z.string().optional().describe("Comment to append")
        }, async ({ task_id, state, comment }) => {
            if (!state && !comment) {
                return { content: [{ type: "text", text: `Must provide state or comment to update task ${task_id}.` }] };
            }
            await this.engine.queueUpdateTask(task_id, state, comment);
            return { content: [{ type: "text", text: `Task ${task_id} update queued. Background sync triggered.` }] };
        });

        this.server.tool("open_attachment", {
            url: z.string().url().describe("URL of the attachment to open")
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

        this.server.tool("resolve_conflict", {
            task_id: z.string().describe("The ID of the task with the conflict"),
            winning_state: z.enum(["local", "remote"]).describe("Which state should win")
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
        console.error("Unified PM MCP Server running on stdio");

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
