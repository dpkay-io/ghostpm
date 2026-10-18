# GhostPM

A local-first task ledger for AI coding sessions. GhostPM records what you work on in Claude Code into one ledger that every session on your machine shares: tasks, phases, edited files, commits and PRs. It can mirror those tasks to GitHub Issues or Azure DevOps, so you never have to "do PM".

## Requirements

- Node.js 22 or newer.
- Only for vendor sync: the [GitHub CLI](https://cli.github.com/) (`gh auth login`), or the [Azure CLI](https://learn.microsoft.com/cli/azure/) with the azure-devops extension (`az login`).

## Install

GhostPM is one npm package that is also a Claude Code plugin. Install the plugin to capture your sessions, and the npm package for the terminal commands. Keep both on the same version.

### Claude Code plugin: captures your sessions

```
claude plugin marketplace add dpkay-io/ghostpm
claude plugin install ghostpm@ghostpm
```

If `npm -v` prints 12 or later, the install fails with `EALLOWREMOTE`: Claude Code downloads the plugin with `npm pack <tarball URL>`, which npm 12 refuses by default. Allow it for that one command:

```
npm_config_allow_remote=all claude plugin install ghostpm@ghostpm
```

In PowerShell: `$env:npm_config_allow_remote='all'; claude plugin install ghostpm@ghostpm; Remove-Item env:npm_config_allow_remote`. Your npm config is not changed.

The plugin brings the MCP server, the hooks and the `ghostpm:ghostpm` skill. The first session after installing builds GhostPM's SQLite addon in the background and says so. This needs the network once, and tracking starts when it finishes.

### Terminal commands: dashboard, standup, status

```
npm install -g ghostpm
```

A plugin cannot add commands to your terminal, so `ghostpm dashboard` and the other commands come from this package. Without it, ask Claude Code to "show the GhostPM dashboard": the same view comes back through the plugin.

npm 12 blocks dependency install scripts by default, as does any install with scripts disabled, so the SQLite addon is not built. Run `ghostpm bootstrap` once after installing: it allows only better-sqlite3's install script, pinned to its exact version, in its own folder under `~/.ghostpm`.

## What it does

- **Captures work.** When a prompt starts real work, Claude creates a task or attaches to one (`track_work`). Edits, commits and PRs are recorded as evidence and move the phase: brainstorming, planned, in_progress, in_review, done (or dropped).
- **One view of the machine.** Every folder a session runs in is a workspace, git or not. `ghostpm dashboard` shows all of them live.
- **Optional vendor sync.** A workspace with a GitHub or Azure DevOps remote can be mirrored to that tracker. It is off until you turn it on, and nothing local ever waits for it.

## Commands

| Command | What it does |
|---|---|
| `ghostpm dashboard [--once]` | Live view of the machine: live sessions, tasks by workspace and phase, sync health, activity touching another workspace's task, recent timeline. Ctrl+C quits. Prints one snapshot with `--once` or when stdout is not a terminal. |
| `ghostpm standup [--since <when>]` | What changed since `<when>` (default: the last 24 hours). `<when>` is a duration (`90m`, `36h`, `2d`, `1w`), `today`, `yesterday`, a date (`2026-09-28`) or a date and time (`2026-09-28T09:00`). |
| `ghostpm tasks [--all]` | Open tasks in this workspace, or in every workspace. |
| `ghostpm status` | This workspace: vendor, user, sprint, task counts, sync state. |
| `ghostpm init` | Register this folder, detect its vendor settings and turn sync on for it (`sync_policy` becomes `auto` when it is unset or `linked-only`; an explicit `off` stays). If the repo has 1.4.0 data, it is imported. |
| `ghostpm unregister [path] [--yes]` | Forget a workspace and its local tasks. Without `--yes` it only previews what it would delete. Vendor items are never touched. |
| `ghostpm sync` | One sync pass now: push queued changes, pull vendor updates, resume a paused workspace and retry failed pushes. Exits 1 when a push or pull failed. |
| `ghostpm config get, set or unset <key> [value] [--workspace <path>]` | Read or change a setting (see Settings). |
| `ghostpm setup --statusline` | Show the active task in the Claude Code statusline, after the one you already have. `ghostpm setup --restore` puts yours back. |
| `ghostpm doctor` | Find what GhostPM 1.4.0 left behind (and a Node.js that is too old) and print the commands that fix it. Changes nothing itself. |
| `ghostpm bootstrap` | Build the SQLite addon into `~/.ghostpm`. The plugin runs this for you. |
| `ghostpm help`, `ghostpm --version` | Usage, and the version. |

The statusline reads `▶ T42 <title> · <phase>`, followed by `⚠<n>` when `<n>` pushes failed (`⚠<n> sync off` where sync is off, since nothing retries them until you turn it on), and by the pause reason when sync is paused.

## Inside Claude Code

Just talk: "what am I working on?", "this is part of T12", "mark it done", "what did I do yesterday?", "show the GhostPM dashboard". Claude uses these MCP tools:

| Tool | Use |
|---|---|
| `get_project_state` | Workspace, user, sprint, branch, active task, counts. With `all_workspaces: true`, the machine-wide dashboard. |
| `track_work` | Create a task, or attach this session to an existing one. |
| `query_tasks` | Tasks as a table. Filters: sprint, assignee (`@me`), phase, all workspaces. |
| `get_task` | One task, with its vendor link and comments. |
| `update_task` | Change the phase or title, add a comment, or `publish: true` to push the task to the vendor now (needed under `promote`). A phase change made here counts as yours: human wins over automation. |
| `merge_task` | Fold a duplicate into the task you keep. |
| `timeline` | Recent events. `since` takes the same forms as `standup --since`. |
| `set_sprint` | Pick the milestone `query_tasks` defaults to. |
| `open_attachment` | Open an http or https link in your browser. |

Task ids are ledger ids: `T42` works from any folder. `#42` or a bare `42` means the vendor's issue 42 in the current workspace.

## Vendor sync

Sync is off by default. Nothing is pushed, pulled or queued until you turn it on for a workspace:

- `ghostpm init` in the repo turns it on (`sync_policy` = `auto`).
- Or: `ghostpm config set sync_policy auto --workspace <repo folder>`. To change a repo that `init` already set, always pass `--workspace`: a workspace value beats the global one.

Once on, a workspace whose git remote is on GitHub or Azure DevOps syncs with that tracker:

- New tasks become issues or work items, as `sync_policy` says.
- Phase changes move the label (GitHub `ghostpm:<phase>`) or the state (Azure DevOps `phase_state_map`). Done and dropped close the item.
- Edits made in the tracker come back when GhostPM pulls.
- Anything that looks like a secret (tokens, keys, passwords, private keys) is replaced with `[redacted]` before it is sent to a vendor. A note goes to `sync.log`.

One process syncs at a time. Pushes retry with backoff. A push that keeps failing shows as `⚠<n>` in the statusline and the dashboard. If `gh` or `az` is not logged in, that workspace pauses and shows the reason; `ghostpm sync` resumes it. Failures and redaction notes are written to `sync.log`.

## Settings

Change a setting with `ghostpm config set <key> <value>`. Add `--workspace <path>` to change it for one workspace only (not for the global-only keys marked below).

| Key | Values | Default |
|---|---|---|
| `sync_policy` | `off` (no sync), `auto` (push every task), `promote` (push on request, or on the first commit or PR), `linked-only` (never create vendor items; sync those already linked) | `off`; `ghostpm init` sets `auto` for its repo |
| `progress_comments` | `phase` (comment on the vendor item when the phase changes), `none` | `phase` |
| `create_branch` | `true` or `false`: check out `task/T42` when work starts | `false` |
| `phase_state_map` | phase to Azure DevOps state pairs, workspace only | learned by `ghostpm init` |
| `ado_work_item_type` | Azure DevOps work item type for new tasks, workspace only | `Task`, or learned by `ghostpm init` |
| `plan_globs` | files that count as plans or specs | `docs/**/{specs,plans}/**/*.md` |
| `sync_pull_minutes` | minutes between pulls, global only | `5` |
| `stale_session_minutes` | minutes without a heartbeat before a session counts as ended, global only | `10` |
| `max_push_attempts` | tries before a push is marked failed, global only | `8` |

Repos imported from 1.4.0 keep 1.4.0's behaviour: they are stamped `sync_policy` = `linked-only` and `progress_comments` = `none` wherever those are unset, on every server start. To change them, `set` a value (for example `ghostpm config set sync_policy auto --workspace <repo folder>`). `config unset` removes the value and the next start stamps it again.

## Where your data lives

`~/.ghostpm`, or `$GHOSTPM_HOME` if you set it:

| Path | What |
|---|---|
| `ledger.db`, `-wal`, `-shm` | The ledger: tasks, events, sessions, workspaces, the sync queue and settings |
| `hook.log` | Errors from hooks. A hook never interrupts a session. |
| `sync.log` | Sync runs: pushes and pulls that failed, and secrets redacted before a push |
| `hook.log.1`, `sync.log.1` | The previous log. A log over 1 MiB is moved here, replacing the one before, so each log takes about 2 MiB at most. |
| `native/better_sqlite3.node` | The SQLite addon built by `bootstrap` |
| `native-build/` | Where `bootstrap` ran npm. Safe to delete. |
| `ghostpm.js` | Statusline launcher, only after `setup --statusline` |
| `workspaces.json` | The 1.4.0 workspace list. Read once during the upgrade and never written. |

GhostPM stores no prompts. A session keeps only a pointer to Claude Code's own transcript.

## Upgrading from 1.4.0

2.0 is a breaking release. [CHANGELOG.md](CHANGELOG.md) lists every change and the upgrade steps: install the plugin and `npm install -g ghostpm@2`, open a Claude Code session so the first one imports your 1.4.0 repos, then run `ghostpm doctor` and the removal commands it prints.

## Troubleshooting

- **Nothing is being recorded.** Look in `~/.ghostpm/hook.log`, and run `ghostpm doctor`.
- **A push failed, or `⚠<n>` shows in the statusline.** Read `~/.ghostpm/sync.log`, then run `ghostpm sync` to retry.
- **"newer than this build", or `⚠ update GhostPM` in the statusline.** One of your copies is older than the ledger. Update both: `npm install -g ghostpm@latest` and `claude plugin update ghostpm@ghostpm`.
- **"cannot load SQLite".** Run `ghostpm bootstrap`.

## Development

```
git clone https://github.com/dpkay-io/ghostpm.git
cd ghostpm
npm ci
npm run build
npm test
claude --plugin-dir .
```

The last command runs your working copy as a plugin. To cut a release, follow [RELEASING.md](RELEASING.md).

## License

MIT
