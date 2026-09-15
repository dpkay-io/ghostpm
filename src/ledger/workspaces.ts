import * as fs from 'fs';
import * as path from 'path';
import { findGitRoot, detectRemote } from '../init';
import { Ledger } from './db';
import { NO_VENDOR, Vendor, WorkspaceRow } from './types';

const GIT_ENTRY = '.git';
const GITDIR_LINE = /^gitdir:\s*(.+)$/m;
const COMMONDIR_FILE = 'commondir';
const FOLD_PATH_CASE = process.platform === 'win32';

export function normalizePath(p: string): string {
    const resolved = path.resolve(p);
    return FOLD_PATH_CASE ? resolved.toLowerCase() : resolved;
}

/** Main repository root for git (linked worktrees share it), otherwise the folder itself. Reads files only; no git process. */
export function resolveWorkspaceRoot(cwd: string): string {
    const gitRoot = findGitRoot(cwd);
    if (!gitRoot) return normalizePath(cwd);

    const dotGit = path.join(gitRoot, GIT_ENTRY);
    if (fs.statSync(dotGit).isDirectory()) return normalizePath(gitRoot);

    const gitdir = fs.readFileSync(dotGit, 'utf8').match(GITDIR_LINE);
    if (!gitdir) return normalizePath(gitRoot);

    const commonDirFile = path.join(path.resolve(gitRoot, gitdir[1].trim()), COMMONDIR_FILE);
    if (!fs.existsSync(commonDirFile)) return normalizePath(gitRoot);

    const commonDir = path.resolve(path.dirname(commonDirFile), fs.readFileSync(commonDirFile, 'utf8').trim());
    return normalizePath(path.basename(commonDir) === GIT_ENTRY ? path.dirname(commonDir) : commonDir);
}

export function getWorkspace(db: Ledger, id: number): WorkspaceRow | undefined {
    return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
}

function getWorkspaceByPath(db: Ledger, root: string): WorkspaceRow | undefined {
    return db.prepare('SELECT * FROM workspaces WHERE path = ?').get(root) as WorkspaceRow | undefined;
}

export function ensureWorkspace(db: Ledger, cwd: string): WorkspaceRow {
    const root = resolveWorkspaceRoot(cwd);
    const existing = getWorkspaceByPath(db, root);
    if (existing) return existing;
    const remote = detectRemote(root);
    // OR IGNORE: another process may insert the same workspace between the read and the insert.
    db.prepare('INSERT OR IGNORE INTO workspaces (path, git_remote, vendor) VALUES (?, ?, ?)')
        .run(root, remote?.url ?? null, remote?.vendor ?? NO_VENDOR);
    return getWorkspaceByPath(db, root)!;
}

export function setWorkspaceVendor(db: Ledger, id: number, vendor: Vendor): void {
    db.prepare('UPDATE workspaces SET vendor = ? WHERE id = ?').run(vendor, id);
}
