import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
    tempLedger, TempLedger, eventKinds, isolateHomes, linkedWorktree, outboxRows, seedLegacyDb, LEGACY_GITHUB_CONFIG, LegacyOutboxItem,
} from './helpers';
import { listTasks, getVendorLink, insertTaskRow, insertVendorLink } from '../../src/ledger/tasks';
import { ensureWorkspace, getWorkspace, normalizePath, setWorkspaceVendor } from '../../src/ledger/workspaces';
import { REGISTRY_FILE } from '../../src/registry';
import log = require('../../src/hook/log');
import { SYNC_LOG_FILE } from '../../src/hook/log';
import {
    getWorkspaceSetting, setWorkspaceSetting, setSetting, readSetting,
    SETTING_ACTIVE_SPRINT, SETTING_CURRENT_USER, SETTING_PHASE_STATE_MAP, SETTING_PROGRESS_COMMENTS,
    SETTING_SYNC_POLICY, SYNC_POLICY_AUTO, SYNC_POLICY_LINKED_ONLY, SYNC_POLICY_OFF, PROGRESS_COMMENTS_NONE, PROGRESS_COMMENTS_PHASE,
} from '../../src/ledger/settings';
import { Phase } from '../../src/ledger/types';
import {
    importLegacyWorkspace, discoverLegacyRoots, runLegacyImport, vendorStateToPhase, knownStatePhase,
    LEGACY_CONFIG_FILE, LEGACY_DB_FILE, LEGACY_IMPORT_SETTING, LEGACY_SOURCE,
} from '../../src/ledger/legacy-import';

const ADO_CONFIG = `vendor: "azure_devops"
workflow:
  states: ["new", "active", "resolved", "closed", "removed"]
  transitions:
    start_task: "active"
    code_push: "resolved"
views:
  list_columns: ["id", "state", "title", "assignee"]
  detail_fields: ["id", "title", "body", "comments"]
`;
/** The per-workspace stamp a build before per-root tracking wrote (one time, no roots). */
const WORKSPACE_STAMP = '2026-10-01T00:00:00.000Z';
const PRE_RELEASE_STAMP = '2026-09-20T00:00:00.000Z';
const WORKTREE_NAME = 'wt';
const STATE_CASES: [string, Phase][] = [
    ['Open', 'planned'],
    ['Active', 'in_progress'],
    ['Resolved', 'in_review'],
    ['closed', 'done'],
    ['Removed', 'dropped'],
    ['something else', 'planned'],
];

