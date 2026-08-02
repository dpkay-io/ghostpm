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
            const { initMcpPm } = await import('./init');
            await initMcpPm();
            const { setup } = await import('./setup');
            await setup();
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

            const { loadConfig } = await import('./config');
            const config = loadConfig();

            console.log(`Vendor:   ${config.vendor}`);
            console.log(`Config:   ${configPath}`);

            const dbPath = path.join(gitRoot, '.mcp-pm.db');
            if (fs.existsSync(dbPath)) {
                const { Db } = await import('./db');
                const db = new Db();
                const tasks = db.getTasks();
                const pending = db.getPendingOutboxItems();
                const conflicts = db.getConflictedOutboxItems();
                const lastSync = db.getMetadata('last_sync');

                console.log(`Tasks:    ${tasks.length} cached`);
                console.log(`Outbox:   ${pending.length} pending, ${conflicts.length} conflicts`);
                console.log(`Synced:   ${lastSync ? `${lastSync} (${relativeTime(lastSync)})` : 'never'}`);
                db.close();
            } else {
                console.log('Database: not yet created (run `ghostpm sync`)');
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
