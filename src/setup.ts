import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { findGitRoot } from './init';

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

export async function setup(options: SetupOptions = {}): Promise<void> {
    const gitRoot = findGitRoot();
    const { command, args } = resolveServerCommand();
    const targets: string[] = [];

    if (gitRoot && !options.global) {
        const settingsPath = path.join(gitRoot, '.claude', 'settings.local.json');
        patchJsonFile(settingsPath, 'ghostpm', { command, args });
        targets.push(settingsPath);
    }

    if (options.global) {
        const home = process.env.HOME || process.env.USERPROFILE || '';
        const settingsPath = path.join(home, '.claude', 'settings.json');
        patchJsonFile(settingsPath, 'ghostpm', { command, args });
        targets.push(settingsPath);
    }

    const desktopPath = getClaudeDesktopConfigPath();
    if (desktopPath && fs.existsSync(path.dirname(desktopPath))) {
        const config: any = { command, args };
        if (gitRoot) config.cwd = gitRoot;
        patchJsonFile(desktopPath, 'ghostpm', config);
        targets.push(desktopPath);
    }

    if (options.silent) return;

    if (targets.length === 0) {
        console.log('No MCP clients detected. Add manually:');
        console.log(JSON.stringify({ mcpServers: { ghostpm: { command, args } } }, null, 2));
    } else {
        console.log('MCP server registered:');
        targets.forEach(t => console.log(`  + ${t}`));
    }
}
