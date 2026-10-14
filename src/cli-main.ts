#!/usr/bin/env node

import * as path from 'path';

const command = process.argv[2];
const args = process.argv.slice(3);
const MAX_COL_WIDTH = 50;
const EXIT_FAILURE = 1;

function printHelp() {
    const help = `ghostpm - Zero-latency PM interface for AI agents

Usage: ghostpm <command>

Commands:
  init              Initialize project + auto-register MCP server
  setup             Install the skill (statusline untouched)
  setup --global    Install the skill for every project
  setup --statusline    Also show the active task in the statusline (off by default)
  setup --restore   Put the statusline back the way it was
  config get|set|unset <key> [value...] [--workspace <path>]
                    Read or change a setting (sync_policy, progress_comments, plan_globs, ...)
  tasks             List cached tasks
  sync              Push queued changes to GitHub / Azure DevOps and pull theirs now
                    (also resumes a paused workspace and retries failed pushes)
  status            Show sync status and config
  dashboard         Show all workspaces and task status
  unregister [path] Remove a workspace from the dashboard
  bootstrap         Build the native SQLite addon into the ghostpm home
  serve             Start MCP server (used by MCP clients)
  help              Show this help

Quick start:
  npm install -g ghostpm
  cd your-project
  ghostpm init`;

    console.log(help);
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}

