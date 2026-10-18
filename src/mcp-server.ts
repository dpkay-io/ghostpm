#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import { Ledger, MS_PER_HOUR, isMissingAddon, openLedger } from "./ledger/db";
import { BOOTSTRAP_NOTICE } from "./hook/recover";
import { ensureWorkspace, getWorkspace } from "./ledger/workspaces";
import { getTask, getVendorLink, listTasks, resolveTaskRef, updateTask } from "./ledger/tasks";
import { listEvents } from "./ledger/events";
import { renderEvent } from "./surfaces/render-event";
import { parseSince } from "./surfaces/since";
import { mergeTask, trackWork } from "./ledger/work";
import { activeTaskFor, taskBranchName } from "./ledger/branch";
import {
    CLAUDE_SESSION_ENV, HOOK_CLIENT, MCP_CLIENT, currentSessionOf, endSession, getSession, listLiveSessions, mcpSessionId,
    seeSession, startSession, touchSession,
} from "./ledger/sessions";
import {
    SETTING_ACTIVE_SPRINT, SETTING_CREATE_BRANCH, SETTING_CURRENT_USER, SETTING_STALE_SESSION_MINUTES,
    getWorkspaceSetting, readSetting, setWorkspaceSetting,
} from "./ledger/settings";
import { runLegacyImport } from "./ledger/legacy-import";
import { ProjectionResult, publishTask } from "./ledger/projection";
import { INTENTS, PHASES, TaskRow, WorkspaceRow, formatTaskId } from "./ledger/types";
import { SYNC_LOG_FILE } from "./hook/log";
import { defaultSyncDeps, startSyncRunner, sweepStaleArgDirs } from "./sync/runner";
import { describeSync } from "./surfaces/sync-health";
import { TASK_COLUMNS, phaseSummary, taskCell } from "./surfaces/task-views";
import { dashboardText } from "./surfaces/dashboard";
import { SERVER_NAME, packageVersion } from "./package-info";
import { systemTool } from "./cli";
import { cleanText } from "./surfaces/text";

const execFileAsync = promisify(execFile);

export const SERVER_VERSION = packageVersion();
export const ALL_SPRINTS = "all";
export const CLEAR_SPRINT = "__clear__";
export const CURRENT_USER_REF = "@me";
/** Said on stderr once the stdio transport is up: stdout belongs to the protocol. */
export const STDIO_BANNER = "GhostPM MCP server running on stdio";
/** A tool call under Claude Code before its SessionStart hook's bootstrap has built the addon: a later call opens the ledger. */
export const ADDON_COMPILING = `${BOOTSTRAP_NOTICE} Retry this call shortly.`;

const UNKNOWN = "_unknown_";
const NONE_SET = "_none set_";
const DEFAULT_TIMELINE_HOURS = 24;
const SOURCE_PREFIX = "mcp";
/** Only web links reach the OS URL handler: file:, javascript: or ms-settings: from a vendor body must never launch anything. */
export const OPENABLE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);
/**
 * rundll32 hands its raw command tail to the handler, so the link must be one that Windows never quotes (no space,
 * tab or quote). The serialised URL escapes those everywhere but the host, where only a quote can survive.
 */
const WINDOWS_QUOTED = '"';
const WINDOWS_URL_HANDLER = "url.dll,FileProtocolHandler";
const MACOS_OPENER = "open";
const XDG_OPENER = "xdg-open";
/** What update_task says about a publish request, by what the ledger did with it. */
const PUBLISH_NOTES: Record<ProjectionResult, string> = {
    no_vendor: 'not published: this workspace has no GitHub or Azure DevOps remote',
    broken_link: 'not published: its vendor item was deleted or moved',
    not_allowed: 'not published: sync_policy is off or does not allow it (ghostpm config set sync_policy), or the task is closed',
    create_failed: `not published: its create failed (see ${SYNC_LOG_FILE} in the ghostpm home); \`ghostpm sync\` retries it`,
    create_queued: 'queued to publish',
    sync_queued: 'queued to sync',
    nothing: 'already on its way to the vendor',
};

