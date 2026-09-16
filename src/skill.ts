export const PLUGIN_JSON = {
    "$schema": "https://anthropic.com/claude-code/plugin.schema.json",
    name: "ghostpm",
    version: "1.0.0",
    description: "Project management interface for GitHub Issues and Azure DevOps Work Items",
    author: { name: "dpkay" },
    skills: ["./"]
};

export const SKILL_CONTENT = `---
name: ghostpm
description: "Use when the user asks about tasks, issues, work items, tickets, bugs, backlog, sprint, or project status, and whenever a prompt starts real work (brainstorm, plan, detail out, implement, fix). Triggers: 'show tasks', 'my issues', 'what should I work on', 'update issue', 'close ticket', 'project status', 'backlog', 'assigned to me', 'what did I do yesterday'."
---

# GhostPM Task Workflow

GhostPM keeps a local task log shared by every session on this machine. Use its MCP tools for all task operations.

## Quick reference

| Intent | Tool | Example |
|--------|------|---------|
| Project context | \`get_project_state\` | "what am I working on?" |
| Start or continue work | \`track_work\` | "let's fix the login bug" |
| See tasks | \`query_tasks\` | "show my tasks" |
| Task details | \`get_task\` | "what's T42 about?" |
| Update or close | \`update_task\` | "mark T42 done" |
| Duplicate found | \`merge_task\` | "T43 is the same as T42" |
| Recent activity | \`timeline\` | "what did I do yesterday?" |
| Set sprint | \`set_sprint\` | "switch to Sprint 5" |
| Open a link | \`open_attachment\` | "open that URL" |

## Proactive workflow

- **Session start**: call \`get_project_state\` for the workspace, active task and sprint.
- **A prompt that starts real work** (brainstorm, plan, detail out, implement, fix): call \`track_work\`. Attach to a matching task, or create a new one. Never for questions or lookups.
- **Unsure which task**: ask once, inline, then call \`track_work\`.
- **Duplicate spotted**: call \`merge_task\`.
- **Phases follow evidence.** Change a phase only when the user asks.

## Rules

- Use the MCP tools directly — never shell out to \`gh\` or \`az\` for task operations.
- Task ids are ledger ids (T42) and resolve from any repo. \`#42\` or a bare \`42\` stays inside the current workspace: the vendor id there, else local id 42 there.
- Phases: brainstorming, planned, in_progress, in_review, done, dropped.
- Show results directly; don't narrate what you are about to do.
`;
