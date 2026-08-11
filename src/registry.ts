import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface WorkspaceEntry {
    path: string;
    vendor: string;
    addedAt: string;
}

function getRegistryDir(): string {
    return process.env.GHOSTPM_HOME || path.join(os.homedir(), '.ghostpm');
}

function getRegistryPath(): string {
    return path.join(getRegistryDir(), 'workspaces.json');
}

export function getWorkspaces(): WorkspaceEntry[] {
    const filePath = getRegistryPath();
    if (!fs.existsSync(filePath)) return [];
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function saveWorkspaces(workspaces: WorkspaceEntry[]): void {
    const dir = getRegistryDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getRegistryPath(), JSON.stringify(workspaces, null, 2), 'utf8');
}

export function registerWorkspace(gitRoot: string, vendor: string): void {
    const workspaces = getWorkspaces();
    const existing = workspaces.findIndex(w => w.path === gitRoot);
    const entry: WorkspaceEntry = { path: gitRoot, vendor, addedAt: new Date().toISOString() };

    if (existing >= 0) {
        workspaces[existing] = entry;
    } else {
        workspaces.push(entry);
    }

    saveWorkspaces(workspaces);
}

export function unregisterWorkspace(gitRoot: string): boolean {
    const workspaces = getWorkspaces();
    const idx = workspaces.findIndex(w => w.path === gitRoot);
    if (idx < 0) return false;
    workspaces.splice(idx, 1);
    saveWorkspaces(workspaces);
    return true;
}
