import {
    FLAG_ALL, FLAG_ONCE, FLAG_RESTORE, FLAG_SINCE, FLAG_STATUSLINE, FLAG_VERSION, FLAG_VERSION_SHORT, FLAG_YES,
} from './cli-args';
import { CONFIG_USAGE } from './config-cli';
import { DEFAULT_STANDUP_HOURS } from './surfaces/standup';

/**
 * The released plugin as `claude plugin install` names it: the plugin in .claude-plugin/plugin.json @ the marketplace in
 * .claude-plugin/marketplace.release.json (tests/version.test.ts holds it to both).
 */
export const PLUGIN_ID = 'ghostpm@ghostpm';
const USAGE_PREFIX = 'Usage: ghostpm ';

/** The `setup` lines: the one place they are written, so a setup usage message can print the same ones. */
/** What `ghostpm setup` says first: the plugin brings the server, the hooks and the skill. */
export const SETUP_NOTE = 'The GhostPM plugin brings the MCP server, the hooks and the skill; there is nothing else to install for them.';

export const SETUP_USAGE = `  setup ${FLAG_STATUSLINE}          Show the active task in the Claude Code statusline
  setup ${FLAG_RESTORE}             Put the statusline back the way it was`;

/** Every command src/cli-main.ts handles. tests/help.test.ts fails when one is missing. */
export const HELP_TEXT = `ghostpm - local-first task ledger for AI coding sessions

Usage: ghostpm <command> [options]

See what is happening
  dashboard [${FLAG_ONCE}]          Live view of this machine: sessions, tasks by workspace, sync health.
                              Ctrl+C quits; ${FLAG_ONCE} (or piped output) prints one frame.
  standup [${FLAG_SINCE} <when>]  What changed since <when> (default ${DEFAULT_STANDUP_HOURS}h): 90m, 36h, 2d, 1w, 2026-09-28, yesterday
  tasks [${FLAG_ALL}]               Open tasks from the ledger for this workspace (${FLAG_ALL}: every workspace)
  status                      This workspace: vendor, user, sprint, task counts, sync state

Vendor sync (off until ghostpm init or config set sync_policy turns it on)
  sync                        One sync pass now: push queued changes, pull vendor updates, resume a
                              paused workspace and retry failed pushes. Exits 1 when a push or pull failed.
  ${CONFIG_USAGE.slice(USAGE_PREFIX.length)}
                              Read or change a setting (sync_policy, progress_comments, ...)

Set up
  init                        Register this folder as a workspace, detect its vendor settings and turn sync on
  unregister [path] [${FLAG_YES}]   Forget a workspace and its local tasks; the vendor is untouched.
                              Without ${FLAG_YES} it only previews; ${FLAG_YES} deletes.
${SETUP_USAGE}
  doctor                      Find leftovers from GhostPM 1.4.0 and print the fixes; changes nothing
  bootstrap                   Build the native SQLite addon into the GhostPM home

Run by other programs
  serve                       MCP server (started by Claude Code and other MCP clients)
  statusline                  Statusline renderer (run by Claude Code)

  help, --help, -h            Show this help
  ${FLAG_VERSION}, ${FLAG_VERSION_SHORT}               Print the version

In Claude Code, install the plugin: claude plugin install ${PLUGIN_ID}
In a terminal: npm install -g ghostpm (Node.js 20 or newer)`;
