import * as path from 'path';
import { tempLedger, TempLedger, clonedRepo, outboxRows } from '../ledger/helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { getVendorLink } from '../../src/ledger/tasks';
import { startSession } from '../../src/ledger/sessions';
import { recordEvidence, trackWork } from '../../src/ledger/work';
import {
    getSyncPause, getWorkspaceSetting, setSetting, setSyncPause, setWorkspaceSetting, SETTING_LAST_SYNC, SETTING_SYNC_POLICY,
    SYNC_POLICY_AUTO, SYNC_POLICY_OFF,
} from '../../src/ledger/settings';
import { TaskRow, WorkspaceRow } from '../../src/ledger/types';
import { Runner, runCli } from '../../src/cli';
import { acquireLease, leaseHolder, LeaseLostError, LEASE_TTL_MS } from '../../src/sync/lease';
import { PushDeps, RunGuard } from '../../src/sync/push';
import { adapterFor, defaultSyncDeps, pullWorkspaces, runSyncCommand, startSyncRunner, syncOnce, SyncReport } from '../../src/sync/runner';
import { pullIsDue } from '../../src/sync/schedule';
import { GitHubAdapter, GH_LOGGED_OUT } from '../../src/sync/github';
import { AzureAdapter } from '../../src/sync/azure';
import { SyncPausedError } from '../../src/sync/vendor';
import { FakeVendor } from './fake-vendor';

const SESSION_ID = 'runner-session';
const SOURCE = 'mcp:test';
const HOLDER = 'pid:runner-test';
const OTHER_HOLDER = 'pid:someone-else';
const PR_URL = 'https://github.com/acme/widgets/pull/9';
const HOUR_MS = 60 * 60 * 1000;
/** Long enough that the interval never fires during a test: ticks are driven by hand. */
const IDLE_POLL_MS = 60 * 60 * 1000;
const GH_OVERRIDE_ENV = 'GHOSTPM_GH';

