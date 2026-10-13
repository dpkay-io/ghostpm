import * as fs from 'fs';
import * as path from 'path';
import { tempLedger, TempLedger, clonedRepo, outboxRows } from '../ledger/helpers';
import { openLedger, LEDGER_FILE } from '../../src/ledger/db';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask, getVendorLink } from '../../src/ledger/tasks';
import { startSession } from '../../src/ledger/sessions';
import { recordEvidence, trackWork } from '../../src/ledger/work';
import {
    deleteSetting, getSyncPause, getWorkspaceSetting, setSetting, setSyncPause, setWorkspaceSetting, DEFAULT_SYNC_PULL_MINUTES,
    SETTING_LAST_SYNC, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO, SYNC_POLICY_OFF,
} from '../../src/ledger/settings';
import { TaskRow, WorkspaceRow } from '../../src/ledger/types';
import { COMMAND_OVERRIDE_ENV, Runner, runCli } from '../../src/cli';
import { SYNC_LOG_FILE } from '../../src/hook/log';
import { acquireLease, leaseHolder, LeaseLostError, LEASE_TTL_MS } from '../../src/sync/lease';
import { PushDeps, RunGuard } from '../../src/sync/push';
import {
    adapterFor, defaultSyncDeps, pullWorkspaces, runSyncCommand, startSyncRunner, syncCommandMain, syncOnce, SyncReport, PUSH_POLL_MS,
} from '../../src/sync/runner';
import { BACKGROUND_FLAG, pullIsDue, syncOffHint } from '../../src/sync/schedule';
import { PULL_PAGE_LIMIT } from '../../src/sync/pull';
import { GitHubAdapter, GH_LOGGED_OUT } from '../../src/sync/github';
import { AzureAdapter } from '../../src/sync/azure';
import { PermanentError, SyncPausedError } from '../../src/sync/vendor';
import { FakeVendor } from './fake-vendor';

