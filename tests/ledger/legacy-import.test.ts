import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tempLedger, TempLedger, eventKinds, outboxRows } from './helpers';
import { Db } from '../../src/db';
import { listTasks, getVendorLink } from '../../src/ledger/tasks';
import { ensureWorkspace, getWorkspace, normalizePath } from '../../src/ledger/workspaces';
import { registerWorkspace } from '../../src/registry';
import {
    getWorkspaceSetting, setWorkspaceSetting, SETTING_ACTIVE_SPRINT, SETTING_CURRENT_USER, SETTING_PHASE_STATE_MAP,
    SETTING_SYNC_POLICY, SYNC_POLICY_AUTO, SYNC_POLICY_LINKED_ONLY, SYNC_POLICY_OFF,
} from '../../src/ledger/settings';
import { Phase } from '../../src/ledger/types';
import {
    importLegacyWorkspace, discoverLegacyRoots, runLegacyImport, vendorStateToPhase, knownStatePhase,
    LEGACY_CONFIG_FILE, LEGACY_DB_FILE, LEGACY_IMPORT_SETTING,
} from '../../src/ledger/legacy-import';

const LEGACY_CONFIG = `vendor: "github"
workflow:
  states: ["open", "closed"]
  transitions:
    start_task: "in_progress"
views:
  list_columns: ["id", "state", "title", "assignee"]
  detail_fields: ["id", "title", "body", "comments"]
`;
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
/** Discovery reads ~/.claude.json through os.homedir(): every home variable points at a scratch folder. */
const HOME_VARIABLES = ['GHOSTPM_HOME', 'HOME', 'USERPROFILE'];
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
    let originalHomes: (string | undefined)[];

    const createLegacyRepo = (config: string = LEGACY_CONFIG): string => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-legacy-'));
        fs.mkdirSync(path.join(root, '.git'));
        fs.writeFileSync(path.join(root, LEGACY_CONFIG_FILE), config, 'utf8');
        return root;
    };

    const seedLegacyDb = (root: string, extra: (legacy: Db) => void = () => undefined): void => {
        const legacy = new Db(root);
        legacy.upsertTask({
            id: '42', title: 'Login fix', state: 'in_progress', assignee: 'dpk',
            body: 'details', comments: 'first\n---\nsecond', updatedAt: '2026-09-10T00:00:00.000Z',
            labels: '["bug"]', milestone: 'Sprint 1', url: 'https://github.com/acme/app/issues/42',
        });
        legacy.upsertTask({ id: '43', title: 'Closed one', state: 'closed' });
        legacy.setMetadata('current_user', 'dpk-jha');
        legacy.setMetadata('active_sprint', JSON.stringify({ name: 'Sprint 1' }));
        extra(legacy);
        legacy.close();
    };

    /** 1.4.0's outbox: a state change with a comment it never pushed, and a comment it gave up on. */
    const seedUnpushed = (legacy: Db): void => {
        legacy.addOutboxItem({ taskId: '42', action: 'updateTask', payload: JSON.stringify({ state: 'in_review', comment: 'from 1.4.0' }), status: 'pending' });
        legacy.addOutboxItem({ taskId: '42', action: 'updateTask', payload: JSON.stringify({ comment: 'gave up' }), status: 'failed' });
    };

    beforeEach(() => {
        ledger = tempLedger();
        repo = createLegacyRepo();
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-home-'));
        originalHomes = HOME_VARIABLES.map(name => process.env[name]);
        HOME_VARIABLES.forEach(name => { process.env[name] = tmpHome; });
    });

    afterEach(() => {
        HOME_VARIABLES.forEach((name, index) => {
            const original = originalHomes[index];
            if (original !== undefined) process.env[name] = original;
            else delete process.env[name];
        });
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
        seedLegacyDb(repo);
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

    it('skips tasks that are already imported when run again', () => {
        seedLegacyDb(repo);
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
        seedLegacyDb(repo);
        importLegacyWorkspace(ledger.db, repo);
        expect(fs.existsSync(path.join(repo, LEGACY_DB_FILE))).toBe(true);
        const legacy = new Db(repo);
        expect(legacy.getTasks()).toHaveLength(2);
        legacy.close();
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
        registerWorkspace(repo, 'github');
        const missing = path.join(tmpHome, 'does-not-exist.json');
        const roots = discoverLegacyRoots(missing).map(normalizePath);
        expect(roots).toEqual([normalizePath(repo)]);
    });

    it('falls back to registry-only roots when ~/.claude.json is malformed', () => {
        registerWorkspace(repo, 'github');
        const malformed = path.join(tmpHome, 'malformed.json');
        fs.writeFileSync(malformed, '{ not valid json', 'utf8');
        const roots = discoverLegacyRoots(malformed).map(normalizePath);
        expect(roots).toEqual([normalizePath(repo)]);
    });

    it('imports each repo once, and a repo set up later on the next start', () => {
        seedLegacyDb(repo);
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
        seedLegacyDb(repo);
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
            seedLegacyDb(repo);
            expect(runLegacyImport(ledger.db, [broken, repo])).toHaveLength(1);
            expect(errorSpy).toHaveBeenCalled();
        } finally {
            errorSpy.mockRestore();
            fs.rmSync(broken, { recursive: true, force: true });
        }
    });

    it('queues the changes 1.4.0 left unpushed, once', () => {
        // No sync_policy is set anywhere: the queue projects only because the import stamps linked-only first.
        seedLegacyDb(repo, seedUnpushed);
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
        seedLegacyDb(repo);
        importLegacyWorkspace(ledger.db, repo);
        expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_ACTIVE_SPRINT)).toBe('Sprint 9');
        expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_CURRENT_USER)).toBe('someone-else');
    });

    it('stamps linked-only on a legacy workspace with no sync policy, on import and on every later start', () => {
        seedLegacyDb(repo);
        runLegacyImport(ledger.db, [repo]);
        const workspaceId = ensureWorkspace(ledger.db, repo).id;
        expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY)).toBe(SYNC_POLICY_LINKED_ONLY);

        setWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY, undefined);   // already imported, no policy
        expect(runLegacyImport(ledger.db, [repo])).toEqual([]);
        expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY)).toBe(SYNC_POLICY_LINKED_ONLY);
    });

    it.each([[SYNC_POLICY_OFF, 0], [SYNC_POLICY_AUTO, 2]])(
        'keeps the sync policy %s a person set, through the import and the next start (queues %d)',
        (policy, queued) => {
            const workspaceId = ensureWorkspace(ledger.db, repo).id;
            setWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY, policy);
            seedLegacyDb(repo, seedUnpushed);
            expect(runLegacyImport(ledger.db, [repo]).map(result => result.queued)).toEqual([queued]);
            expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY)).toBe(policy);
            expect(runLegacyImport(ledger.db, [repo])).toEqual([]);
            expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY)).toBe(policy);
        },
    );
});
