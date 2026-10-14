---
name: ghostpm
description: "Use when the user asks about tasks, issues, work items, tickets, bugs, backlog, sprint, standups or project status, asks what is running on this machine or for the GhostPM dashboard, and whenever a prompt starts real work (brainstorm, plan, detail out, implement, fix). Triggers: 'show tasks', 'my issues', 'what should I work on', 'update issue', 'close ticket', 'project status', 'backlog', 'assigned to me', 'what did I do yesterday', 'standup', 'show the dashboard', 'what is running'."
---

# GhostPM Task Workflow

GhostPM keeps one local task ledger shared by every session on this machine. Use its MCP tools for all task operations.

## Quick reference

| Intent | Tool | Example |
|--------|------|---------|
| Project context | `get_project_state` | "what am I working on?" |
| Machine-wide dashboard | `get_project_state` with `all_workspaces: true` | "show the GhostPM dashboard", "what is running on this machine?" |
| Start or continue work | `track_work` | "let's fix the login bug" |
| See tasks | `query_tasks` | "show my tasks" (`all_workspaces: true` for every workspace) |
| Task details | `get_task` | "what's T42 about?" |
| Update or close | `update_task` | "mark T42 done" |
| Duplicate found | `merge_task` | "T43 is the same as T42" |
| Recent activity, standup | `timeline` | "what did I do yesterday?" (`since: "yesterday"`, `all_workspaces: true`) |
| Set sprint | `set_sprint` | "switch to Sprint 5" |
| Open a link | `open_attachment` | "open that URL" (http and https only) |

## Proactive workflow

- **Session start**: call `get_project_state` for the workspace, active task and sprint.
- **A prompt that starts real work** (brainstorm, plan, detail out, implement, fix): call `track_work`. Attach to a matching task, or create a new one. Never for questions or lookups.
- **Unsure which task**: ask once, inline, then call `track_work`.
- **Duplicate spotted**: call `merge_task`.
- **Phases follow evidence.** Change a phase only when the user asks.

## Rules

- Use the MCP tools directly; never shell out to `gh` or `az` for task operations.
- Task ids are ledger ids (T42) and resolve from any repo. `#42` or a bare `42` stays inside the current workspace: the vendor id there, else local id 42 there.
- Phases: brainstorming, planned, in_progress, in_review, done, dropped.
- Vendor sync is off by default. `ghostpm init` in a repo turns it on for that workspace; until then tasks stay in the local ledger and nothing is posted to GitHub or Azure DevOps.
- Show the dashboard and timeline text as returned; summarise only when asked.
- Show results directly; don't narrate what you are about to do.
