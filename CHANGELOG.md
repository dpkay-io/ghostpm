# Changelog

## 2.0.0 (unreleased)

GhostPM 2.0 replaces the per-repo cache with one local-first ledger for the whole machine, filled automatically from your Claude Code sessions. This is a breaking release. Commands, settings and the files GhostPM keeps are described in the [README](README.md); this page lists what changed.

### Breaking changes

- **Storage moved.** Tasks now live in `~/.ghostpm/ledger.db` (or `$GHOSTPM_HOME/ledger.db`). Every session, hook, MCP server and command shares it. 1.4.0's per-repo `.mcp-pm.db` files are imported once, read-only, and never written again.
- **Node.js 22 or newer** is required. Node.js 22 or 24+ downloads a prebuilt SQLite addon; any other Node.js has to compile it, which needs Python and a C++ toolchain.
- **Vendor sync is off by default.** Nothing is pushed, pulled or queued until a workspace opts in. `ghostpm init` opts its repo in (`sync_policy` `auto`); `ghostpm config set sync_policy …` changes it. 1.4.0 repos keep 1.4.0's behaviour: they are stamped `sync_policy` `linked-only` and `progress_comments` `none` where those are unset, on every server start, so `config unset` is stamped again. Set a value instead.
- **MCP tools changed.** `start_task` and `resolve_conflict` are gone.
  - `track_work` creates a task or attaches to one. It replaces `start_task`; branch creation is the `create_branch` setting.
  - `merge_task` and `timeline` are new, and `update_task` can `publish` a task.
  - The human-wins rule settles conflicts with the vendor automatically.
- **Task ids are ledger ids:** `T42`. `#42` or `42` still means the vendor's issue in the current workspace.
- **Phases replace free-form states:** brainstorming, planned, in_progress, in_review, done, dropped. Evidence moves them (plan files, edits, commits, PRs), and so does you telling Claude.
- **`ghostpm init` writes no `.mcp-pm.yml`.** It registers the folder in the ledger, detects the vendor from the git remote, turns sync on, and for Azure DevOps learns `ado_work_item_type` from your recent work items and `phase_state_map` from that work item type's own states, so states you have not used yet are mapped too. An empty project no longer warns. Existing `.mcp-pm.yml` files are left alone.
- **`ghostpm setup` registers no MCP server and installs no skill.** The Claude Code plugin brings both. `setup --global` is gone, and `setup` now handles only the statusline (`--statusline`, `--restore`).
- **`ghostpm tasks`, `status` and `dashboard` read the ledger**, never `.mcp-pm.db`. `unregister` forgets a workspace in the ledger and asks for `--yes` first.

### New

- **Claude Code plugin** (`claude plugin install ghostpm@ghostpm`). Hooks record sessions, edited files, commits and PRs. The session is told which task it is on. The plugin ships the MCP server and the `ghostpm:ghostpm` skill.
- **`ghostpm dashboard`.** A live view of the machine: live sessions, tasks by workspace and phase, sync health, activity touching another workspace's task, and the recent timeline. It redraws only what changed, and prints one snapshot when piped or with `--once`. Inside Claude Code, ask for "the GhostPM dashboard".
- **`ghostpm standup [--since 2d|36h|yesterday|2026-09-28]`.** Tasks touched, phase changes, files, commits and PRs, per workspace. No LLM involved.
- **Statusline** (opt-in, `ghostpm setup --statusline`). Shows `▶ T42 <title> · <phase>`, `⚠<n>` for failed pushes, and a paused-sync reason, hiding finished tasks, after your existing statusline, which stays in place if GhostPM's ledger cannot be read.
- **Vendor sync v2** (`ghostpm sync`, `ghostpm config`):
  - one sync runner at a time;
  - a desired-state queue that retries with backoff;
  - failed pushes shown instead of hidden, with details in `sync.log`;
  - a workspace whose `gh` or `az` login fails pauses, with the reason shown;
  - secrets are redacted before anything is sent to a vendor;
  - explicit `--repo` or `--org` and `--project` on every vendor call.
- **`ghostpm doctor`.** Finds 1.4.0 MCP registrations in `~/.claude.json`, stale 1.4.0 skills, a ledger newer than the copy you are running and a Node.js older than 22, and prints the exact commands that fix them. It never changes anything itself.
- **`ghostpm bootstrap`** builds the SQLite addon into the GhostPM home, and works when its path has spaces or symbols.
- **Capped logs.** `hook.log` and `sync.log` move to `hook.log.1` and `sync.log.1` once they pass 1 MiB, keeping one older file each.
- **`ghostpm --version`.**

### Fixed

- `open_attachment` opens only http and https links.
- **Azure DevOps keeps its retry marker.** The hidden marker that stops a retried create or comment being posted twice is now an invisible span, because Azure DevOps strips HTML comments.
- **Azure DevOps with a personal access token only** no longer pauses sync because your user cannot be read; the user is treated as unknown.
- **A work item moved to a state several phases share** is read as the sensible phase, not the first one in phase order.
- **A closed GitHub issue loses its `ghostpm:<phase>` label.**
- **Faster prompts.** The prompt hook finds the session's tasks through an index and loads less code, so it stays quick on a large ledger. The ledger upgrades itself the first time it is opened.

### Upgrading from 1.4.0

1. Install the plugin: `claude plugin marketplace add dpkay-io/ghostpm`, then `claude plugin install ghostpm@ghostpm` (on npm 12, `npm_config_allow_remote=all claude plugin install ghostpm@ghostpm`; see the README). For the terminal commands, also run `npm install -g ghostpm@2`. Keep both on the same version.
2. Start a Claude Code session. On its first start, the MCP server imports every 1.4.0 repo it can find: those in `~/.ghostpm/workspaces.json`, plus projects in `~/.claude.json` that have a `.mcp-pm.yml`. It brings over tasks, vendor links, comments, the detected user and the active sprint, and queues the changes 1.4.0 had not pushed yet. Those repos sync as 1.4.0 did (`linked-only`: existing linked items only, no phase comments) until you move them to `auto` (`ghostpm init` there, or `ghostpm config set sync_policy auto --workspace <repo folder>`). The old files stay where they were, untouched. For a repo it missed, run `ghostpm init` in that repo.
3. Run `ghostpm doctor`. It prints the commands that remove your 1.4.0 MCP registrations (`claude mcp remove ghostpm -s user`, and `claude mcp remove ghostpm -s local` per project) and the old `~/.claude/skills/ghostpm` folder. Nothing is removed until you run them.

If you skip step 3, sessions keep starting the 1.4.0 server next to the plugin. That means two sets of GhostPM tools, and the old one writes to `.mcp-pm.db`, which nothing reads any more.

`ghostpm unregister <repo> --yes` makes the import skip that repo on later starts; `ghostpm init` in it brings it back.

For where GhostPM keeps its files (`ledger.db`, `hook.log`, `sync.log` and the rest), see [Where your data lives](README.md#where-your-data-lives) in the README.
