#!/usr/bin/env node

import * as path from 'path';
import { FLAG_GLOBAL, FLAG_RESTORE, FLAG_STATUSLINE, FLAG_VERSION, FLAG_VERSION_SHORT } from './cli-args';

const command = process.argv[2];
const args = process.argv.slice(3);
const EXIT_FAILURE = 1;

async function printHelp(): Promise<void> {
    const { HELP_TEXT } = await import('./help');
    console.log(HELP_TEXT);
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
            const { openLedger } = await import('./ledger/db');
            const { initWorkspace, describeInit } = await import('./workspace-commands');
            const db = openLedger();
            try {
                console.log(describeInit(await initWorkspace(db, process.cwd())));
            } finally {
                db.close();
            }
            break;
        }

        case 'setup': {
            if (args.includes(FLAG_RESTORE)) {
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
                global: args.includes(FLAG_GLOBAL),
                statusline: args.includes(FLAG_STATUSLINE),
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
            const { hasFlag, FLAG_ALL } = await import('./cli-args');
            const { openReader } = await import('./ledger/db');
            const { findWorkspace } = await import('./ledger/workspaces');
            const { renderTaskList, NOT_A_WORKSPACE } = await import('./surfaces/task-views');
            const db = openReader();
            try {
                if (hasFlag(args, FLAG_ALL)) {
                    console.log(renderTaskList(db, undefined));
                } else {
                    const workspace = findWorkspace(db, process.cwd());
                    console.log(workspace ? renderTaskList(db, workspace.id) : NOT_A_WORKSPACE);
                }
            } finally {
                db.close();
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
            const { openReader, ledgerPath } = await import('./ledger/db');
            const { findWorkspace } = await import('./ledger/workspaces');
            const { renderStatus, NOT_A_WORKSPACE } = await import('./surfaces/task-views');
            const ledgerFile = ledgerPath();
            const db = openReader(ledgerFile);
            try {
                const workspace = findWorkspace(db, process.cwd());
                console.log(workspace ? renderStatus(db, workspace, ledgerFile) : NOT_A_WORKSPACE);
            } finally {
                db.close();
            }
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

        case 'standup': {
            const { flagValue, FLAG_SINCE } = await import('./cli-args');
            const { parseSince } = await import('./surfaces/since');
            const { buildStandup, defaultStandupSince } = await import('./surfaces/standup');
            const { openReader } = await import('./ledger/db');
            // Read --since before opening anything: a typo fails fast with the accepted forms.
            const sinceArg = flagValue(args, FLAG_SINCE);
            const since = sinceArg === undefined ? defaultStandupSince() : parseSince(sinceArg);
            const db = openReader();
            try {
                console.log(buildStandup(db, since));
            } finally {
                db.close();
            }
            break;
        }

        case 'unregister': {
            const { firstPositional, hasFlag, FLAG_YES } = await import('./cli-args');
            const { openLedger, openReader } = await import('./ledger/db');
            const { workspaceFootprint } = await import('./ledger/workspaces');
            const { describeUnregister, unregisterTarget, unregisterWorkspace } = await import('./workspace-commands');
            const target = path.resolve(firstPositional(args) ?? process.cwd());
            const confirmed = hasFlag(args, FLAG_YES);
            // The preview only reads: it never creates, migrates or locks the ledger.
            const db = confirmed ? openLedger() : openReader();
            try {
                const workspace = unregisterTarget(db, target);
                if (!workspace) {
                    console.error(`No GhostPM workspace at ${target}.`);
                    process.exitCode = EXIT_FAILURE;
                } else if (!confirmed) {
                    console.log(describeUnregister(workspace, workspaceFootprint(db, workspace.id), false));
                } else {
                    console.log(describeUnregister(workspace, unregisterWorkspace(db, workspace), true));
                }
            } finally {
                db.close();
            }
            break;
        }

        case FLAG_VERSION:
        case FLAG_VERSION_SHORT: {
            const { packageVersion } = await import('./package-info');
            console.log(packageVersion());
            break;
        }

        case 'help':
        case '--help':
        case '-h':
        case undefined:
            await printHelp();
            break;

        default:
            console.error(`Unknown command: ${command}\n`);
            await printHelp();
            process.exit(1);
    }
}

main().catch(e => {
    console.error(e.message || e);
    process.exit(1);
});
