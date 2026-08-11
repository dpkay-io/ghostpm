#!/usr/bin/env node

import * as path from 'path';

const command = process.argv[2];
const MAX_COL_WIDTH = 50;

function printHelp() {
    const help = `ghostpm - Zero-latency PM interface for AI agents

Usage: ghostpm <command>

Commands:
  init              Initialize project + auto-register MCP server
  setup             Register MCP server with Claude Code / Claude Desktop
  setup --global    Register in global Claude Code settings
  tasks             List cached tasks
  sync              Force sync with remote
  status            Show sync status and config
  dashboard         Show all workspaces and task status
  unregister [path] Remove a workspace from the dashboard
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
            const { setup } = await import('./setup');
            const flags = process.argv.slice(3);
            await setup({ global: flags.includes('--global') });
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
            const { Engine } = await import('./engine');
            const engine = new Engine();
            process.stdout.write('Syncing...');
            await engine.sync();
            const tasks = engine.getDb().getTasks();
            console.log(` done. ${tasks.length} tasks cached.`);
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
            const { getWorkspaces } = await import('./registry');
            const { Db } = await import('./db');
            const fs = await import('fs');

            const workspaces = getWorkspaces();
            if (workspaces.length === 0) {
                console.log('No workspaces registered. Run `ghostpm init` in a project to register it.');
                break;
            }

            const DONE_STATES = new Set(['closed', 'resolved', 'done']);
            const MAX_PER_GROUP = 50;
            const cols = ['id', 'state', 'title', 'assignee'];

            for (const ws of workspaces) {
                const name = path.basename(ws.path);
                const dbPath = path.join(ws.path, '.mcp-pm.db');

                if (!fs.existsSync(dbPath)) {
                    console.log(`\n━━━ ${name} ━━━ (no database — run ghostpm sync)`);
                    console.log(`  ${ws.vendor} · ${ws.path}`);
                    continue;
                }

                let db: InstanceType<typeof Db>;
                try {
                    db = new Db(ws.path);
                } catch {
                    console.log(`\n━━━ ${name} ━━━ (unavailable)`);
                    console.log(`  ${ws.path}`);
                    continue;
                }

                const allTasks = db.getTasks();
                const lastSync = db.getMetadata('last_sync');
                const syncLabel = lastSync ? relativeTime(lastSync) : 'never synced';

                const active = allTasks.filter(t => !DONE_STATES.has(t.state.toLowerCase()));
                const done = allTasks.filter(t => DONE_STATES.has(t.state.toLowerCase()));

                console.log(`\n━━━ ${name} ━━━ ${syncLabel} ━━━`);
                console.log(`  ${ws.vendor} · ${ws.path}`);
                console.log(`  ${active.length} active · ${done.length} done`);

                const printGroup = (label: string, tasks: typeof allTasks) => {
                    if (tasks.length === 0) return;
                    const limited = tasks.slice(0, MAX_PER_GROUP);
                    console.log(`\n  ${label}:`);

                    const widths = cols.map(col =>
                        Math.min(MAX_COL_WIDTH,
                            Math.max(col.length, ...limited.map(t => String((t as any)[col] ?? '').length))
                        )
                    );
                    const pad = (s: string, w: number) => truncate(s, w) + ' '.repeat(Math.max(0, w - truncate(s, w).length));

                    console.log('  ' + cols.map((c, i) => pad(c.toUpperCase(), widths[i])).join('  '));
                    console.log('  ' + widths.map(w => '─'.repeat(w)).join('  '));
                    for (const task of limited) {
                        console.log('  ' + cols.map((c, i) => pad(String((task as any)[c] ?? ''), widths[i])).join('  '));
                    }
                    if (tasks.length > MAX_PER_GROUP) {
                        console.log(`  ... and ${tasks.length - MAX_PER_GROUP} more`);
                    }
                };

                printGroup('Active', active);
                printGroup('Done', done);

                db.close();
            }
            console.log('');
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