describe('the sync runner', () => {
    let ledger: TempLedger;
    let workspace: WorkspaceRow;
    let vendor: FakeVendor;
    let deps: PushDeps;
    let originalHome: string | undefined;
    let originalGh: string | undefined;

    const track = (title = 'Login fix'): TaskRow =>
        trackWork(ledger.db, { sessionId: SESSION_ID, source: SOURCE, workspaceId: workspace.id, title, intent: 'implement' }).task;
    const failRows = (taskId: number): void => {
        ledger.db.prepare("UPDATE outbox SET status = 'failed', attempts = 8 WHERE task_id = ?").run(taskId);
    };

    beforeEach(() => {
        ledger = tempLedger();
        originalHome = process.env.GHOSTPM_HOME;
        originalGh = process.env[GH_OVERRIDE_ENV];
        process.env.GHOSTPM_HOME = ledger.dir;
        // The global default is off; these tests are about workspaces that opted in.
        setSetting(ledger.db, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);
        workspace = ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'widgets'));
        startSession(ledger.db, { id: SESSION_ID, client: 'mcp', cwd: workspace.path, workspaceId: workspace.id });
        vendor = new FakeVendor();
        deps = { holder: HOLDER, now: () => Date.now(), adapterFor: () => vendor };
    });

    afterEach(() => {
        if (originalHome !== undefined) process.env.GHOSTPM_HOME = originalHome;
        else delete process.env.GHOSTPM_HOME;
        if (originalGh !== undefined) process.env[GH_OVERRIDE_ENV] = originalGh;
        else delete process.env[GH_OVERRIDE_ENV];
        ledger.cleanup();
    });

    it('builds a GitHub adapter from the remote, and pauses a workspace whose remote it cannot read', () => {
        expect(adapterFor(ledger.db, workspace)).toBeInstanceOf(GitHubAdapter);
        const boards = ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'boards', 'https://dev.azure.com/acme/Widgets/_git/boards'));
        expect(adapterFor(ledger.db, boards)).toBeInstanceOf(AzureAdapter);
        const odd = ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'odd', 'https://github.com/just-an-owner'));
        const thrown = (() => { try { adapterFor(ledger.db, odd); return null; } catch (error) { return error; } })() as SyncPausedError;
        expect(thrown).toBeInstanceOf(SyncPausedError);
        expect(thrown.reason).toContain('https://github.com/just-an-owner');
    });

    it('builds its default adapters on the guarded runner, so every CLI call is checked first', async () => {
        // An adapter built without the guard would run gh itself: point that at nothing, never at a real gh.
        process.env[GH_OVERRIDE_ENV] = path.join(ledger.dir, 'no-such-gh.exe');
        const wrapped: Runner[] = [];
        const commands: string[] = [];
        const guard: RunGuard = run => {
            wrapped.push(run);
            return async command => {
                commands.push(command);
                return 'octocat';
            };
        };

        const adapter = defaultSyncDeps(ledger.db).adapterFor(workspace, guard);

        expect(await adapter.currentUser()).toBe('octocat');
        expect(wrapped).toEqual([runCli]);
        expect(commands).toEqual(['gh']);
    });

    it('pushes, pulls and lets go of the lease in one pass', async () => {
        const task = track();
        const report = await syncOnce(ledger.db, deps, true) as SyncReport;
        expect(report.push.pushed).toBe(1);
        expect(report.pulls.map(pull => pull.workspace.id)).toEqual([workspace.id]);
        expect(getVendorLink(ledger.db, task.id)?.remote_id).toBe('1');
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC)).toBeDefined();
        expect(leaseHolder(ledger.db)).toBeUndefined();
    });

    it("closes a pushed task's vendor item once its PR merged (ruling D2)", async () => {
        const task = track('Ship it');
        recordEvidence(ledger.db, {
            taskId: task.id, sessionId: SESSION_ID, source: SOURCE, workspaceId: workspace.id, cwd: workspace.path,
            files: [], committed: false, prUrls: [PR_URL],
        });
        await syncOnce(ledger.db, deps, true);
        expect(vendor.items.get('1')!.state).toBe('open');
        vendor.prs.set(PR_URL, new Date(Date.now() - HOUR_MS).toISOString());

        await syncOnce(ledger.db, deps, true);

        expect(vendor.items.get('1')!.state).toBe('closed:completed');
    });

    it('does nothing while another live process holds the lease', async () => {
        acquireLease(ledger.db, OTHER_HOLDER);
        track();
        expect(await syncOnce(ledger.db, deps, true)).toEqual({ heldBy: OTHER_HOLDER });
        expect(vendor.calls).toEqual([]);
    });

    it('stops at once when another process takes the lease during a pull', async () => {
        ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'gadgets', 'https://github.com/acme/gadgets.git'));
        const list = vendor.listChangedSince.bind(vendor);
        jest.spyOn(vendor, 'listChangedSince').mockImplementation((since, limit) => {
            // Our lease ran out while the call was out, and another runner took it.
            acquireLease(ledger.db, OTHER_HOLDER, Date.now() + LEASE_TTL_MS + 1);
            return list(since, limit);
        });

        const report = await syncOnce(ledger.db, deps, true) as SyncReport;

        expect(report.pulls).toEqual([{ workspace: expect.objectContaining({ id: workspace.id }), error: new LeaseLostError().message }]);
        expect(vendor.calls.map(call => call.op)).toEqual(['currentUser', 'list']);   // the second workspace is never pulled
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC)).toBeUndefined();
        expect(getSyncPause(ledger.db, workspace.id)).toBeUndefined();
        expect(leaseHolder(ledger.db)?.holder).toBe(OTHER_HOLDER);
    });

    it('resumes paused workspaces and retries failed pushes when a person runs ghostpm sync', async () => {
        const task = track();
        failRows(task.id);
        setSyncPause(ledger.db, workspace.id, GH_LOGGED_OUT);
        const output = await runSyncCommand(ledger.db, [], deps);
        expect(getSyncPause(ledger.db, workspace.id)).toBeUndefined();
        expect(output).toContain('Resumed sync for 1 paused workspace.');
        expect(output).toContain('Retrying 1 failed push.');
        expect(output).toContain('Pushed 1');
        expect(getVendorLink(ledger.db, task.id)?.remote_id).toBe('1');
    });

    it('leaves pauses and failures alone when started in the background', async () => {
        const task = track();
        failRows(task.id);
        setSyncPause(ledger.db, workspace.id, GH_LOGGED_OUT);
        await runSyncCommand(ledger.db, ['--background'], deps);
        expect(getSyncPause(ledger.db, workspace.id)).toBe(GH_LOGGED_OUT);
        expect(outboxRows(ledger.db, task.id).map(row => row.status)).toEqual(['failed']);
        expect(vendor.calls).toEqual([]);
    });

    it('names the live holder instead of syncing', async () => {
        acquireLease(ledger.db, OTHER_HOLDER);
        expect(await runSyncCommand(ledger.db, [], deps)).toContain(`Sync is already running in ${OTHER_HOLDER}`);
    });

    it('never pulls a workspace whose sync_policy is off, even when a person runs ghostpm sync (ruling 4)', async () => {
        expect(pullIsDue(ledger.db, workspace, Date.now())).toBe(true);
        setWorkspaceSetting(ledger.db, workspace.id, SETTING_SYNC_POLICY, SYNC_POLICY_OFF);

        expect(pullIsDue(ledger.db, workspace, Date.now())).toBe(false);
        expect(await pullWorkspaces(ledger.db, deps, true)).toEqual([]);
        expect(await runSyncCommand(ledger.db, [], deps)).not.toContain(workspace.path);

        expect(vendor.calls).toEqual([]);
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC)).toBeUndefined();
    });

    it('works only while it holds the lease, and gives it back when stopped', async () => {
        const first = startSyncRunner(ledger.db, deps, IDLE_POLL_MS);
        const second = startSyncRunner(ledger.db, { ...deps, holder: OTHER_HOLDER }, IDLE_POLL_MS);
        try {
            track();
            await first.tick();
            await second.tick();
            expect(vendor.calls.filter(call => call.op === 'create')).toHaveLength(1);
            expect(leaseHolder(ledger.db)?.holder).toBe(HOLDER);
            first.stop();
            expect(leaseHolder(ledger.db)).toBeUndefined();
            await second.tick();
            expect(leaseHolder(ledger.db)?.holder).toBe(OTHER_HOLDER);
        } finally {
            first.stop();
            second.stop();
        }
    });

    it('pauses a workspace whose pull finds the CLI logged out, as a push would, and keeps its watermark', async () => {
        vendor.failNext = new SyncPausedError(GH_LOGGED_OUT);   // the first pull call: detecting the user
        acquireLease(ledger.db, HOLDER);
        const reports = await pullWorkspaces(ledger.db, deps, true);
        expect(reports).toEqual([{ workspace: expect.objectContaining({ id: workspace.id }), error: GH_LOGGED_OUT }]);
        expect(getSyncPause(ledger.db, workspace.id)).toBe(GH_LOGGED_OUT);
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC)).toBeUndefined();
    });
});
