import * as fs from 'fs';
import * as path from 'path';

export function findGitRoot(currentPath: string = process.cwd()): string | null {
    let dir = path.resolve(currentPath);
    while (true) {
        const gitPath = path.join(dir, '.git');
        if (fs.existsSync(gitPath)) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return null;
        }
        dir = parent;
    }
}

export interface RemoteInfo {
    vendor: 'github' | 'azure_devops';
    url: string;
}

const GITHUB_HOST = 'github.com';
const AZURE_HOSTS = ['dev.azure.com', 'visualstudio.com'];
const GITDIR_LINE = /^gitdir:\s*(.+)$/m;

export function readGitdirLink(gitEntryPath: string): string | null {
    try {
        const stat = fs.statSync(gitEntryPath);
        if (!stat.isFile()) return null;
        const content = fs.readFileSync(gitEntryPath, 'utf8');
        const match = content.match(GITDIR_LINE);
        if (!match) return null;
        return path.resolve(path.dirname(gitEntryPath), match[1].trim());
    } catch {
        return null;
    }
}

export function detectRemote(currentPath: string = process.cwd()): RemoteInfo | null {
    const gitRoot = findGitRoot(currentPath);
    if (!gitRoot) return null;

    const gitPath = path.join(gitRoot, '.git');
    const linked = readGitdirLink(gitPath);
    const configPath = path.join(linked ?? gitPath, 'config');
    if (!fs.existsSync(configPath)) return null;

    const configContent = fs.readFileSync(configPath, 'utf8');
    const urlLine = /^\s*url\s*=\s*(.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = urlLine.exec(configContent)) !== null) {
        const url = match[1].trim();
        if (url.includes(GITHUB_HOST)) return { vendor: 'github', url };
        if (AZURE_HOSTS.some(host => url.includes(host))) return { vendor: 'azure_devops', url };
    }
    return null;
}
