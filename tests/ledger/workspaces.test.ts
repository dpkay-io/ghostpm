import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tempLedger, TempLedger, seedOutboxRow } from './helpers';
import {
    normalizePath, resolveWorkspaceRoot, ensureWorkspace, findWorkspace, getWorkspace, setWorkspaceVendor,
    refreshWorkspaceRemote, workspaceFootprint, deleteWorkspace,
} from '../../src/ledger/workspaces';
import { createTask, insertVendorLink } from '../../src/ledger/tasks';
import { recordEvent } from '../../src/ledger/events';
import { startSession, setSessionTask, getSession } from '../../src/ledger/sessions';
import { STATUS_PENDING } from '../../src/ledger/projection';

describe('workspaces', () => {
    let ledger: TempLedger;
    let root: string;

    beforeEach(() => {
        ledger = tempLedger();
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-ws-'));
    });

    afterEach(() => {
        ledger.cleanup();
        fs.rmSync(root, { recursive: true, force: true });
    });

    describe('normalizePath', () => {
        it('resolves relative segments', () => {
            expect(normalizePath(path.join(root, 'a', '..', 'b'))).toBe(normalizePath(path.join(root, 'b')));
        });

        it('treats forward slashes like the platform separator', () => {
            expect(normalizePath(root.split(path.sep).join('/'))).toBe(normalizePath(root));
        });

        it('names a folder the same through a symlink as by its real path (macOS /var is /private/var)', () => {
            // A hook is told the cwd by the client, the CLI reads process.cwd(), which is always the real path.
            const real = path.join(root, 'real');
            const link = path.join(root, 'link');
            fs.mkdirSync(path.join(real, 'inner'), { recursive: true });
            fs.symlinkSync(real, link, 'junction');

            expect(normalizePath(link)).toBe(normalizePath(real));
            expect(normalizePath(path.join(link, 'inner'))).toBe(normalizePath(path.join(real, 'inner')));
            expect(ensureWorkspace(ledger.db, link).id).toBe(ensureWorkspace(ledger.db, real).id);
        });

        it('resolves the part of a path that exists when the folder itself is gone', () => {
            const real = path.join(root, 'real');
            const link = path.join(root, 'link');
            fs.mkdirSync(real);
            fs.symlinkSync(real, link, 'junction');

            expect(normalizePath(path.join(link, 'deleted', 'sub'))).toBe(normalizePath(path.join(real, 'deleted', 'sub')));
        });

        it('folds case on Windows only', () => {
            // A folder that does not exist: on a case-insensitive disk (macOS) an existing one resolves to its one real name.
            const missing = path.join(path.parse(root).root, 'ghostpm-no-such-folder', 'Sub');
            const upper = normalizePath(missing.toUpperCase());
            const lower = normalizePath(missing.toLowerCase());
            if (process.platform === 'win32') expect(upper).toBe(lower);
            else expect(upper).not.toBe(lower);
        });
    });

    describe('resolveWorkspaceRoot', () => {
        it('uses the folder itself outside git', () => {
            expect(resolveWorkspaceRoot(root)).toBe(normalizePath(root));
        });

        it('uses the git root from a subfolder', () => {
            fs.mkdirSync(path.join(root, '.git'));
            const sub = path.join(root, 'src', 'deep');
            fs.mkdirSync(sub, { recursive: true });
            expect(resolveWorkspaceRoot(sub)).toBe(normalizePath(root));
        });

        it('maps a linked worktree to its main repository', () => {
            // Layout verified against git 2.28: <wt>/.git is a file, <main>/.git/worktrees/<name>/commondir holds "../.."
            const main = path.join(root, 'main');
            const wt = path.join(root, 'wt');
            const worktreeGitDir = path.join(main, '.git', 'worktrees', 'wt');
            fs.mkdirSync(worktreeGitDir, { recursive: true });
            fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
            fs.mkdirSync(wt);
            fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${worktreeGitDir.split(path.sep).join('/')}\n`);
            expect(resolveWorkspaceRoot(wt)).toBe(normalizePath(main));
        });

        it('keeps a .git file without commondir (submodule) as its own workspace', () => {
            const sub = path.join(root, 'sub');
            const modulesDir = path.join(root, '.git', 'modules', 'sub');
            fs.mkdirSync(modulesDir, { recursive: true });
            fs.mkdirSync(sub);
            fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${modulesDir}\n`);
            expect(resolveWorkspaceRoot(sub)).toBe(normalizePath(sub));
        });
    });

    describe('ensureWorkspace', () => {
        it('creates a workspace with no vendor for a plain folder', () => {
            const ws = ensureWorkspace(ledger.db, root);
            expect(ws.path).toBe(normalizePath(root));
            expect(ws.vendor).toBe('none');
            expect(ws.git_remote).toBeNull();
            expect(JSON.parse(ws.settings)).toEqual({});
        });

        it('detects vendor and remote url from git config', () => {
            fs.mkdirSync(path.join(root, '.git'));
            fs.writeFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/app.git\n');
            const ws = ensureWorkspace(ledger.db, root);
            expect(ws.vendor).toBe('github');
            expect(ws.git_remote).toBe('https://github.com/acme/app.git');
        });

        it('returns the same row from any folder inside the workspace', () => {
            fs.mkdirSync(path.join(root, '.git'));
            const sub = path.join(root, 'sub');
            fs.mkdirSync(sub);
            expect(ensureWorkspace(ledger.db, sub).id).toBe(ensureWorkspace(ledger.db, root).id);
        });

        it('updates the vendor', () => {
            const ws = ensureWorkspace(ledger.db, root);
            setWorkspaceVendor(ledger.db, ws.id, 'azure_devops');
            expect(getWorkspace(ledger.db, ws.id)?.vendor).toBe('azure_devops');
        });
    });

    describe('findWorkspace', () => {
        it('finds an existing workspace from any folder inside it and never inserts one', () => {
            fs.mkdirSync(path.join(root, '.git'));
            const sub = path.join(root, 'sub');
            fs.mkdirSync(sub);
            expect(findWorkspace(ledger.db, sub)).toBeUndefined();
            expect(ledger.db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 0 });

            const created = ensureWorkspace(ledger.db, root);
            expect(findWorkspace(ledger.db, sub)?.id).toBe(created.id);
        });
    });

    describe('refreshWorkspaceRemote', () => {
        it('picks up a remote added after the folder was first seen', () => {
            const ws = ensureWorkspace(ledger.db, root);
            expect(ws.vendor).toBe('none');
            fs.mkdirSync(path.join(root, '.git'));
            fs.writeFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/app.git\n');

            const refreshed = refreshWorkspaceRemote(ledger.db, ws);

            expect(refreshed.vendor).toBe('github');
            expect(refreshed.git_remote).toBe('https://github.com/acme/app.git');
        });

        it('keeps what it has when no remote can be read', () => {
            const ws = ensureWorkspace(ledger.db, root);
            expect(refreshWorkspaceRemote(ledger.db, ws)).toEqual(ws);
        });

        it('answers the row as stored, not the copy it was handed', () => {
            const ws = ensureWorkspace(ledger.db, root);
            setWorkspaceVendor(ledger.db, ws.id, 'github');
            expect(refreshWorkspaceRemote(ledger.db, ws).vendor).toBe('github');
        });
    });

    describe('deleteWorkspace', () => {
        it('forgets the workspace and every row that belonged to it, and nothing else', () => {
            const otherDir = path.join(root, 'other');
            fs.mkdirSync(otherDir);
            const gone = ensureWorkspace(ledger.db, root);
            const kept = ensureWorkspace(ledger.db, otherDir);
            const doomed = createTask(ledger.db, { title: 'Doomed', phase: 'planned', workspaceId: gone.id, origin: 'local', source: 'test' });
            const survivor = createTask(ledger.db, { title: 'Survivor', phase: 'planned', workspaceId: kept.id, origin: 'local', source: 'test' });
            insertVendorLink(ledger.db, { taskId: doomed.id, vendor: 'github', remoteId: '7' });
            seedOutboxRow(ledger.db, doomed.id, STATUS_PENDING);
            startSession(ledger.db, { id: 'here', client: 'claude-code', cwd: root, workspaceId: gone.id });
            startSession(ledger.db, { id: 'visitor', client: 'claude-code', cwd: otherDir, workspaceId: kept.id });
            setSessionTask(ledger.db, 'visitor', doomed.id);
            recordEvent(ledger.db, { taskId: survivor.id, kind: 'comment', source: 'test', payload: { text: 'kept' } });

            expect(workspaceFootprint(ledger.db, gone.id)).toEqual({ tasks: 1, events: 1, vendorLinks: 1, outbox: 1, sessions: 1 });
            const removed = deleteWorkspace(ledger.db, gone.id);

            expect(removed).toEqual({ tasks: 1, events: 1, vendorLinks: 1, outbox: 1, sessions: 1 });
            // No row anywhere may still point at the deleted workspace or its tasks, including
            // any table Phase 3 added: this scan fails if deleteWorkspace misses one.
            const tables = (ledger.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(row => row.name);
            for (const table of tables) {
                const columns = (ledger.db.pragma(`table_info(${table})`) as { name: string }[]).map(column => column.name);
                if (columns.indexOf('workspace_id') >= 0) {
                    expect([table, ledger.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(gone.id)]).toEqual([table, { n: 0 }]);
                }
                if (columns.indexOf('task_id') >= 0) {
                    expect([table, ledger.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id = ?`).get(doomed.id)]).toEqual([table, { n: 0 }]);
                }
            }
            expect(getWorkspace(ledger.db, gone.id)).toBeUndefined();
            expect(getWorkspace(ledger.db, kept.id)).toBeDefined();
            expect(getSession(ledger.db, 'visitor')!.task_id).toBeNull();
            expect(ledger.db.prepare('SELECT COUNT(*) AS n FROM events WHERE task_id = ?').get(survivor.id)).toEqual({ n: 2 });
        });
    });
});
