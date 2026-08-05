import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { findGitRoot } from './init';
import { SKILL_CONTENT, PLUGIN_JSON } from './skill';

interface SetupOptions {
    global?: boolean;
    silent?: boolean;
}

function resolveServerCommand(): { command: string; args: string[] } {
    try {
        const finder = process.platform === 'win32' ? 'where.exe' : 'which';
        execFileSync(finder, ['ghostpm'], { stdio: 'ignore' });
        return { command: 'ghostpm', args: ['serve'] };
    } catch {
        return {
            command: 'node',
            args: [path.resolve(__dirname, 'cli-main.js'), 'serve']
        };
    }
}

function patchJsonFile(filePath: string, serverName: string, serverConfig: object): void {
    let existing: any = {};
    if (fs.existsSync(filePath)) {
        try {
            existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            existing = {};
        }
    }

    if (!existing.mcpServers) existing.mcpServers = {};
    existing.mcpServers[serverName] = serverConfig;

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
}

function getClaudeDesktopConfigPath(): string | null {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    switch (process.platform) {
        case 'win32':
            return process.env.APPDATA
                ? path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json')
                : null;
        case 'darwin':
            return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
        default:
            return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
    }
}

function tryClaudeMcpAdd(scope: string, command: string, args: string[]): boolean {
    try {
        const finder = process.platform === 'win32' ? 'where.exe' : 'which';
        execFileSync(finder, ['claude'], { stdio: 'ignore' });
    } catch {
        return false;
    }
    try {
        execFileSync('claude', ['mcp', 'add', 'ghostpm', '-s', scope, '--', command, ...args], { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

export async function setup(options: SetupOptions = {}): Promise<void> {
    const gitRoot = findGitRoot();
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const { command, args } = resolveServerCommand();
    const targets: string[] = [];

    // Claude CLI: use `claude mcp add` which writes to the correct internal config
    const cliScope = options.global ? 'user' : 'local';
    if (tryClaudeMcpAdd(cliScope, command, args)) {
        targets.push(`Claude CLI (scope: ${cliScope})`);
    } else if (gitRoot && !options.global) {
        const settingsPath = path.join(gitRoot, '.claude', 'settings.local.json');
        patchJsonFile(settingsPath, 'ghostpm', { command, args });
        targets.push(settingsPath);
    } else if (options.global && home) {
        const settingsPath = path.join(home, '.claude', 'settings.json');
        patchJsonFile(settingsPath, 'ghostpm', { command, args });
        targets.push(settingsPath);
    }

    // Claude Desktop: patch its config file directly
    const desktopPath = getClaudeDesktopConfigPath();
    if (desktopPath && fs.existsSync(path.dirname(desktopPath))) {
        const config: any = { command, args };
        if (gitRoot) config.cwd = gitRoot;
        patchJsonFile(desktopPath, 'ghostpm', config);
        targets.push(desktopPath);
    }

    // Install companion skill plugin for auto-discovery
    const skillTargets: string[] = [];
    const skillBase = (options.global && home)
        ? path.join(home, '.claude', 'skills', 'ghostpm')
        : gitRoot
            ? path.join(gitRoot, '.claude', 'skills', 'ghostpm')
            : null;

    if (skillBase) {
        const pluginDir = path.join(skillBase, '.claude-plugin');
        if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir, { recursive: true });
        fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(PLUGIN_JSON, null, 2) + '\n', 'utf8');
        fs.writeFileSync(path.join(skillBase, 'SKILL.md'), SKILL_CONTENT, 'utf8');
        skillTargets.push(skillBase);

        // Clean up legacy flat skill file
        const legacyPath = path.join(path.dirname(skillBase), 'ghostpm.md');
        if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
    }

    if (options.silent) return;

    if (targets.length === 0) {
        console.log('No MCP clients detected. Add manually:');
        console.log(JSON.stringify({ mcpServers: { ghostpm: { command, args } } }, null, 2));
    } else {
        console.log('MCP server registered:');
        targets.forEach(t => console.log(`  + ${t}`));
    }
    if (skillTargets.length > 0) {
        console.log('Skill installed:');
        skillTargets.forEach(t => console.log(`  + ${t}`));
    }
}