describe('legacy import', () => {
    let ledger: TempLedger;
    let repo: string;
    let tmpHome: string;
    let restoreHomes: () => void;

    const createLegacyRepo = (config: string = LEGACY_GITHUB_CONFIG): string => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-legacy-'));
        fs.mkdirSync(path.join(root, '.git'));
        fs.writeFileSync(path.join(root, LEGACY_CONFIG_FILE), config, 'utf8');
        return root;
    };

    /** Two cached issues, 1.4.0's user and sprint, and whatever it left in its outbox. */
    const seedLegacyRepo = (root: string, outbox: LegacyOutboxItem[] = []): void => seedLegacyDb(root, [
        {
            id: '42', title: 'Login fix', state: 'in_progress', assignee: 'dpk',
            body: 'details', comments: 'first\n---\nsecond', updatedAt: '2026-09-10T00:00:00.000Z',
            labels: '["bug"]', milestone: 'Sprint 1', url: 'https://github.com/acme/app/issues/42',
        },
        { id: '43', title: 'Closed one', state: 'closed' },
    ], { current_user: 'dpk-jha', active_sprint: JSON.stringify({ name: 'Sprint 1' }) }, outbox);

    const writeRegistry = (paths: string[]): void => {
        fs.writeFileSync(
            path.join(tmpHome, REGISTRY_FILE),
            JSON.stringify(paths.map(p => ({ path: p, vendor: 'github', addedAt: new Date().toISOString() }))),
            'utf8',
        );
    };

    /** A linked worktree of `main` with its own 1.4.0 config and cache: it resolves to main's workspace. */
    const createLegacyWorktree = (main: string): string => {
        const root = linkedWorktree(main, fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-legacy-wt-')), WORKTREE_NAME);
        fs.writeFileSync(path.join(root, LEGACY_CONFIG_FILE), LEGACY_GITHUB_CONFIG, 'utf8');
        seedLegacyDb(root, [{ id: '7', title: 'Worktree only', state: 'open' }], {}, [
            { taskId: '7', action: 'updateTask', payload: JSON.stringify({ comment: 'from the worktree' }), status: 'pending' },
        ]);
        return root;
    };

    const titlesIn = (workspaceId: number): string[] => listTasks(ledger.db, { workspaceId }).map(t => t.title).sort();

    /** 1.4.0's outbox: a state change with a comment it never pushed, and a comment it gave up on. */
    const UNPUSHED: LegacyOutboxItem[] = [
        { taskId: '42', action: 'updateTask', payload: JSON.stringify({ state: 'in_review', comment: 'from 1.4.0' }), status: 'pending' },
        { taskId: '42', action: 'updateTask', payload: JSON.stringify({ comment: 'gave up' }), status: 'failed' },
    ];
    /** A change 1.4.0 queued for an issue its cache no longer holds. */
    const UNCACHED: LegacyOutboxItem[] = [
        { taskId: '99', action: 'updateTask', payload: JSON.stringify({ comment: 'uncached' }), status: 'pending' },
    ];

    beforeEach(() => {
        ledger = tempLedger();
        repo = createLegacyRepo();
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-home-'));
        restoreHomes = isolateHomes(tmpHome);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        restoreHomes();
        ledger.cleanup();
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it.each(STATE_CASES)('maps vendor state %s to phase %s', (state, phase) => {
        expect(vendorStateToPhase(state)).toBe(phase);
    });

    it('knows a state or says it does not, without falling back', () => {
        expect(knownStatePhase(' Active ')).toBe('in_progress');
        expect(knownStatePhase('To Do')).toBe('planned');
        expect(knownStatePhase('something else')).toBeUndefined();
        // Not a property lookup: inherited names are not states.
        expect(knownStatePhase('constructor')).toBeUndefined();
    });

    it('imports tasks, vendor links, comments and metadata', () => {
        seedLegacyRepo(repo);
        const result = importLegacyWorkspace(ledger.db, repo);
        expect(result).toMatchObject({ imported: 2, skipped: 0 });

        const tasks = listTasks(ledger.db, { workspaceId: result.workspaceId });
        expect(tasks.map(t => t.title).sort()).toEqual(['Closed one', 'Login fix']);
        const login = tasks.find(t => t.title === 'Login fix')!;
        expect(login).toMatchObject({ phase: 'in_progress', origin: 'vendor', assignee: 'dpk', milestone: 'Sprint 1', body: 'details' });
        expect(getVendorLink(ledger.db, login.id)).toMatchObject({
            vendor: 'github', remote_id: '42', remote_state: 'in_progress',
            remote_url: 'https://github.com/acme/app/issues/42', labels: '["bug"]',
            remote_updated_at: '2026-09-10T00:00:00.000Z',
        });
        expect(eventKinds(ledger.db, login.id)).toEqual(['created', 'comment', 'comment']);
        expect(getWorkspace(ledger.db, result.workspaceId)?.vendor).toBe('github');
        expect(getWorkspaceSetting(ledger.db, result.workspaceId, SETTING_CURRENT_USER)).toBe('dpk-jha');
        expect(getWorkspaceSetting(ledger.db, result.workspaceId, SETTING_ACTIVE_SPRINT)).toBe('Sprint 1');
    });

    it('reads the 1.4.0 database through the bootstrapped addon when the plugin copy has none (a plugin install)', () => {
        seedLegacyRepo(repo);
        const previous = process.env.GHOSTPM_HOME;
        process.env.GHOSTPM_HOME = path.join(tmpHome, '.ghostpm');
        try {
            jest.isolateModules(() => {
                // What a plugin install leaves: no addon of its own (`npm ci --ignore-scripts`), only the one
                // `ghostpm bootstrap` built into the ghostpm home, which loads only when named as nativeBinding.
                jest.doMock('better-sqlite3', () => {
                    const Real = jest.requireActual('better-sqlite3');
                    return function PluginInstall(file: string, options: { nativeBinding?: string } = {}) {
                        if (options.nativeBinding === undefined) {
                            throw new Error('Could not locate the bindings file. Tried:\n → /x/build/Release/better_sqlite3.node');
                        }
                        const { nativeBinding: _bootstrapped, ...rest } = options;
                        return new Real(file, rest);
                    };
                });
                const binding = require('../../src/ledger/binding') as typeof import('../../src/ledger/binding');
                fs.mkdirSync(path.dirname(binding.bootstrappedBindingPath()), { recursive: true });
                fs.writeFileSync(binding.bootstrappedBindingPath(), 'stands in for the bootstrapped addon');
                const isolated = require('../../src/ledger/legacy-import') as typeof import('../../src/ledger/legacy-import');

                expect(isolated.importLegacyWorkspace(ledger.db, repo)).toMatchObject({ imported: 2, skipped: 0 });
            });
        } finally {
            jest.dontMock('better-sqlite3');
            if (previous === undefined) delete process.env.GHOSTPM_HOME; else process.env.GHOSTPM_HOME = previous;
        }
    });

    it('skips tasks that are already imported when run again', () => {
        seedLegacyRepo(repo);
        importLegacyWorkspace(ledger.db, repo);
        const second = importLegacyWorkspace(ledger.db, repo);
        expect(second).toMatchObject({ imported: 0, skipped: 2 });
        expect(listTasks(ledger.db, { workspaceId: second.workspaceId })).toHaveLength(2);
    });

    it('registers the workspace even when no legacy database exists', () => {
        const result = importLegacyWorkspace(ledger.db, repo);
        expect(result).toMatchObject({ imported: 0, skipped: 0 });
        expect(getWorkspace(ledger.db, result.workspaceId)?.vendor).toBe('github');
        expect(getWorkspaceSetting(ledger.db, result.workspaceId, SETTING_SYNC_POLICY)).toBe(SYNC_POLICY_LINKED_ONLY);
    });

    it('leaves the legacy database readable and unchanged', () => {
        seedLegacyRepo(repo);
        importLegacyWorkspace(ledger.db, repo);
        expect(fs.existsSync(path.join(repo, LEGACY_DB_FILE))).toBe(true);
        const legacy = new Database(path.join(repo, LEGACY_DB_FILE), { readonly: true });
        try {
            expect(legacy.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 2 });
        } finally {
            legacy.close();
        }
    });

    it('discovers roots from ~/.claude.json, ignoring folders with no legacy config', () => {
        const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-plain-'));
        const claudeJson = path.join(tmpHome, 'claude.json');
        const asJsonKey = (p: string) => p.split(path.sep).join('/');
        fs.writeFileSync(claudeJson, JSON.stringify({ projects: { [asJsonKey(repo)]: {}, [asJsonKey(plain)]: {} } }), 'utf8');
        try {
            const roots = discoverLegacyRoots(claudeJson).map(normalizePath);
            expect(roots).toContain(normalizePath(repo));
            expect(roots).not.toContain(normalizePath(plain));
        } finally {
            fs.rmSync(plain, { recursive: true, force: true });
        }
    });

    it('falls back to registry-only roots when ~/.claude.json does not exist', () => {
        writeRegistry([repo]);
        const missing = path.join(tmpHome, 'does-not-exist.json');
        const roots = discoverLegacyRoots(missing).map(normalizePath);
        expect(roots).toEqual([normalizePath(repo)]);
    });

    it('falls back to registry-only roots when ~/.claude.json is malformed', () => {
        writeRegistry([repo]);
        const malformed = path.join(tmpHome, 'malformed.json');
        fs.writeFileSync(malformed, '{ not valid json', 'utf8');
        const roots = discoverLegacyRoots(malformed).map(normalizePath);
        expect(roots).toEqual([normalizePath(repo)]);
    });

    it('imports each repo once, and a repo set up later on the next start', () => {
        seedLegacyRepo(repo);
        expect(runLegacyImport(ledger.db, [repo])).toHaveLength(1);
        const workspaceId = ensureWorkspace(ledger.db, repo).id;
        expect(getWorkspaceSetting(ledger.db, workspaceId, LEGACY_IMPORT_SETTING)).toBeDefined();

        const later = createLegacyRepo();
        try {
            const second = runLegacyImport(ledger.db, [repo, later]);
            expect(second.map(result => normalizePath(result.root))).toEqual([normalizePath(later)]);
        } finally {
            fs.rmSync(later, { recursive: true, force: true });
        }
    });

    it('does not reopen the legacy database of a repo it already imported', () => {
        seedLegacyRepo(repo);
        runLegacyImport(ledger.db, [repo]);
        fs.writeFileSync(path.join(repo, LEGACY_DB_FILE), 'not a database');   // opening it now would throw
        const errorSpy = jest.spyOn(console, 'error').mockImplementation();
        try {
            expect(runLegacyImport(ledger.db, [repo])).toEqual([]);
            expect(errorSpy).not.toHaveBeenCalled();
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('keeps importing the other repos when one fails', () => {
        const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-broken-'));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation();
        try {
            seedLegacyRepo(repo);
            expect(runLegacyImport(ledger.db, [broken, repo])).toHaveLength(1);
            expect(errorSpy).toHaveBeenCalled();
        } finally {
            errorSpy.mockRestore();
            fs.rmSync(broken, { recursive: true, force: true });
        }
    });

    it('queues the changes 1.4.0 left unpushed, once', () => {
        // No sync_policy is set anywhere: the queue projects only because the import stamps linked-only first.
        seedLegacyRepo(repo, UNPUSHED);
        const result = importLegacyWorkspace(ledger.db, repo);
        const task = listTasks(ledger.db, { workspaceId: result.workspaceId }).find(t => t.title === 'Login fix')!;
        expect(getWorkspaceSetting(ledger.db, result.workspaceId, SETTING_SYNC_POLICY)).toBe(SYNC_POLICY_LINKED_ONLY);
        expect(result.queued).toBe(2);
        expect(outboxRows(ledger.db, task.id).map(row => [row.op, row.payload])).toEqual([
            ['sync_state', null],
            ['comment', JSON.stringify({ text: 'from 1.4.0' })],
        ]);
        expect(importLegacyWorkspace(ledger.db, repo).queued).toBe(0);
        expect(outboxRows(ledger.db, task.id)).toHaveLength(2);
    });

    it('imports the Azure DevOps phase map from .mcp-pm.yml', () => {
        const ado = createLegacyRepo(ADO_CONFIG);
        try {
            const result = importLegacyWorkspace(ledger.db, ado);
            expect(getWorkspaceSetting(ledger.db, result.workspaceId, SETTING_PHASE_STATE_MAP)).toEqual({
                brainstorming: 'New', planned: 'New', in_progress: 'Active', in_review: 'Resolved', done: 'Closed', dropped: 'Removed',
            });
        } finally {
            fs.rmSync(ado, { recursive: true, force: true });
        }
    });

    it('keeps the sprint and user a person set after the first import', () => {
        const workspaceId = ensureWorkspace(ledger.db, repo).id;
        setWorkspaceSetting(ledger.db, workspaceId, SETTING_ACTIVE_SPRINT, 'Sprint 9');
        setWorkspaceSetting(ledger.db, workspaceId, SETTING_CURRENT_USER, 'someone-else');
        seedLegacyRepo(repo);
        importLegacyWorkspace(ledger.db, repo);
        expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_ACTIVE_SPRINT)).toBe('Sprint 9');
        expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_CURRENT_USER)).toBe('someone-else');
    });

    it('stamps linked-only on a legacy workspace with no sync policy, on import and on every later start', () => {
        seedLegacyRepo(repo);
        runLegacyImport(ledger.db, [repo]);
        const workspaceId = ensureWorkspace(ledger.db, repo).id;
        expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY)).toBe(SYNC_POLICY_LINKED_ONLY);

        setWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY, undefined);   // already imported, no policy
        expect(runLegacyImport(ledger.db, [repo])).toEqual([]);
        expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY)).toBe(SYNC_POLICY_LINKED_ONLY);
    });

    it('turns phase comments off on a legacy workspace with no setting for them, on import and on every later start (F8)', () => {
        seedLegacyRepo(repo);
        runLegacyImport(ledger.db, [repo]);
        const workspaceId = ensureWorkspace(ledger.db, repo).id;
        expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_PROGRESS_COMMENTS)).toBe(PROGRESS_COMMENTS_NONE);

        setWorkspaceSetting(ledger.db, workspaceId, SETTING_PROGRESS_COMMENTS, undefined);   // already imported, no setting
        expect(runLegacyImport(ledger.db, [repo])).toEqual([]);
        expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_PROGRESS_COMMENTS)).toBe(PROGRESS_COMMENTS_NONE);
    });

    it('keeps phase comments a person set for the workspace, or globally (F8)', () => {
        const workspaceId = ensureWorkspace(ledger.db, repo).id;
        setWorkspaceSetting(ledger.db, workspaceId, SETTING_PROGRESS_COMMENTS, PROGRESS_COMMENTS_PHASE);
        seedLegacyRepo(repo);
        runLegacyImport(ledger.db, [repo]);
        expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_PROGRESS_COMMENTS)).toBe(PROGRESS_COMMENTS_PHASE);

        const other = createLegacyRepo();
        try {
            setSetting(ledger.db, SETTING_PROGRESS_COMMENTS, PROGRESS_COMMENTS_PHASE);
            const { workspaceId: otherId } = importLegacyWorkspace(ledger.db, other);
            expect(getWorkspaceSetting(ledger.db, otherId, SETTING_PROGRESS_COMMENTS)).toBeUndefined();
            expect(readSetting(ledger.db, otherId, SETTING_PROGRESS_COMMENTS)).toBe(PROGRESS_COMMENTS_PHASE);
        } finally {
            fs.rmSync(other, { recursive: true, force: true });
        }
    });

    it('writes its log lines only once the import has committed (F16)', () => {
        seedLegacyRepo(repo, UNCACHED);
        const inTransaction: boolean[] = [];
        jest.spyOn(log, 'appendLog').mockImplementation(() => { inTransaction.push(ledger.db.inTransaction); });

        importLegacyWorkspace(ledger.db, repo);

        expect(inTransaction).toEqual([false]);
    });

    it.each([[SYNC_POLICY_OFF, 0], [SYNC_POLICY_AUTO, 2]])(
        'keeps the sync policy %s a person set, through the import and the next start (queues %d)',
        (policy, queued) => {
            const workspaceId = ensureWorkspace(ledger.db, repo).id;
            setWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY, policy);
            seedLegacyRepo(repo, UNPUSHED);
            expect(runLegacyImport(ledger.db, [repo]).map(result => result.queued)).toEqual([queued]);
            expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY)).toBe(policy);
            expect(runLegacyImport(ledger.db, [repo])).toEqual([]);
            expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY)).toBe(policy);
        },
    );

    it('leaves a legacy workspace unset when a person set the global sync policy', () => {
        setSetting(ledger.db, SETTING_SYNC_POLICY, SYNC_POLICY_OFF);
        seedLegacyRepo(repo, UNPUSHED);
        expect(runLegacyImport(ledger.db, [repo]).map(result => result.queued)).toEqual([0]);
        expect(runLegacyImport(ledger.db, [repo])).toEqual([]);
        const workspaceId = ensureWorkspace(ledger.db, repo).id;
        expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY)).toBeUndefined();
        expect(readSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY)).toBe(SYNC_POLICY_OFF);
    });

    it.each([['main repo first', false], ['worktree first', true]])(
        'imports a repo and its linked worktree, each once (%s)',
        (_order, worktreeFirst) => {
            seedLegacyRepo(repo);
            const worktree = createLegacyWorktree(repo);
            try {
                const roots = worktreeFirst ? [worktree, repo] : [repo, worktree];
                const first = runLegacyImport(ledger.db, roots);
                expect(first.map(result => normalizePath(result.root))).toEqual(roots.map(normalizePath));
                const workspaceId = ensureWorkspace(ledger.db, repo).id;
                expect(first.every(result => result.workspaceId === workspaceId)).toBe(true);
                expect(titlesIn(workspaceId)).toEqual(['Closed one', 'Login fix', 'Worktree only']);

                expect(runLegacyImport(ledger.db, roots)).toEqual([]);
                expect(importLegacyWorkspace(ledger.db, worktree).queued).toBe(0);
                const fromWorktree = listTasks(ledger.db, { workspaceId }).find(t => t.title === 'Worktree only')!;
                expect(outboxRows(ledger.db, fromWorktree.id).map(row => row.payload))
                    .toEqual([JSON.stringify({ text: 'from the worktree' })]);
            } finally {
                fs.rmSync(worktree, { recursive: true, force: true });
            }
        },
    );

    it("reads a workspace's earlier stamp as covering its own root, and still imports its worktree", () => {
        seedLegacyRepo(repo, UNPUSHED);
        const workspaceId = ensureWorkspace(ledger.db, repo).id;
        setWorkspaceSetting(ledger.db, workspaceId, LEGACY_IMPORT_SETTING, WORKSPACE_STAMP);
        const worktree = createLegacyWorktree(repo);
        try {
            const results = runLegacyImport(ledger.db, [repo, worktree]);
            expect(results.map(result => normalizePath(result.root))).toEqual([normalizePath(worktree)]);
            expect(titlesIn(workspaceId)).toEqual(['Worktree only']);
            expect(runLegacyImport(ledger.db, [repo, worktree])).toEqual([]);
        } finally {
            fs.rmSync(worktree, { recursive: true, force: true });
        }
    });

    it('counts only the rows it queued', () => {
        seedLegacyRepo(repo, [
            { taskId: '42', action: 'updateTask', payload: JSON.stringify({ state: 'in_review' }), status: 'pending' },
            { taskId: '42', action: 'updateTask', payload: JSON.stringify({ state: 'closed' }), status: 'pending' },
        ]);
        const result = importLegacyWorkspace(ledger.db, repo);
        const task = listTasks(ledger.db, { workspaceId: result.workspaceId }).find(t => t.title === 'Login fix')!;
        expect(outboxRows(ledger.db, task.id).map(row => row.op)).toEqual(['sync_state']);
        expect(result.queued).toBe(1);
    });

    it('logs a 1.4.0 change it cannot queue because the issue is not in the cache', () => {
        seedLegacyRepo(repo, UNCACHED);
        const result = importLegacyWorkspace(ledger.db, repo);
        expect(result.queued).toBe(0);
        const lines = fs.readFileSync(path.join(tmpHome, SYNC_LOG_FILE), 'utf8').trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('#99');
        expect(lines[0]).toContain(getWorkspace(ledger.db, result.workspaceId)!.path);
    });

    it('keeps a phase map a person set when the repo is imported again', () => {
        const ado = createLegacyRepo(ADO_CONFIG);
        try {
            const { workspaceId } = importLegacyWorkspace(ledger.db, ado);
            const chosen = { in_progress: 'Doing' };
            setWorkspaceSetting(ledger.db, workspaceId, SETTING_PHASE_STATE_MAP, chosen);
            importLegacyWorkspace(ledger.db, ado);
            expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_PHASE_STATE_MAP)).toEqual(chosen);
        } finally {
            fs.rmSync(ado, { recursive: true, force: true });
        }
    });

    it('stamps and queues a ledger a pre-release build imported, once', () => {
        seedLegacyRepo(repo, UNPUSHED);
        // What a pre-release build left: the global stamp and linked tasks; no workspace stamp, no policy, nothing queued.
        setSetting(ledger.db, LEGACY_IMPORT_SETTING, PRE_RELEASE_STAMP);
        const workspaceId = ensureWorkspace(ledger.db, repo).id;
        setWorkspaceVendor(ledger.db, workspaceId, 'github');
        const task = insertTaskRow(ledger.db, {
            title: 'Login fix', phase: 'in_progress', workspaceId, origin: 'vendor', source: LEGACY_SOURCE,
        }, PRE_RELEASE_STAMP);
        insertVendorLink(ledger.db, { taskId: task.id, vendor: 'github', remoteId: '42', remoteState: 'in_progress' });

        expect(runLegacyImport(ledger.db, [repo])).toMatchObject([{ imported: 1, skipped: 1, queued: 2 }]);
        expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY)).toBe(SYNC_POLICY_LINKED_ONLY);
        expect(outboxRows(ledger.db, task.id).map(row => row.op)).toEqual(['sync_state', 'comment']);

        expect(runLegacyImport(ledger.db, [repo])).toEqual([]);
        expect(importLegacyWorkspace(ledger.db, repo).queued).toBe(0);
        expect(outboxRows(ledger.db, task.id)).toHaveLength(2);
    });
});