const SERVER_INSTRUCTIONS = `You have access to GhostPM — a local-first task log shared by every session on this machine.

## When to use

- The user asks about tasks, issues, work items, tickets, bugs, backlog, sprint or project status
- The user names a task (T42, #42, 42)
- Before starting development work: check what is already tracked

## Reading

1. \`get_project_state\` — workspace, user, sprint, branch, active task, counts, live sessions, pending sync. Call it first in a session. Pass \`all_workspaces: true\` for the machine-wide dashboard (live sessions, tasks by workspace and phase, sync health, cross-workspace activity, recent timeline) when the user asks what is running on this machine or for the GhostPM dashboard; show it as returned.
2. \`set_sprint\` — activate a milestone; omit the name to list them; '${CLEAR_SPRINT}' unsets it.
3. \`query_tasks\` — markdown table. Defaults to the active sprint and this workspace; supports sprint='${ALL_SPRINTS}', assignee='${CURRENT_USER_REF}', phase and all_workspaces.
4. \`get_task\` — full details, vendor link and comments.
5. \`open_attachment\` — open a URL in the user's browser.

## Writing

6. \`track_work\` — call it when a prompt starts real work (brainstorm, plan, detail out, implement, fix). Attach to an existing task when one matches (pass task_id); otherwise omit task_id to create one. Ask the user once, inline, when you are unsure which task. Never call it for questions or lookups.
7. \`update_task\` — phase, title or comment. Only change the phase when the user asks; phases otherwise follow evidence.
8. \`merge_task\` — when two tasks turn out to be the same piece of work.
9. \`timeline\` — what happened recently, for standups and recaps. \`since\` takes 36h, 2d, yesterday or a date; add \`all_workspaces\` for the whole machine.

## Important

- Task ids are local: T42. \`#42\` or a bare \`42\` means the vendor's id in the current workspace.
- Phases are: ${PHASES.join(', ')}.
- Everything is read from the local ledger; reading never calls GitHub or Azure DevOps.
- Do NOT ask the user to install or configure anything — GhostPM is already set up.
- Show results directly rather than describing what you are about to do.`;

export interface PmServerOptions {
    db?: Ledger;
    /** Opens the ledger when `db` is not given. Defaults to openLedger. */
    openDb?: () => Ledger;
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

const failure = (error: unknown): ToolResult => ({
    content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
    isError: true,
});

/**
 * The link exactly as the opener receives it, or an error saying why it is refused. It is the serialised URL, never the
 * caller's spelling, so `https:\\host\share` reaches the handler as `https://host/share`, not as a UNC path.
 */
function openableLink(raw: string): string {
    const url = new URL(raw);
    if (!OPENABLE_PROTOCOLS.has(url.protocol)) {
        throw new Error(`Only http and https links can be opened; refusing a ${url.protocol} link.`);
    }
    // The URL parser silently drops tabs and newlines; a bidi override disguises where the link leads. zod's url()
    // hands over the trimmed input, so this sees the link without leading or trailing whitespace and controls.
    if (cleanText(raw) !== raw) throw new Error("Refusing a link that contains control characters.");
    if (url.username !== "" || url.password !== "") {
        throw new Error("Refusing a link with a user name or password in it: it can disguise the real host.");
    }
    if (url.href.includes(WINDOWS_QUOTED)) throw new Error("Refusing a link with a quote in its host name.");
    return url.href;
}

export interface Opener {
    file: string;
    args: string[];
}

/** The command that opens `link`, run without a shell; on Windows rundll32 from System32, never one planted on PATH. */
export function openerFor(link: string, platform: NodeJS.Platform = process.platform): Opener {
    if (platform === "win32") return { file: systemTool("rundll32.exe"), args: [WINDOWS_URL_HANDLER, link] };
    return { file: platform === "darwin" ? MACOS_OPENER : XDG_OPENER, args: [link] };
}

export class PmServer {
    private readonly server: McpServer;
    private readonly openDb: () => Ledger;
    /** Opened on first need, not at start: a plugin install has no addon until its SessionStart bootstrap builds one. */
    private ledger?: Ledger;
    private readonly cwd: string;
    private readonly sessionId: string;
    /** Started by Claude Code: its hooks own the session row, and tool calls follow its current conversation. */
    private readonly inClaudeCode: boolean;
    private readonly legacyImport: boolean;
    /** A real client (set by run): the sync runner and the exit handlers start once the ledger opens. */
    private stdio = false;