function relativeTime(isoDate: string): string {
    const seconds = Math.round((Date.now() - new Date(isoDate).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    return `${Math.round(seconds / 86400)}d ago`;
}

async function main() {
    switch (command) {
        case 'serve': {
            const { PmServer } = await import('./mcp-server');
            await new PmServer().run();
            break;
        }

        case 'doctor': {
            const { diagnose } = await import('./doctor');
            const fs = await import('fs');
            const { execFileSync } = await import('child_process');
            const home = process.env.HOME || process.env.USERPROFILE || '';
            const findings = diagnose({
                settingsPath: path.join(home, '.claude', 'settings.json'),
                // The binary on PATH is a shim; the package sits beside it in node_modules.
                resolveGlobal: () => {
                    try {
                        const finder = process.platform === 'win32' ? 'where.exe' : 'which';
                        const shim = String(execFileSync(finder, ['ghostpm'])).split(/\r?\n/)[0].trim();
                        if (shim.length === 0) return null;
                        const installDir = path.join(path.dirname(shim), 'node_modules', 'ghostpm');
                        return fs.existsSync(installDir) ? installDir : null;
                    } catch {
                        return null;
                    }
                },
                hasLedgerCode: installDir => fs.existsSync(path.join(installDir, 'dist', 'ledger', 'db.js')),
            });
            if (findings.length === 0) {
                console.log('No problems found.');
            } else {
                findings.forEach(finding => {
                    console.log(`\n[${finding.code}]`);
                    console.log(`  ${finding.message}`);
                    console.log(`  fix: ${finding.fix}`);
                });
            }
            break;
        }

        case 'bootstrap': {
            const { bootstrapBinding } = await import('./bootstrap');
            console.log(`Native addon ready at ${bootstrapBinding()}`);
            break;
        }

        case 'statusline': {
            const { runStatusline, runPreviousCommand } = await import('./statusline');
            const { ledgerPath } = await import('./ledger/db');
            // Event-based read rather than `for await`: async stream iteration needs lib
            // support an es2016 target does not give, and this matches src/hook.ts.
            const stdin = await new Promise<string>(resolve => {
                let buffer = '';
                process.stdin.on('data', chunk => { buffer += chunk; });
                process.stdin.on('end', () => resolve(buffer));
            });
            process.stdout.write(runStatusline({ stdin, ledgerFile: ledgerPath(), run: runPreviousCommand }));
            break;
        }

        case 'init': {
            const { initMcpPm, findGitRoot } = await import('./init');
            await initMcpPm();
            const { setup } = await import('./setup');
            await setup();
            const { registerWorkspace } = await import('./registry');
            const { loadConfig } = await import('./config');
            const gitRoot = findGitRoot();
            if (gitRoot) {
                const config = loadConfig(gitRoot);
                registerWorkspace(gitRoot, config.vendor);
            }
            break;
        }

        case 'setup': {
            if (args.includes('--restore')) {
                const { restoreStatusline, userSettingsPath } = await import('./plugin-setup');
                const { openLedger, ledgerPath } = await import('./ledger/db');
                const settingsPath = userSettingsPath();
                const db = openLedger(ledgerPath());
                let restored: boolean;
                try {
                    restored = restoreStatusline(db, settingsPath);
                } finally {
                    db.close();
                }
                console.log(restored
                    ? `Statusline restored in ${settingsPath}`
                    : `Nothing to restore: the statusline in ${settingsPath} is not ghostpm's.`);
                break;
            }
            const { setup } = await import('./setup');
            await setup({
                global: args.includes('--global'),
                statusline: args.includes('--statusline'),
            });
            break;
        }

        case 'config': {
            const { runConfigCommand } = await import('./config-cli');
            const { openLedger, ledgerPath } = await import('./ledger/db');
            const db = openLedger(ledgerPath());
            try {
                console.log(runConfigCommand(db, args, process.cwd()));
            } finally {
                db.close();
            }
            break;
        }

        case 'tasks': {
            const { Engine } = await import('./engine');
            const engine = new Engine();
            const tasks = engine.getDb().getTasks();
            const config = engine.getConfig();
            const cols = config.views.list_columns;

            if (tasks.length === 0) {
                console.log('No tasks cached. Run `ghostpm sync` to fetch from remote.');
                break;
            }

            const widths = cols.map(col =>
                Math.min(MAX_COL_WIDTH,
                    Math.max(col.length, ...tasks.map(t => String((t as any)[col] ?? '').length))
                )
            );
            const pad = (s: string, w: number) => truncate(s, w) + ' '.repeat(Math.max(0, w - truncate(s, w).length));

            console.log(cols.map((c, i) => pad(c.toUpperCase(), widths[i])).join('  '));
            console.log(widths.map(w => '─'.repeat(w)).join('  '));
            for (const task of tasks) {
                console.log(cols.map((c, i) => pad(String((task as any)[c] ?? ''), widths[i])).join('  '));
            }
            break;
        }

        case 'sync': {
            const { syncCommandMain, sweepStaleArgDirs } = await import('./sync/runner');
            await sweepStaleArgDirs();
            const result = await syncCommandMain(args);
            if (result.output.length > 0) console.log(result.output);
            if (result.failed) process.exitCode = EXIT_FAILURE;
            break;
        }

        case 'status': {
            const { findGitRoot } = await import('./init');
            const fs = await import('fs');
            const gitRoot = findGitRoot();
            if (!gitRoot) {
                console.error('Not a git repository.');
                process.exit(1);
            }

            const configPath = path.join(gitRoot, '.mcp-pm.yml');
            if (!fs.existsSync(configPath)) {
                console.log('GhostPM not initialized. Run `ghostpm init`.');
                break;
            }

            const dbPath = path.join(gitRoot, '.mcp-pm.db');
            if (!fs.existsSync(dbPath)) {
                const { loadConfig } = await import('./config');
                const config = loadConfig();
                console.log(`Vendor:   ${config.vendor}`);
                console.log(`Config:   ${configPath}`);
                console.log('Database: not yet created (run `ghostpm sync`)');
                break;
            }

            const { Engine } = await import('./engine');
            const engine = new Engine();
            const state = engine.getProjectState();
            const db = engine.getDb();
            const pending = db.getPendingOutboxItems();
            const conflicts = db.getConflictedOutboxItems();
            const summary = engine.getSprintSummary(state.activeSprint?.name);
            const sprints = engine.getAvailableSprints();

            console.log(`Vendor:   ${state.vendor}`);
            console.log(`User:     ${state.currentUser || '(not detected)'}`);
            console.log(`Config:   ${configPath}`);
            console.log(`Sprint:   ${state.activeSprint?.name || '(none)'}`);
            if (sprints.length > 0) {
                console.log(`Sprints:  ${sprints.join(', ')}`);
            }
            console.log(`Tasks:    ${summary.total} total` +
                (Object.keys(summary.byState).length
                    ? ` (${Object.entries(summary.byState).map(([s, n]) => `${n} ${s}`).join(', ')})`
                    : ''));
            console.log(`Outbox:   ${pending.length} pending, ${conflicts.length} conflicts`);
            console.log(`Synced:   ${state.lastSync ? `${state.lastSync} (${relativeTime(state.lastSync)})` : 'never'}`);
            db.close();
            break;
        }

        case 'dashboard': {
            const { hasFlag, FLAG_ONCE } = await import('./cli-args');
            const { openReader } = await import('./ledger/db');
            const { runDashboard } = await import('./surfaces/live');
            const db = openReader();
            try {
                await runDashboard(db, process.stdout, { once: hasFlag(args, FLAG_ONCE) });
            } finally {
                db.close();
            }
            break;
        }

        case 'unregister': {
            const { unregisterWorkspace } = await import('./registry');
            const { findGitRoot } = await import('./init');
            const targetPath = process.argv[3] || findGitRoot() || process.cwd();
            const resolved = path.resolve(targetPath);
            if (unregisterWorkspace(resolved)) {
                console.log(`Unregistered workspace: ${resolved}`);
            } else {
                console.error(`Workspace not found in registry: ${resolved}`);
                process.exit(1);
            }
            break;
        }

        case 'help':
        case '--help':
        case '-h':
        case undefined:
            printHelp();
            break;

        default:
            console.error(`Unknown command: ${command}\n`);
            printHelp();
            process.exit(1);
    }
}

main().catch(e => {
    console.error(e.message || e);
    process.exit(1);
});
