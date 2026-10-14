import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface WorkspaceEntry {
    path: string;
    vendor: string;
    addedAt: string;
}

/** GhostPM 1.4.0's workspace list. Read once by the legacy import; nothing writes it any more. */
export const REGISTRY_FILE = 'workspaces.json';

/** The one answer to "where is home": setup, doctor and the ledger must agree, and os.homedir() is what tests can isolate. */
export function homeDir(): string {
    return os.homedir();
}

export function getGhostpmHome(): string {
    return process.env.GHOSTPM_HOME || path.join(homeDir(), '.ghostpm');
}

function getRegistryPath(): string {
    return path.join(getGhostpmHome(), REGISTRY_FILE);
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