    constructor(options: PmServerOptions = {}) {
        this.server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
        const injected = options.db;
        this.openDb = injected ? () => injected : options.openDb ?? openLedger;
        this.cwd = options.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
        // Claude Code's own id, so track_work attaches the session its hooks read. An empty value is no id.
        const claudeSession = options.sessionId === undefined ? process.env[CLAUDE_SESSION_ENV] || undefined : undefined;
        this.inClaudeCode = claudeSession !== undefined;
        this.sessionId = options.sessionId ?? claudeSession ?? mcpSessionId();
        this.legacyImport = options.legacyImport ?? true;
        this.registerTools();
    }

    /**
     * The ledger, opened again on every call until it opens, then kept. Under Claude Code a missing addon means its
     * SessionStart hook is compiling one, so the call says to retry; elsewhere the error carries the bootstrap advice.
     * This server never starts a bootstrap itself: two builds in one folder compete.
     */
    private get db(): Ledger {
        try {
            return this.ledger ??= this.open();
        } catch (error) {
            throw this.inClaudeCode && isMissingAddon(error) ? new Error(ADDON_COMPILING) : error;
        }
    }

    /** Everything that waits on the ledger: this client's session, the legacy import, sync and the exit handlers. */
    private open(): Ledger {
        const db = this.openDb();
        if (!this.inClaudeCode) {
            startSession(db, { id: this.sessionId, client: MCP_CLIENT, cwd: this.cwd, workspaceId: ensureWorkspace(db, this.cwd).id });
        }
        if (this.legacyImport) runLegacyImport(db);
        if (this.stdio) {
            // Under Claude Code its SessionEnd hook ends the session: the hooks own that row.
            if (!this.inClaudeCode) process.once('exit', () => endSession(db, this.sessionId));
            // A real client: this process competes for the sync lease (spec §8.1). An injected
            // transport (tests) never starts a background timer.
            const runner = startSyncRunner(db, defaultSyncDeps(db));
            process.once('exit', () => runner.stop());
        }
        return db;
    }

    /** The session tool calls belong to: under Claude Code its current conversation, which /clear replaces while this server runs on. */
    private session(): string {
        return this.inClaudeCode ? currentSessionOf(this.db, this.sessionId) : this.sessionId;
    }

    /** Heartbeat plus the workspace every tool call works against. */
    private context(): WorkspaceRow {
        const workspace = ensureWorkspace(this.db, this.cwd);
        if (this.inClaudeCode) {
            // The hooks own Claude Code's row: its cwd is where Claude Code works now, not CLAUDE_PROJECT_DIR.
            seeSession(this.db, { id: this.session(), client: HOOK_CLIENT, cwd: this.cwd, workspaceId: workspace.id });
        } else {
            touchSession(this.db, { id: this.sessionId, client: MCP_CLIENT, cwd: this.cwd, workspaceId: workspace.id });
        }
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
        return activeTaskFor(this.db, this.session(), branch, workspaceId);
    }

    private renderTable(tasks: TaskRow[]): string {
        const header = `| ${TASK_COLUMNS.join(' | ')} |\n| ${TASK_COLUMNS.map(() => '---').join(' | ')} |\n`;
        const rows = tasks.map(task => `| ${TASK_COLUMNS.map(column => taskCell(this.db, task, column).replace(/\|/g, '\\|')).join(' | ')} |`);
        return `${header}${rows.join('\n')}\n`;
    }