const SESSION_ID = 'runner-session';
const SOURCE = 'mcp:test';
const HOLDER = 'pid:runner-test';
const OTHER_HOLDER = 'pid:someone-else';
const PR_URL = 'https://github.com/acme/widgets/pull/9';
const GADGETS_REMOTE = 'https://github.com/acme/gadgets.git';
const OFFLINE = 'error connecting to api.github.com';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/** Long enough that the interval never fires during a test: ticks are driven by hand. */
const IDLE_POLL_MS = 60 * 60 * 1000;
const GH_OVERRIDE_ENV = COMMAND_OVERRIDE_ENV.gh!;

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
    const listCalls = (): number => vendor.calls.filter(call => call.op === 'list').length;
    /** Our lease ran out while a vendor call was out, and another runner took it. */
    const otherRunnerTakesLease = (): boolean => acquireLease(ledger.db, OTHER_HOLDER, Date.now() + LEASE_TTL_MS + 1);
    const offlineList = (): jest.SpyInstance => jest.spyOn(vendor, 'listChangedSince').mockRejectedValue(new Error(OFFLINE));

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
        expect(report.leaseLost).toBe(false);
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
        ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'gadgets', GADGETS_REMOTE));
        const list = vendor.listChangedSince.bind(vendor);
        jest.spyOn(vendor, 'listChangedSince').mockImplementation((since, limit) => {
            otherRunnerTakesLease();
            return list(since, limit);
        });

        const report = await syncOnce(ledger.db, deps, true) as SyncReport;

        expect(report.pulls).toEqual([{ workspace: expect.objectContaining({ id: workspace.id }), error: new LeaseLostError().message }]);
        expect(report.leaseLost).toBe(true);
        expect(vendor.calls.map(call => call.op)).toEqual(['currentUser', 'list']);   // the second workspace is never pulled
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC)).toBeUndefined();
        expect(getSyncPause(ledger.db, workspace.id)).toBeUndefined();
        expect(leaseHolder(ledger.db)?.holder).toBe(OTHER_HOLDER);
    });

    it('pushes nothing more once the lease is lost: what the pull queued stays pending (M2)', async () => {
        let queued: TaskRow | undefined;
        const list = vendor.listChangedSince.bind(vendor);
        jest.spyOn(vendor, 'listChangedSince').mockImplementation((since, limit) => {
            queued = track('Queued while the pull was out');
            otherRunnerTakesLease();
            return list(since, limit);
        });

        await syncOnce(ledger.db, deps, true);

        expect(outboxRows(ledger.db, queued!.id).map(row => `${row.op}:${row.status}`)).toEqual(['create:pending']);
        expect(vendor.calls.filter(call => call.op === 'create')).toEqual([]);
    });

    it('resumes paused workspaces and retries failed pushes when a person runs ghostpm sync', async () => {
        const task = track();
        failRows(task.id);
        setSyncPause(ledger.db, workspace.id, GH_LOGGED_OUT);
        const { output, failed } = await runSyncCommand(ledger.db, [], deps);
        expect(getSyncPause(ledger.db, workspace.id)).toBeUndefined();
        expect(output).toContain('Resumed sync for 1 paused workspace.');
        expect(output).toContain('Retrying 1 failed push.');
        expect(output).toContain('Pushed 1');
        expect(failed).toBe(false);
        expect(getVendorLink(ledger.db, task.id)?.remote_id).toBe('1');
    });

    it('re-arms failed pushes only in workspaces that sync, and counts only those (I1)', async () => {
        failRows(track().id);
        const gadgets = ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'gadgets', GADGETS_REMOTE));
        setWorkspaceSetting(ledger.db, gadgets.id, SETTING_SYNC_POLICY, SYNC_POLICY_OFF);
        const off = createTask(ledger.db, { title: 'Failed before sync was switched off', phase: 'planned', workspaceId: gadgets.id, origin: 'local', source: SOURCE });
        ledger.db.prepare("INSERT INTO outbox (task_id, op, status, attempts, next_attempt_at, error) VALUES (?, 'create', 'failed', 8, ?, 'boom')")
            .run(off.id, new Date(0).toISOString());

        const { output, failed } = await runSyncCommand(ledger.db, [], deps);

        expect(output).toContain('Retrying 1 failed push.');
        expect(outboxRows(ledger.db, off.id).map(row => `${row.op}:${row.status}`)).toEqual(['create:failed']);
        expect(output).not.toContain(gadgets.path);
        expect(failed).toBe(false);
    });

    it('fails, naming the workspace, when a pull fails (I2)', async () => {
        offlineList();
        const { output, failed } = await runSyncCommand(ledger.db, [], deps);
        expect(failed).toBe(true);
        expect(output).toContain(`${workspace.path}: pull failed: ${OFFLINE}`);
    });

    it('fails, naming the workspace, when pushes are left failed (I2)', async () => {
        track();
        vendor.failNext = new PermanentError('HTTP 422: Validation Failed');
        const { output, failed } = await runSyncCommand(ledger.db, [], deps);
        expect(failed).toBe(true);
        expect(output).toContain(`${workspace.path}: 1 push failed`);
    });

    it('fails when another runner takes the lease part way through (I2)', async () => {
        track();
        const create = vendor.create.bind(vendor);
        jest.spyOn(vendor, 'create').mockImplementation(async (desired, body) => {
            const item = await create(desired, body);
            otherRunnerTakesLease();
            return item;
        });
        const { output, failed } = await runSyncCommand(ledger.db, [], deps);
        expect(failed).toBe(true);
        expect(output).toContain('another sync runner took the lease');
    });

    it('fails, with the same line as a push, when a pull finds the workspace must pause (M1)', async () => {
        vendor.failNext = new SyncPausedError(GH_LOGGED_OUT);   // the first pull call: detecting the user
        const { output, failed } = await runSyncCommand(ledger.db, [], deps);
        expect(failed).toBe(true);
        expect(output).toContain(`Paused ${workspace.path}: ${GH_LOGGED_OUT}`);
    });

    it('fails when a push finds the workspace must pause', async () => {
        track();
        vendor.failNext = new SyncPausedError(GH_LOGGED_OUT);
        const { output, failed } = await runSyncCommand(ledger.db, [], deps);
        expect(failed).toBe(true);
        expect(output).toContain(`Paused ${workspace.path}: ${GH_LOGGED_OUT}`);
    });

    it('leaves pauses and failures alone when started in the background', async () => {
        const task = track();
        failRows(task.id);
        setSyncPause(ledger.db, workspace.id, GH_LOGGED_OUT);
        await runSyncCommand(ledger.db, [BACKGROUND_FLAG], deps);
        expect(getSyncPause(ledger.db, workspace.id)).toBe(GH_LOGGED_OUT);
        expect(outboxRows(ledger.db, task.id).map(row => row.status)).toEqual(['failed']);
        expect(vendor.calls).toEqual([]);
    });

    it('pulls in the background only what is due (M3)', async () => {
        setWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC, new Date().toISOString());
        const { output } = await runSyncCommand(ledger.db, [BACKGROUND_FLAG], deps);
        expect(vendor.calls).toEqual([]);
        expect(output).not.toContain(workspace.path);
    });

    it('names the live holder instead of syncing, and that is not a failure', async () => {
        acquireLease(ledger.db, OTHER_HOLDER);
        const { output, failed } = await runSyncCommand(ledger.db, [], deps);
        expect(output).toContain(`Sync is already running in ${OTHER_HOLDER}`);
        expect(failed).toBe(false);
    });

    it('never pulls a workspace whose sync_policy is off, even when a person runs ghostpm sync (ruling 4)', async () => {
        expect(pullIsDue(ledger.db, workspace, Date.now())).toBe(true);
        setWorkspaceSetting(ledger.db, workspace.id, SETTING_SYNC_POLICY, SYNC_POLICY_OFF);

        expect(pullIsDue(ledger.db, workspace, Date.now())).toBe(false);
        expect(await pullWorkspaces(ledger.db, deps, true)).toEqual([]);
        expect((await runSyncCommand(ledger.db, [], deps)).output).not.toContain(workspace.path);

        expect(vendor.calls).toEqual([]);
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC)).toBeUndefined();
    });

    it('says how to turn sync on for the workspace it runs in when that one is off, and exits 0 (F2)', async () => {
        setWorkspaceSetting(ledger.db, workspace.id, SETTING_SYNC_POLICY, SYNC_POLICY_OFF);
        const { output, failed } = await runSyncCommand(ledger.db, [], deps, workspace.path);
        expect(output).toContain(`Sync is off for ${workspace.path} (${syncOffHint(workspace.path)}).`);
        expect(output).toContain(`\`ghostpm config set sync_policy auto --workspace "${workspace.path}"\``);
        expect(failed).toBe(false);
    });

    it('says how to turn sync on when no workspace syncs, wherever it runs (F2)', async () => {
        deleteSetting(ledger.db, SETTING_SYNC_POLICY);   // the shipped default: every workspace off
        const outside = path.join(ledger.dir, 'not-a-repo');
        fs.mkdirSync(outside);
        const { output, failed } = await runSyncCommand(ledger.db, [], deps, outside);
        expect(output).toContain('`ghostpm config set sync_policy auto --workspace "');
        expect(failed).toBe(false);
    });

    it('says nothing about turning sync on where it is on (F2)', async () => {
        const { output } = await runSyncCommand(ledger.db, [], deps, workspace.path);
        expect(output).not.toContain('ghostpm config set sync_policy');
    });

    it('continues a full page on its next tick instead of after sync_pull_minutes (F10)', async () => {
        for (let i = 0; i <= PULL_PAGE_LIMIT; i++) vendor.seed({ title: `Item ${i}` });   // one more than a page
        let clock = Date.now();
        const runner = startSyncRunner(ledger.db, { ...deps, now: () => clock }, IDLE_POLL_MS);
        try {
            await runner.tick();   // a full page: the watermark moves to its newest change
            clock += PUSH_POLL_MS;
            await runner.tick();   // the rest, at once
            expect(listCalls()).toBe(2);
            expect(ledger.db.prepare('SELECT COUNT(*) AS n FROM vendor_links').get()).toEqual({ n: PULL_PAGE_LIMIT + 1 });
            clock += PUSH_POLL_MS;
            await runner.tick();   // caught up: the wait applies again
            expect(listCalls()).toBe(2);
        } finally {
            runner.stop();
        }
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

    it('waits sync_pull_minutes after a pull attempt, failed or not, before pulling that workspace again (I3)', async () => {
        let clock = Date.now();
        const runner = startSyncRunner(ledger.db, { ...deps, now: () => clock }, IDLE_POLL_MS);
        try {
            const failing = offlineList();
            await runner.tick();
            clock += PUSH_POLL_MS;
            await runner.tick();
            expect(failing).toHaveBeenCalledTimes(1);
            expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC)).toBeUndefined();

            failing.mockRestore();
            clock += DEFAULT_SYNC_PULL_MINUTES * MINUTE_MS;
            await runner.tick();
            expect(listCalls()).toBe(1);
            clock += PUSH_POLL_MS;
            await runner.tick();
            expect(listCalls()).toBe(1);
        } finally {
            runner.stop();
        }
    });

    it('skips its tick without writing while nothing syncs and nothing is due (M4)', async () => {
        deleteSetting(ledger.db, SETTING_SYNC_POLICY);   // the shipped default: every workspace off
        const changes = (): number => (ledger.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
        const before = changes();
        const runner = startSyncRunner(ledger.db, deps, IDLE_POLL_MS);
        try {
            await runner.tick();
            await runner.tick();
            expect(changes()).toBe(before);
            expect(ledger.db.prepare('SELECT * FROM leases').all()).toEqual([]);
        } finally {
            runner.stop();
        }
    });

    it('pauses a workspace whose pull finds the CLI logged out, as a push would, and keeps its watermark', async () => {
        vendor.failNext = new SyncPausedError(GH_LOGGED_OUT);   // the first pull call: detecting the user
        acquireLease(ledger.db, HOLDER);
        const reports = await pullWorkspaces(ledger.db, deps, true);
        expect(reports).toEqual([{ workspace: expect.objectContaining({ id: workspace.id }), error: GH_LOGGED_OUT, paused: true }]);
        expect(getSyncPause(ledger.db, workspace.id)).toBe(GH_LOGGED_OUT);
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC)).toBeUndefined();
    });

    it('writes no pause once another runner took the lease during the call that found it (M1)', async () => {
        jest.spyOn(vendor, 'currentUser').mockImplementation(async () => {
            otherRunnerTakesLease();
            throw new SyncPausedError(GH_LOGGED_OUT);
        });
        acquireLease(ledger.db, HOLDER);
        const reports = await pullWorkspaces(ledger.db, deps, true);
        expect(reports).toEqual([{ workspace: expect.objectContaining({ id: workspace.id }), error: GH_LOGGED_OUT, paused: false }]);
        expect(getSyncPause(ledger.db, workspace.id)).toBeUndefined();
    });

    describe('as the command line runs it', () => {
        const openOwn = () => openLedger(path.join(ledger.dir, LEDGER_FILE));
        const syncLog = (): string => fs.readFileSync(path.join(ledger.dir, SYNC_LOG_FILE), 'utf8');

        it('answers the outcome of the run', async () => {
            offlineList();
            const result = await syncCommandMain([], openOwn, () => deps);
            expect(result.failed).toBe(true);
            expect(result.output).toContain(`${workspace.path}: pull failed: ${OFFLINE}`);
        });

        it('in the background, logs what goes wrong to sync.log instead of throwing (M8)', async () => {
            const broken = (): never => { throw new Error('database is locked'); };
            expect(await syncCommandMain([BACKGROUND_FLAG], broken)).toEqual({ output: '', failed: true });
            expect(await syncCommandMain([BACKGROUND_FLAG], openOwn, () => ({ ...deps, now: () => { throw new Error('clock is gone'); } })))
                .toEqual({ output: '', failed: true });
            expect(syncLog()).toContain('database is locked');
            expect(syncLog()).toContain('clock is gone');
            await expect(syncCommandMain([], broken)).rejects.toThrow('database is locked');
        });
    });
});
