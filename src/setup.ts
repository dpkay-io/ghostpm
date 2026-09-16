import * as fs from 'fs';
import * as path from 'path';
import { findGitRoot } from './init';
import { SKILL_CONTENT, PLUGIN_JSON } from './skill';
import { openLedger, ledgerPath } from './ledger/db';
import { chainStatusline, userSettingsPath } from './plugin-setup';

interface SetupOptions {
    global?: boolean;
    silent?: boolean;
}

const CLAUDE_DIR = '.claude';
const SKILL_FILE = 'SKILL.md';
const LEGACY_SKILL_FILE = 'ghostpm.md';

function homeDir(): string {
    return process.env.HOME || process.env.USERPROFILE || '';
}

function skillDir(options: SetupOptions, gitRoot: string | null): string | null {
    const base = options.global ? homeDir() : gitRoot;
    return base ? path.join(base, CLAUDE_DIR, 'skills', 'ghostpm') : null;
}

function installSkill(target: string): void {
    const pluginDir = path.join(target, '.claude-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(PLUGIN_JSON, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(target, SKILL_FILE), SKILL_CONTENT, 'utf8');

    const legacy = path.join(path.dirname(target), LEGACY_SKILL_FILE);
    if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
}

/**
 * Does only what the plugin cannot. The MCP server and the hooks are declared by
 * .mcp.json and hooks/hooks.json in the plugin itself, so setup no longer registers
 * a server anywhere: doing that is what left machines pointed at a stale global
 * install instead of the plugin.
 */
export async function setup(options: SetupOptions = {}): Promise<void> {
    const gitRoot = findGitRoot();
    const settingsPath = userSettingsPath();

    const db = openLedger(ledgerPath());
    try {
        chainStatusline(db, settingsPath);
    } finally {
        db.close();
    }

    const target = skillDir(options, gitRoot);
    if (target) installSkill(target);

    if (options.silent) return;

    console.log('Statusline chained:');
    console.log(`  + ${settingsPath}`);
    if (target) {
        console.log('Skill installed:');
        console.log(`  + ${target}`);
    }
    console.log('\nThe MCP server and hooks come from the plugin itself.');
    console.log('Run `ghostpm doctor` to check what this machine is configured to run.');
}