    /** T-form ids stay machine-global (spec §9.1), so a write can land on another workspace's task. Say which one. */
    private crossWorkspaceNote(workspaceId: number, ...tasks: TaskRow[]): string {
        return tasks.map(task => {
            if (task.workspace_id === null || task.workspace_id === workspaceId) return '';
            const owner = getWorkspace(this.db, task.workspace_id);
            return owner ? ` Note: ${formatTaskId(task.id)} belongs to workspace ${owner.path}.` : '';
        }).join('');
    }

    private sprintsOf(workspaceId: number): string[] {
        const milestones = listTasks(this.db, { workspaceId })
            .map(task => task.milestone)
            .filter((milestone): milestone is string => milestone !== null && milestone !== '');
        return Array.from(new Set(milestones)).sort();
    }

    /** Event source for this client, e.g. "mcp:claude-code". */
    private source(): string {
        const client = this.server.server.getClientVersion()?.name;
        return client ? `${SOURCE_PREFIX}:${client}` : SOURCE_PREFIX;
    }

    /** Checks out task/T<id>, creating it only when it does not exist yet. */
    private async ensureBranch(task: TaskRow): Promise<string> {
        const branch = taskBranchName(task.id);
        try {
            await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: this.cwd });
            await execFileAsync('git', ['checkout', branch], { cwd: this.cwd });
            return `\nSwitched to existing branch ${branch}.`;
        } catch {
            try {
                await execFileAsync('git', ['checkout', '-b', branch], { cwd: this.cwd });
                return `\nCreated branch ${branch}.`;
            } catch (error) {
                return `\n(Branch not created: ${(error as Error).message})`;
            }
        }
    }

    private registerTools(): void {
        this.server.tool(
            "get_project_state",
            "Current workspace, user, sprint, branch, active task, task counts, live sessions and pending sync work. Call this first in a session. With all_workspaces, the machine-wide dashboard instead.",
            {
                all_workspaces: z.boolean().optional().describe('Machine-wide dashboard: live sessions, tasks by workspace and phase, sync health, cross-workspace activity, recent timeline.'),
            },
            async ({ all_workspaces }) => {
                const workspace = this.context();
                if (all_workspaces) return text(dashboardText(this.db));
                const branch = await this.currentBranch();
                const active = this.activeTask(branch, workspace.id);
                const tasks = listTasks(this.db, { workspaceId: workspace.id });
                const summary = phaseSummary(tasks);
                const staleMinutes = readSetting(this.db, workspace.id, SETTING_STALE_SESSION_MINUTES);
                return text([
                    `**Workspace:** ${workspace.path} (vendor: ${workspace.vendor})`,
                    `**User:** ${cleanText(getWorkspaceSetting<string>(this.db, workspace.id, SETTING_CURRENT_USER) ?? UNKNOWN)}`,
                    `**Active Sprint:** ${cleanText(getWorkspaceSetting<string>(this.db, workspace.id, SETTING_ACTIVE_SPRINT) ?? NONE_SET)}`,
                    `**Current Branch:** ${branch ?? UNKNOWN}`,
                    active ? `**Active Task:** ${formatTaskId(active.id)} ${cleanText(active.title)} · ${active.phase}` : '**Active Task:** _none_',
                    `**Tasks:** ${tasks.length} total${summary ? ` — ${summary}` : ''}`,
                    `**Live Sessions:** ${listLiveSessions(this.db, staleMinutes).length}`,
                    `**Sync:** ${describeSync(this.db, workspace)}`,
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
                    return text(sprints.map(sprint => `${sprint === active ? '→ ' : '  '}${cleanText(sprint)}`).join('\n'));
                }
                if (sprint_name === CLEAR_SPRINT) {
                    setWorkspaceSetting(this.db, workspace.id, SETTING_ACTIVE_SPRINT, undefined);
                    return text('Active sprint cleared.');
                }
                setWorkspaceSetting(this.db, workspace.id, SETTING_ACTIVE_SPRINT, sprint_name);
                const count = listTasks(this.db, { workspaceId: workspace.id, milestone: sprint_name }).length;
                return text(`Active sprint set to **${cleanText(sprint_name)}** (${count} task${count === 1 ? '' : 's'}).`);
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
                return text(`${milestone ? `_Sprint: ${cleanText(milestone)}_\n\n` : ''}${this.renderTable(tasks)}`);
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
                const taskWorkspace = task.workspace_id === null ? undefined : getWorkspace(this.db, task.workspace_id);
                return text(JSON.stringify({
                    id: formatTaskId(task.id),
                    title: task.title,
                    phase: task.phase,
                    origin: task.origin,
                    workspace: taskWorkspace?.path ?? null,
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
                url: z.string().url().describe('http or https URL to open in the browser'),
            },
            async ({ url }) => {
                let link: string;
                try {
                    link = openableLink(url);
                } catch (error) {
                    return failure(error);
                }
                try {
                    // No shell: vendor-supplied URLs (spec §8.9) never pass through cmd.exe's or sh's parser.
                    const { file, args } = openerFor(link);
                    await execFileAsync(file, args);
                    return text('Attachment opened successfully in local browser.');
                } catch (error) {
                    return failure(new Error(`Failed to open attachment: ${(error as Error).message}`));
                }
            },
        );

        this.server.tool(
            "track_work",
            "Start tracking work: create a task, or attach this session to an existing one. Call it when a prompt starts real work (brainstorm, plan, detail out, implement, fix). Do not call it for questions or lookups.",
            {
                title: z.string().min(1).describe('Short title for new work, or a note when attaching to an existing task.'),
                intent: z.enum(INTENTS).describe('What this work is.'),
                task_id: z.string().optional().describe('Attach to this task (T42, #42 or 42). Omit to create a new task.'),
            },
            async ({ title, intent, task_id }) => {
                const workspace = this.context();
                try {
                    const result = trackWork(this.db, {
                        sessionId: this.session(), source: this.source(), workspaceId: workspace.id,
                        title, intent, taskRef: task_id,
                    });
                    const verb = result.created ? 'Created' : result.reopened ? 'Reopened' : 'Attached to';
                    const wantsBranch = readSetting(this.db, workspace.id, SETTING_CREATE_BRANCH);
                    const branchNote = wantsBranch && (result.created || result.reopened) ? await this.ensureBranch(result.task) : '';
                    const crossNote = this.crossWorkspaceNote(workspace.id, result.task);
                    return text(`${verb} ${formatTaskId(result.task.id)} "${cleanText(result.task.title)}" (${result.task.phase}).${crossNote}${branchNote}`);
                } catch (error) {
                    return failure(error);
                }
            },
        );

        this.server.tool(
            "update_task",
            "Change a task's phase or title, add a comment, or publish it to GitHub / Azure DevOps. Only change the phase or publish when the user asks for it.",
            {
                task_id: z.string().describe('T42, #42 or 42.'),
                phase: z.enum(PHASES).optional().describe('New phase.'),
                title: z.string().optional().describe('New title.'),
                comment: z.string().optional().describe('Comment to record on the task.'),
                publish: z.boolean().optional().describe('Push this task to the vendor now. Needed under sync_policy "promote"; does nothing while sync_policy is "off".'),
            },
            async ({ task_id, phase, title, comment, publish }) => {
                const workspace = this.context();
                if (!phase && !title && !comment && !publish) return text('Provide a phase, a title, a comment or publish.');
                const task = resolveTaskRef(this.db, task_id, workspace.id);
                if (!task) return text(`Task ${task_id} not found.`);
                try {
                    // A tool call carries the user's instruction, so it counts as a human change (spec §8.6).
                    const ctx = { source: this.source(), sessionId: this.session(), human: true };
                    // Ruling F13: the publish goes after the phase and title (a task closed here is not published) and
                    // before the comment, which is queued only for a task on its way to the vendor.
                    updateTask(this.db, task.id, { phase, title }, ctx);
                    const published = publish ? PUBLISH_NOTES[publishTask(this.db, task.id)] : '';
                    const updated = updateTask(this.db, task.id, { comment }, ctx);
                    const changes = [phase ? `phase ${updated.phase}` : '', title ? 'renamed' : '', comment ? 'comment added' : '', published]
                        .filter(part => part.length > 0)
                        .join(', ');
                    const crossNote = this.crossWorkspaceNote(workspace.id, updated);
                    return text(`${formatTaskId(updated.id)} updated: ${changes}.${crossNote}`);
                } catch (error) {
                    return failure(error);
                }
            },
        );

        this.server.tool(
            "merge_task",
            "Merge a duplicate into the task to keep: history, vendor link and sessions move over and the duplicate is dropped.",
            {
                from: z.string().describe('Duplicate task to merge away (T42, #42 or 42).'),
                into: z.string().describe('Task to keep.'),
            },
            async ({ from, into }) => {
                const workspace = this.context();
                try {
                    const result = mergeTask(this.db, {
                        fromRef: from, intoRef: into, workspaceId: workspace.id,
                        source: this.source(), sessionId: this.session(),
                    });
                    const crossNote = this.crossWorkspaceNote(workspace.id, result.into, result.from);
                    return text(`Merged ${formatTaskId(result.from.id)} into ${formatTaskId(result.into.id)} "${cleanText(result.into.title)}".${crossNote}`);
                } catch (error) {
                    return failure(error);
                }
            },
        );

        this.server.tool(
            "timeline",
            "Recent activity: task creations, phase changes, edits, commits, PRs and comments. Use it for standups and 'what did I do' questions.",
            {
                since: z.string().optional().describe('A duration (36h, 2d), a date (2026-09-28), a date and time, today or yesterday. Defaults to the last 24 hours.'),
                task_id: z.string().optional().describe('Limit to one task.'),
                all_workspaces: z.boolean().optional().describe('Include every workspace on this machine.'),
                limit: z.number().int().positive().optional().describe('Maximum number of entries.'),
            },
            async ({ since, task_id, all_workspaces, limit }) => {
                const workspace = this.context();
                let from: string;
                try {
                    from = since === undefined
                        ? new Date(Date.now() - DEFAULT_TIMELINE_HOURS * MS_PER_HOUR).toISOString()
                        : parseSince(since).toISOString();
                } catch (error) {
                    return failure(error);
                }
                const task = task_id ? resolveTaskRef(this.db, task_id, workspace.id) : undefined;
                if (task_id && !task) return text(`Task ${task_id} not found.`);
                const entries = listEvents(this.db, {
                    taskId: task?.id,
                    workspaceId: task || all_workspaces ? undefined : workspace.id,
                    since: from,
                    limit,
                });
                if (entries.length === 0) return text('Nothing recorded in that period.');
                return text(entries.map(renderEvent).join('\n'));
            },
        );
    }

    public async run(transport?: Transport): Promise<void> {
        this.stdio = transport === undefined;
        // An injected transport (tests) never sweeps the temporary folder.
        if (this.stdio) void sweepStaleArgDirs();
        try {
            this.ledger = this.open();
        } catch (error) {
            // Connect anyway, so the tools are there and say so; any other failure refuses to start, as it always has.
            if (!isMissingAddon(error)) throw error;
        }
        await this.server.connect(transport ?? new StdioServerTransport());
        if (this.stdio) console.error(`${STDIO_BANNER} (${this.sessionId})`);
    }
}

if (require.main === module) {
    new PmServer().run().catch(console.error);
}
