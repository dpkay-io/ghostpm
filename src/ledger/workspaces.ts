import * as fs from 'fs';
import * as path from 'path';
import { findGitRoot, detectRemote, readGitdirLink } from '../init';
import { Ledger, write } from './db';
import { NO_VENDOR, Vendor, WorkspaceRow } from './types';

const GIT_ENTRY = '.git';
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
    const linked = readGitdirLink(dotGit);
    if (!linked) return normalizePath(gitRoot);

    const commonDirFile = path.join(linked, COMMONDIR_FILE);
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

/** Lookup only: unlike ensureWorkspace it never inserts, so a read-only connection can use it. */
export function findWorkspace(db: Ledger, cwd: string): WorkspaceRow | undefined {
    return getWorkspaceByPath(db, resolveWorkspaceRoot(cwd));
}

/** The workspace registered at exactly `folder`, with no git-root resolution: for a folder that may be gone. */
export function workspaceAtPath(db: Ledger, folder: string): WorkspaceRow | undefined {
    return getWorkspaceByPath(db, normalizePath(folder));
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

/**
 * Re-reads the git remote: a folder first seen before `git remote add` would otherwise stay vendor none forever.
 * No readable remote keeps what is stored. Answers the row as stored now.
 */
export function refreshWorkspaceRemote(db: Ledger, workspace: WorkspaceRow): WorkspaceRow {
    const remote = detectRemote(workspace.path);
    if (remote) db.prepare('UPDATE workspaces SET git_remote = ?, vendor = ? WHERE id = ?').run(remote.url, remote.vendor, workspace.id);
    return getWorkspace(db, workspace.id)!;
}

export interface WorkspaceFootprint {
    tasks: number;
    events: number;
    vendorLinks: number;
    outbox: number;
    sessions: number;
}

const WORKSPACE_TASK_IDS = 'SELECT id FROM tasks WHERE workspace_id = ?';

export function workspaceFootprint(db: Ledger, id: number): WorkspaceFootprint {
    const count = (sql: string): number => (db.prepare(sql).get(id) as { n: number }).n;
    return {
        tasks: count('SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ?'),
        events: count(`SELECT COUNT(*) AS n FROM events WHERE task_id IN (${WORKSPACE_TASK_IDS})`),
        vendorLinks: count(`SELECT COUNT(*) AS n FROM vendor_links WHERE task_id IN (${WORKSPACE_TASK_IDS})`),
        outbox: count(`SELECT COUNT(*) AS n FROM outbox WHERE task_id IN (${WORKSPACE_TASK_IDS})`),
        sessions: count('SELECT COUNT(*) AS n FROM sessions WHERE workspace_id = ?'),
    };
}

/** Forgets a workspace and everything recorded under it, in one transaction. The vendor is never touched. */
export function deleteWorkspace(db: Ledger, id: number): WorkspaceFootprint {
    return write(db, () => {
        const footprint = workspaceFootprint(db, id);
        db.prepare(`DELETE FROM events WHERE task_id IN (${WORKSPACE_TASK_IDS})`).run(id);
        db.prepare(`DELETE FROM vendor_links WHERE task_id IN (${WORKSPACE_TASK_IDS})`).run(id);
        db.prepare(`DELETE FROM outbox WHERE task_id IN (${WORKSPACE_TASK_IDS})`).run(id);
        // A session in another workspace can hold one of these tasks through a T-ref.
        db.prepare(`UPDATE sessions SET task_id = NULL WHERE task_id IN (${WORKSPACE_TASK_IDS})`).run(id);
        db.prepare('DELETE FROM sessions WHERE workspace_id = ?').run(id);
        db.prepare('DELETE FROM tasks WHERE workspace_id = ?').run(id);
        db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
        return footprint;
    });
}
