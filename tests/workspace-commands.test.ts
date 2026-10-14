import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    tempLedger, TempLedger, clonedRepo, isolateHomes, seedLegacyDb, GITHUB_REMOTE, LEGACY_GITHUB_CONFIG, LegacyOutboxItem, LegacyTask,
} from './ledger/helpers';
import {
    getWorkspaceSetting, setWorkspaceSetting, SETTING_ADO_WORK_ITEM_TYPE, SETTING_PHASE_STATE_MAP, SETTING_PROGRESS_COMMENTS,
    SETTING_SYNC_POLICY, SYNC_POLICY_AUTO, SYNC_POLICY_LINKED_ONLY, SYNC_POLICY_OFF, SYNC_POLICY_PROMOTE, PROGRESS_COMMENTS_NONE,
    PROGRESS_COMMENTS_PHASE,
} from '../src/ledger/settings';
import {
    LEGACY_CONFIG_FILE, claudeConfigPath, discoverLegacyRoots, phaseStateMapFrom, runLegacyImport,
} from '../src/ledger/legacy-import';
import { getGhostpmHome } from '../src/registry';
import { ensureWorkspace } from '../src/ledger/workspaces';
import { listTasks } from '../src/ledger/tasks';
import { FLAG_YES } from '../src/cli-args';
import { AzureProcess } from '../src/sync/azure';
import { AzureIdentity } from '../src/sync/identity';
import { syncOffHint } from '../src/sync/schedule';
import { describeInit, describeUnregister, initWorkspace, unregisterWorkspace } from '../src/workspace-commands';
import { removeTempDir } from './temp-dir';

const AZURE_REMOTE = 'https://dev.azure.com/acme/Portal/_git/portal';
const SAMPLED: AzureProcess = { states: ['New', 'Active', 'Resolved', 'Closed', 'Removed'], workItemTypes: ['Task', 'Bug'] };
const PROJECT_FOLDER = 'project';
const LEGACY_TASK: LegacyTask = { id: '42', title: 'Legacy issue', state: 'open' };
/** A comment 1.4.0 queued and never pushed: imported, it becomes a vendor comment the next sync posts. */
const UNPUSHED: LegacyOutboxItem = { taskId: '42', action: 'updateTask', payload: JSON.stringify({ comment: 'from 1.4.0' }), status: 'pending' };
const SYNC_ON = `Sync:      on (${SETTING_SYNC_POLICY} ${SYNC_POLICY_AUTO})`;
/** What init prints when it switched the workspace to auto. */
const switchedFrom = (before: string): string => `Sync:      on (${SETTING_SYNC_POLICY} was ${before}; now ${SYNC_POLICY_AUTO})`;
const NOT_SET = 'not set';
const NEXT_SYNC = 'Next: `ghostpm sync`';
const CLAUDE_JSON = '.claude.json';

describe('phaseStateMapFrom', () => {
    it('maps each phase to the first sampled state the spec table reads as that phase', () => {
        expect(phaseStateMapFrom(SAMPLED.states)).toEqual({
            brainstorming: 'New', planned: 'New', in_progress: 'Active', in_review: 'Resolved', done: 'Closed', dropped: 'Removed',
        });
    });

    it('ignores states it does not know and keeps the first match', () => {
        expect(phaseStateMapFrom(['Ready', 'To Do', 'New'])).toEqual({ brainstorming: 'To Do', planned: 'To Do' });
    });
});

