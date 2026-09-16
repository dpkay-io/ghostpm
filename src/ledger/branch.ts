import * as fs from 'fs';
import * as path from 'path';
import { findGitRoot, readGitdirLink } from '../init';
import { Ledger } from './db';
import { getSession } from './sessions';
import { getTask, resolveTaskRef } from './tasks';
import { TaskRow, formatTaskId } from './types';

export const TASK_BRANCH_PREFIX = 'task/';
const BRANCH_TASK = new RegExp(`^${TASK_BRANCH_PREFIX}(.+)$`);
const GIT_ENTRY = '.git';
const HEAD_FILE = 'HEAD';
/** `ref: refs/heads/<branch>`; a detached HEAD holds a bare sha and matches nothing. */
const HEAD_REF = /^ref:\s*refs\/heads\/(.+)$/m;

export function taskBranchName(taskId: number): string {
    return `${TASK_BRANCH_PREFIX}${formatTaskId(taskId)}`;
}

export function taskRefFromBranch(branch: string | null): string | null {
    if (branch === null) return null;
    const match = branch.match(BRANCH_TASK);
    return match ? match[1] : null;
}

/**
 * Reads .git/HEAD rather than spawning `git rev-parse`: a hook runs on every prompt
 * and a process spawn does not fit the latency budget. Follows the `gitdir:` link so
 * worktrees resolve to their own HEAD.
 */
export function currentBranch(cwd: string): string | null {
    const gitRoot = findGitRoot(cwd);
    if (!gitRoot) return null;
    const entry = path.join(gitRoot, GIT_ENTRY);
    const gitDir = readGitdirLink(entry) ?? entry;
    try {
        const match = fs.readFileSync(path.join(gitDir, HEAD_FILE), 'utf8').match(HEAD_REF);
        return match ? match[1].trim() : null;
    } catch {
        return null;
    }
}

/** The session's task, or the task named by a task/<ref> branch. */
export function activeTaskFor(
    db: Ledger,
    sessionId: string,
    branch: string | null,
    workspaceId: number,
): TaskRow | undefined {
    const sessionTaskId = getSession(db, sessionId)?.task_id ?? null;
    if (sessionTaskId !== null) return getTask(db, sessionTaskId);
    const ref = taskRefFromBranch(branch);
    return ref === null ? undefined : resolveTaskRef(db, ref, workspaceId);
}
