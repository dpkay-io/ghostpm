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
description: "Use when the user asks about tasks, issues, work items, tickets, bugs, backlog, sprint, or project status. Also use proactively before starting development work to check for assigned tasks. Triggers: 'show tasks', 'my issues', 'what should I work on', 'start task', 'update issue', 'close ticket', 'project status', 'backlog', 'assigned to me'."
---

# GhostPM Task Workflow

This repo has GhostPM connected to its issue tracker. Use the ghostpm MCP tools for all task operations.

## Quick reference

| Intent | Tool | Example |
|--------|------|---------|
| See all tasks | \`query_tasks\` | "show my tasks" |
| Task details | \`get_task\` | "what's #42 about?" |
| Start working | \`start_task\` | "pick up issue 7" |
| Update/close | \`update_task\` | "close #15" |
| Open link | \`open_attachment\` | "open that URL" |

## Proactive workflow

- **Before starting dev work**: Query tasks to find what's assigned. Don't start coding without context.
- **After creating a PR**: Update the task state to "in_review" via update_task.
- **When a task is done**: Close it via update_task with state "closed".
- **Conflict?**: If an update reports a conflict, explain both versions and ask which to keep, then call resolve_conflict.

## Rules

- Use MCP tools directly — never shell out to \`gh\` or \`az\` CLI for task operations.
- Task IDs are issue numbers (GitHub) or work item IDs (Azure DevOps).
- Bare numbers like "#42" or "42" are task IDs.
- Show results directly, don't narrate what you're about to do.
`;