describe('workspace commands', () => {
    let ledger: TempLedger;
    let parent: string;
    let home: string;
    let restoreHomes: () => void;
    let sniffed: AzureIdentity[];

    const sniff = async (identity: AzureIdentity): Promise<AzureProcess> => { sniffed.push(identity); return SAMPLED; };
    const repo = (remote: string = GITHUB_REMOTE): string => clonedRepo(parent, PROJECT_FOLDER, remote);
    /** A GitHub clone 1.4.0 set up: its config and a cache with one issue and one change it never pushed. */
    const legacyRepo = (): string => {
        const folder = repo();
        fs.writeFileSync(path.join(folder, LEGACY_CONFIG_FILE), LEGACY_GITHUB_CONFIG, 'utf8');
        seedLegacyDb(folder, [LEGACY_TASK], {}, [UNPUSHED]);
        return folder;
    };
    const count = (table: string): number => (ledger.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

    beforeEach(() => {
        ledger = tempLedger();
        parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-init-'));
        home = path.join(parent, 'home');
        // The 1.4.0 import reads its registry from, and logs to, the ghostpm home: never the real one.
        restoreHomes = isolateHomes(home);
        sniffed = [];
    });

    afterEach(() => {
        restoreHomes();
        ledger.cleanup();
        removeTempDir(parent);
    });

    it('keeps every home this code can reach inside the scratch folder', () => {
        // os.homedir() never reads Jest's process.env: isolateHomes must redirect it too.
        expect(claudeConfigPath()).toBe(path.join(home, CLAUDE_JSON));
        expect(getGhostpmHome()).toBe(home);
    });

    describe('initWorkspace', () => {
        it('registers a plain folder with no vendor and calls no vendor CLI', async () => {
            const folder = path.join(parent, PROJECT_FOLDER);
            fs.mkdirSync(folder);
            const result = await initWorkspace(ledger.db, folder, sniff);
            expect(result.workspace.vendor).toBe('none');
            expect(sniffed).toEqual([]);
            expect(fs.existsSync(path.join(folder, LEGACY_CONFIG_FILE))).toBe(false);
            expect(describeInit(result)).toContain('tasks stay local');
        });

        it('detects GitHub without sampling anything', async () => {
            const result = await initWorkspace(ledger.db, repo(), sniff);
            expect(result.workspace.vendor).toBe('github');
            expect(sniffed).toEqual([]);
        });

        it('opts a repo with no sync policy in to sync and says so, once (ruling P41)', async () => {
            const folder = repo();
            const result = await initWorkspace(ledger.db, folder, sniff);
            expect(getWorkspaceSetting(ledger.db, result.workspace.id, SETTING_SYNC_POLICY)).toBe(SYNC_POLICY_AUTO);
            expect(result.syncPolicy).toBe(SYNC_POLICY_AUTO);
            expect(result.optedIn).toEqual({ from: null });
            expect(describeInit(result)).toContain(switchedFrom(NOT_SET));
            expect(describeInit(result)).toContain(NEXT_SYNC);

            const again = await initWorkspace(ledger.db, folder, sniff);
            expect(again.optedIn).toBeNull();
            expect(describeInit(again)).toContain(SYNC_ON);
        });

        it('keeps sync off when a person turned it off, and says how to turn it on', async () => {
            const folder = repo();
            const workspace = ensureWorkspace(ledger.db, folder);
            setWorkspaceSetting(ledger.db, workspace.id, SETTING_SYNC_POLICY, SYNC_POLICY_OFF);

            const result = await initWorkspace(ledger.db, folder, sniff);

            expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_SYNC_POLICY)).toBe(SYNC_POLICY_OFF);
            expect(result.optedIn).toBeNull();
            expect(describeInit(result)).toContain(syncOffHint(workspace.path));
            expect(describeInit(result)).not.toContain(NEXT_SYNC);
        });

        it('keeps promote when a person chose it', async () => {
            const folder = repo();
            const workspace = ensureWorkspace(ledger.db, folder);
            setWorkspaceSetting(ledger.db, workspace.id, SETTING_SYNC_POLICY, SYNC_POLICY_PROMOTE);

            const result = await initWorkspace(ledger.db, folder, sniff);

            expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_SYNC_POLICY)).toBe(SYNC_POLICY_PROMOTE);
            expect(result.optedIn).toBeNull();
            expect(describeInit(result)).toContain(`Sync:      on (${SETTING_SYNC_POLICY} ${SYNC_POLICY_PROMOTE})`);
        });

        it('switches a 1.4.0 repo an earlier start stamped linked-only to auto, and says so', async () => {
            const folder = legacyRepo();
            const [stamped] = runLegacyImport(ledger.db, [folder]);
            expect(getWorkspaceSetting(ledger.db, stamped.workspaceId, SETTING_SYNC_POLICY)).toBe(SYNC_POLICY_LINKED_ONLY);

            const result = await initWorkspace(ledger.db, folder, sniff);

            expect(getWorkspaceSetting(ledger.db, stamped.workspaceId, SETTING_SYNC_POLICY)).toBe(SYNC_POLICY_AUTO);
            expect(result.optedIn).toEqual({ from: SYNC_POLICY_LINKED_ONLY });
            expect(result.imported).toBe(0);
            const text = describeInit(result);
            expect(text).toContain(`${SETTING_SYNC_POLICY} was ${SYNC_POLICY_LINKED_ONLY}; now ${SYNC_POLICY_AUTO}`);
            expect(text).toContain(`Phase comments: off (${SETTING_PROGRESS_COMMENTS} ${PROGRESS_COMMENTS_NONE})`);
        });

        it('opts a 1.4.0 repo in too, before its import can stamp linked-only, and says phase comments stay off', async () => {
            const result = await initWorkspace(ledger.db, legacyRepo(), sniff);

            expect(result.imported).toBe(1);
            expect(getWorkspaceSetting(ledger.db, result.workspace.id, SETTING_SYNC_POLICY)).toBe(SYNC_POLICY_AUTO);
            expect(getWorkspaceSetting(ledger.db, result.workspace.id, SETTING_PROGRESS_COMMENTS)).toBe(PROGRESS_COMMENTS_NONE);
            const text = describeInit(result);
            expect(text).toContain(switchedFrom(NOT_SET));
            expect(text).toContain(`Phase comments: off (${SETTING_PROGRESS_COMMENTS} ${PROGRESS_COMMENTS_NONE})`);
            expect(text).toContain(`ghostpm config set ${SETTING_PROGRESS_COMMENTS} ${PROGRESS_COMMENTS_PHASE} --workspace "${result.workspace.path}"`);
        });

        it('fills the Azure DevOps settings from a sample of this project, then keeps them', async () => {
            const folder = repo(AZURE_REMOTE);
            const first = await initWorkspace(ledger.db, folder, sniff);

            expect(sniffed).toEqual([{ vendor: 'azure_devops', org: 'https://dev.azure.com/acme', project: 'Portal' }]);
            expect(first.applied).toEqual([SETTING_PHASE_STATE_MAP, SETTING_ADO_WORK_ITEM_TYPE]);
            expect(getWorkspaceSetting(ledger.db, first.workspace.id, SETTING_ADO_WORK_ITEM_TYPE)).toBe('Task');
            expect(getWorkspaceSetting<Record<string, string>>(ledger.db, first.workspace.id, SETTING_PHASE_STATE_MAP)!.in_progress).toBe('Active');

            setWorkspaceSetting(ledger.db, first.workspace.id, SETTING_ADO_WORK_ITEM_TYPE, 'User Story');
            const second = await initWorkspace(ledger.db, folder, sniff);
            expect(second.kept).toEqual([SETTING_PHASE_STATE_MAP, SETTING_ADO_WORK_ITEM_TYPE]);
            expect(getWorkspaceSetting(ledger.db, first.workspace.id, SETTING_ADO_WORK_ITEM_TYPE)).toBe('User Story');
        });

        it('warns and sets nothing when az cannot sample', async () => {
            const result = await initWorkspace(ledger.db, repo(AZURE_REMOTE), async () => { throw new Error('Please run az login'); });
            expect(result.applied).toEqual([]);
            expect(result.warnings.join('\n')).toContain('az login');
            expect(describeInit(result)).toContain('Warning: ');
        });

        it('warns without sampling when the Azure DevOps remote names no project', async () => {
            const result = await initWorkspace(ledger.db, repo('https://dev.azure.com/acme'), sniff);
            expect(result.workspace.vendor).toBe('azure_devops');
            expect(sniffed).toEqual([]);
            expect(result.warnings.join('\n')).toContain('https://dev.azure.com/acme');
        });

        it('imports a 1.4.0 database the start-up import never discovered', async () => {
            const folder = legacyRepo();
            // The start-up import ran: this folder is in neither the 1.4.0 registry nor ~/.claude.json.
            // Discovery is handed the scratch ~/.claude.json: Jest's process.env never reaches os.homedir().
            expect(runLegacyImport(ledger.db, discoverLegacyRoots(path.join(home, CLAUDE_JSON)))).toEqual([]);

            const result = await initWorkspace(ledger.db, folder, sniff);

            expect(result.imported).toBe(1);
            expect(listTasks(ledger.db, { workspaceId: result.workspace.id }).map(task => task.title)).toEqual([LEGACY_TASK.title]);
            expect(describeInit(result)).toContain('Imported 1 task(s)');
        });
    });

    describe('unregisterWorkspace', () => {
        it('forgets a 1.4.0 repo for good: later starts import and queue nothing, even once a session registers it again (C38)', async () => {
            const folder = legacyRepo();
            const { workspace } = await initWorkspace(ledger.db, folder, sniff);
            expect(count('outbox')).toBeGreaterThan(0);

            const removed = unregisterWorkspace(ledger.db, workspace);

            expect(removed).toMatchObject({ tasks: 1 });
            ensureWorkspace(ledger.db, folder);   // the next session in the folder
            expect(runLegacyImport(ledger.db, [folder])).toEqual([]);
            expect(count('tasks')).toBe(0);
            expect(count('outbox')).toBe(0);
        });

        it('lets `ghostpm init` bring a forgotten 1.4.0 repo back, so later starts treat it as imported again', async () => {
            const folder = legacyRepo();
            unregisterWorkspace(ledger.db, (await initWorkspace(ledger.db, folder, sniff)).workspace);

            const again = await initWorkspace(ledger.db, folder, sniff);
            expect(again.imported).toBe(1);

            // Every start re-stamps an imported 1.4.0 repo's unset policy: a root still forgotten would be skipped.
            setWorkspaceSetting(ledger.db, again.workspace.id, SETTING_PROGRESS_COMMENTS, undefined);
            expect(runLegacyImport(ledger.db, [folder])).toEqual([]);
            expect(getWorkspaceSetting(ledger.db, again.workspace.id, SETTING_PROGRESS_COMMENTS)).toBe(PROGRESS_COMMENTS_NONE);
            expect(count('tasks')).toBe(1);
        });
    });

    describe('describeUnregister', () => {
        it('asks for --yes before deleting, and says the vendor is left alone', () => {
            const workspace = ensureWorkspace(ledger.db, repo());
            const footprint = { tasks: 2, events: 3, vendorLinks: 1, outbox: 1, sessions: 1 };

            const dryRun = describeUnregister(workspace, footprint, false);
            expect(dryRun).toContain('2 task(s), 3 event(s), 1 vendor link(s), 1 queued vendor change(s) and 1 session(s)');
            expect(dryRun).toContain(`ghostpm unregister "${workspace.path}" ${FLAG_YES}`);
            expect(describeUnregister(workspace, footprint, true)).toContain('Nothing was changed at the vendor.');
        });
    });
});
