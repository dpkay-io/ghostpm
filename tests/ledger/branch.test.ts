import * as fs from 'fs';
import * as path from 'path';
import { tempLedger, TempLedger } from './helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask } from '../../src/ledger/tasks';
import { startSession, setSessionTask } from '../../src/ledger/sessions';
import { TaskRow } from '../../src/ledger/types';
import {
    TASK_BRANCH_PREFIX, taskBranchName, taskRefFromBranch, currentBranch, activeTaskFor,
} from '../../src/ledger/branch';

const SESSION_ID = 'hook:test';

describe('branch', () => {
    let ledger: TempLedger;
    let repo: string;
    let workspaceId: number;

    const newTask = (title = 'Login fix'): TaskRow =>
        createTask(ledger.db, { title, phase: 'in_progress', workspaceId, origin: 'local', source: 'test' });

    const writeHead = (gitDir: string, content: string): void => {
        fs.mkdirSync(gitDir, { recursive: true });
        fs.writeFileSync(path.join(gitDir, 'HEAD'), content, 'utf8');
    };

    beforeEach(() => {
        ledger = tempLedger();
        repo = path.join(ledger.dir, 'repo');
        fs.mkdirSync(repo, { recursive: true });
        workspaceId = ensureWorkspace(ledger.db, repo).id;
    });

    afterEach(() => {
        ledger.cleanup();
    });

    describe('naming and parsing', () => {
        it('builds the branch name through formatTaskId', () => {
            const task = newTask();
            expect(taskBranchName(task.id)).toBe(`${TASK_BRANCH_PREFIX}T${task.id}`);
        });

        it('reads the task reference back out of a branch name', () => {
            expect(taskRefFromBranch('task/T42')).toBe('T42');
            expect(taskRefFromBranch('task/42')).toBe('42');
        });

        it('only matches at the start, so unrelated branches are ignored', () => {
            expect(taskRefFromBranch('master')).toBeNull();
            expect(taskRefFromBranch('feature/task/T1')).toBeNull();
            expect(taskRefFromBranch('task/')).toBeNull();
            expect(taskRefFromBranch(null)).toBeNull();
        });
    });

    describe('currentBranch', () => {
        it('reads .git/HEAD without spawning git', () => {
            writeHead(path.join(repo, '.git'), 'ref: refs/heads/task/T7\n');
            expect(currentBranch(repo)).toBe('task/T7');
        });

        it('follows a .git file to the linked directory, as worktrees use', () => {
            const linked = path.join(ledger.dir, 'linked-gitdir');
            writeHead(linked, 'ref: refs/heads/master\n');
            fs.writeFileSync(path.join(repo, '.git'), `gitdir: ${linked}\n`, 'utf8');
            expect(currentBranch(repo)).toBe('master');
        });

        it('returns null on a detached HEAD', () => {
            writeHead(path.join(repo, '.git'), '9fceb02c0e1f4a2e8b0d3c5a7d9e1f3b5c7a9d1e\n');
            expect(currentBranch(repo)).toBeNull();
        });

        it('returns null outside a repository', () => {
            expect(currentBranch(repo)).toBeNull();
        });
    });

    describe('activeTaskFor', () => {
        it('prefers the task already attached to the session', () => {
            const attached = newTask('Attached');
            const onBranch = newTask('On branch');
            startSession(ledger.db, { id: SESSION_ID, client: 'claude-code', cwd: repo, workspaceId });
            setSessionTask(ledger.db, SESSION_ID, attached.id);
            expect(activeTaskFor(ledger.db, SESSION_ID, taskBranchName(onBranch.id), workspaceId)?.id).toBe(attached.id);
        });

        it('falls back to the task named by the branch', () => {
            const task = newTask();
            startSession(ledger.db, { id: SESSION_ID, client: 'claude-code', cwd: repo, workspaceId });
            expect(activeTaskFor(ledger.db, SESSION_ID, taskBranchName(task.id), workspaceId)?.id).toBe(task.id);
        });

        it('returns undefined when neither the session nor the branch names a task', () => {
            startSession(ledger.db, { id: SESSION_ID, client: 'claude-code', cwd: repo, workspaceId });
            expect(activeTaskFor(ledger.db, SESSION_ID, 'master', workspaceId)).toBeUndefined();
            expect(activeTaskFor(ledger.db, SESSION_ID, null, workspaceId)).toBeUndefined();
        });

        it('does not reach another workspace through a bare branch number', () => {
            const other = ensureWorkspace(ledger.db, path.join(ledger.dir, 'other')).id;
            const foreign = createTask(ledger.db, { title: 'Elsewhere', phase: 'planned', workspaceId: other, origin: 'local', source: 'test' });
            startSession(ledger.db, { id: SESSION_ID, client: 'claude-code', cwd: repo, workspaceId });
            expect(activeTaskFor(ledger.db, SESSION_ID, `${TASK_BRANCH_PREFIX}${foreign.id}`, workspaceId)).toBeUndefined();
        });
    });
});
