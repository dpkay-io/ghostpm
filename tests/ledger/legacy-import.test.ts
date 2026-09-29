import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tempLedger, TempLedger, eventKinds } from './helpers';
import { Db } from '../../src/db';
import { listTasks, getVendorLink } from '../../src/ledger/tasks';
import { getWorkspace, normalizePath } from '../../src/ledger/workspaces';
import { registerWorkspace } from '../../src/registry';
import * as registry from '../../src/registry';
import { getSetting, getWorkspaceSetting, SETTING_ACTIVE_SPRINT, SETTING_CURRENT_USER } from '../../src/ledger/settings';
import { Phase } from '../../src/ledger/types';
import {
    importLegacyWorkspace, discoverLegacyRoots, runLegacyImportOnce, vendorStateToPhase, knownStatePhase,
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
    let originalHome: string | undefined;

    const createLegacyRepo = (): string => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-legacy-'));
        fs.mkdirSync(path.join(root, '.git'));
        fs.writeFileSync(path.join(root, LEGACY_CONFIG_FILE), LEGACY_CONFIG, 'utf8');
        return root;
    };

    const seedLegacyDb = (root: string): void => {
        const legacy = new Db(root);
        legacy.upsertTask({
            id: '42', title: 'Login fix', state: 'in_progress', assignee: 'dpk',
            body: 'details', comments: 'first\n---\nsecond', updatedAt: '2026-09-10T00:00:00.000Z',
            labels: '["bug"]', milestone: 'Sprint 1', url: 'https://github.com/acme/app/issues/42',
        });
        legacy.upsertTask({ id: '43', title: 'Closed one', state: 'closed' });
        legacy.setMetadata('current_user', 'dpk-jha');
        legacy.setMetadata('active_sprint', JSON.stringify({ name: 'Sprint 1' }));
        legacy.close();
    };

    beforeEach(() => {
        ledger = tempLedger();
        repo = createLegacyRepo();
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-home-'));
        originalHome = process.env.GHOSTPM_HOME;
        process.env.GHOSTPM_HOME = tmpHome;
    });

    afterEach(() => {
        if (originalHome !== undefined) process.env.GHOSTPM_HOME = originalHome;
        else delete process.env.GHOSTPM_HOME;
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

    it('runs only once per ledger', () => {
        seedLegacyDb(repo);
        expect(runLegacyImportOnce(ledger.db, [repo])).toHaveLength(1);
        expect(getSetting<string>(ledger.db, LEGACY_IMPORT_SETTING)).toBeDefined();
        expect(runLegacyImportOnce(ledger.db, [repo])).toEqual([]);
    });

    it('does not scan the disk for roots once the import has already run', () => {
        // Discovery reads ~/.claude.json and stats every project path in it. Once the
        // guard is set that work can only ever be thrown away, so it must not happen at all:
        // this runs on every server start, ahead of the session.
        seedLegacyDb(repo);
        runLegacyImportOnce(ledger.db, [repo]);
        // getWorkspaces is discovery's first call, so it stands in for "discovery ran at all".
        const discoverySpy = jest.spyOn(registry, 'getWorkspaces');
        try {
            expect(runLegacyImportOnce(ledger.db)).toEqual([]);
            expect(discoverySpy).not.toHaveBeenCalled();
        } finally {
            discoverySpy.mockRestore();
        }
    });

    it('keeps importing the other repos when one fails', () => {
        const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-broken-'));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation();
        try {
            seedLegacyDb(repo);
            expect(runLegacyImportOnce(ledger.db, [broken, repo])).toHaveLength(1);
            expect(errorSpy).toHaveBeenCalled();
        } finally {
            errorSpy.mockRestore();
            fs.rmSync(broken, { recursive: true, force: true });
        }
    });
});
