import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tempLedger, TempLedger } from './helpers';
import { normalizePath, resolveWorkspaceRoot, ensureWorkspace, getWorkspace, setWorkspaceVendor } from '../../src/ledger/workspaces';

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

        it('folds case on Windows only', () => {
            const upper = normalizePath(root.toUpperCase());
            const lower = normalizePath(root.toLowerCase());
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
});
