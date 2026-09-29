import { tempLedger, TempLedger, clonedRepo, outboxRows } from '../ledger/helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { getTask, getVendorLink, updateTask } from '../../src/ledger/tasks';
import { startSession } from '../../src/ledger/sessions';
import { trackWork, mergeTask } from '../../src/ledger/work';
import { listEvents } from '../../src/ledger/events';
import {
    getSyncPause, setSetting, setWorkspaceSetting, SETTING_MAX_PUSH_ATTEMPTS, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO,
    SYNC_POLICY_LINKED_ONLY, SYNC_POLICY_OFF,
} from '../../src/ledger/settings';
import { TaskRow, WorkspaceRow } from '../../src/ledger/types';
import { CliArg, Runner } from '../../src/cli';
import { emptyPushSummary, pushDue, PushDeps } from '../../src/sync/push';
import { recordOwnPush } from '../../src/sync/reconcile';
import { rearmFailed, releaseStaleClaims, DEFER_MS, PUSH_BACKOFF_BASE_MS } from '../../src/sync/outbox';
import { acquireLease, releaseLease, LEASE_TTL_MS } from '../../src/sync/lease';
import { GoneError, PermanentError, SyncPausedError } from '../../src/sync/vendor';
import { GitHubAdapter, GH_LOGGED_OUT } from '../../src/sync/github';
import { FakeVendor } from './fake-vendor';

const SESSION_ID = 'push-session';
const SOURCE = 'mcp:test';
const HOLDER = 'pid:push-test';
const OTHER_HOLDER = 'pid:other-runner';
const SLACK_MS = 5000;
const MARKER = /<!-- ghostpm:[0-9a-f]{16} -->$/;
const GITHUB_TOKEN = `ghp_${'a1'.repeat(18)}`;
/** A column any insert into vendor_links trips over: a local write that fails after the vendor call succeeded. */
const FAIL_LINK_INSERTS = "CREATE TRIGGER fail_link BEFORE INSERT ON vendor_links BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END";
const ALLOW_LINK_INSERTS = 'DROP TRIGGER fail_link';

describe('pushing the outbox', () => {
    let ledger: TempLedger;
    let workspace: WorkspaceRow;
    let vendor: FakeVendor;
    let deps: PushDeps;
    let skewMs: number;
    let originalHome: string | undefined;

    const track = (title = 'Login fix', workspaceId = workspace.id): TaskRow =>
        trackWork(ledger.db, { sessionId: SESSION_ID, source: SOURCE, workspaceId, title, intent: 'implement' }).task;
    const change = (taskId: number, update: { title?: string; phase?: TaskRow['phase']; comment?: string }): TaskRow =>
        updateTask(ledger.db, taskId, update, { source: SOURCE, sessionId: SESSION_ID, human: true });
    const statuses = (taskId: number): string[] => outboxRows(ledger.db, taskId).map(row => `${row.op}:${row.status}`);
    const push = () => pushDue(ledger.db, deps);
    /** Another runner, once ours has run out: it takes the lease. */
    const laterRunnerNow = (): number => Date.now() + LEASE_TTL_MS + 1;
    /** Lets the push under test run up to its first real wait (FakeVendor.hold). */
    const settle = () => new Promise(resolve => setImmediate(resolve));

    beforeEach(() => {
        ledger = tempLedger();
        // sync.log (redactions, failures) must land in the temp dir, never the real ~/.ghostpm.
        originalHome = process.env.GHOSTPM_HOME;
        process.env.GHOSTPM_HOME = ledger.dir;
        // Every test tracks tasks and needs their create rows; the global default is off.
        setSetting(ledger.db, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);
        workspace = ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'widgets'));
        startSession(ledger.db, { id: SESSION_ID, client: 'mcp', cwd: workspace.path, workspaceId: workspace.id });
        vendor = new FakeVendor();
        skewMs = 0;
        deps = { holder: HOLDER, now: () => Date.now() + skewMs, adapterFor: () => vendor };
    });

    afterEach(() => {
        if (originalHome !== undefined) process.env.GHOSTPM_HOME = originalHome;
        else delete process.env.GHOSTPM_HOME;
        ledger.cleanup();
    });

    it('creates the vendor item and records the link, baseline and pushed revision', async () => {
        const task = track('Login fix');
        expect((await push()).pushed).toBe(1);
        expect(vendor.calls).toEqual([{ op: 'create', remoteId: '1', title: 'Login fix', phase: 'planned', body: expect.stringMatching(MARKER) }]);
        expect(vendor.calls[0].body!.startsWith(`Tracked by GhostPM as T${task.id}.\n\n`)).toBe(true);
        expect(getVendorLink(ledger.db, task.id)).toMatchObject({
            vendor: 'github', remote_id: '1', remote_title: 'Login fix', remote_state: 'open', labels: '["ghostpm:planned"]',
            last_pushed_rev: 0, remote_updated_at: vendor.items.get('1')!.updatedAt, broken_at: null,
        });
        expect(statuses(task.id)).toEqual(['create:done']);
        expect(listEvents(ledger.db, { taskId: task.id, kinds: ['linked'] }).map(event => event.source)).toEqual(['sync']);
    });

    it('pushes a rename after reading the vendor first, and records what it pushed', async () => {
        const task = track('Login fix');
        await push();
        change(task.id, { title: 'Login token fix' });
        await push();
        expect(vendor.items.get('1')!.title).toBe('Login token fix');
        expect(vendor.calls.map(call => call.op)).toEqual(['create', 'fetch', 'syncState']);
        expect(getVendorLink(ledger.db, task.id)).toMatchObject({ remote_title: 'Login token fix', last_pushed_rev: getTask(ledger.db, task.id)!.rev });
    });

    it('ends with the latest title when a second session renames while the push is in flight', async () => {
        const task = track('Login fix');
        await push();
        change(task.id, { title: 'First rename' });
        let release!: () => void;
        vendor.hold = new Promise<void>(resolve => { release = resolve; });

        const inFlight = push();
        await settle();                                         // the push now waits inside syncState
        expect(ledger.db.inTransaction).toBe(false);            // spec §5: no transaction across a vendor call
        change(task.id, { title: 'Second rename' });            // another session, same task
        vendor.hold = null;
        release();
        await inFlight;

        expect(vendor.items.get('1')!.title).toBe('Second rename');
        expect(getTask(ledger.db, task.id)!.title).toBe('Second rename');
        expect(statuses(task.id)).toEqual(['create:done', 'sync_state:done', 'sync_state:done']);
        // Our own first push was never mistaken for a person's edit.
        expect(listEvents(ledger.db, { taskId: task.id, kinds: ['renamed'] }).map(event => event.source)).toEqual([SOURCE, SOURCE]);
    });

    it('applies an edit a person made on the vendor before pushing over it (human wins)', async () => {
        const task = track('Login fix');
        await push();
        vendor.humanEdit('1', { title: 'Renamed by a person' });
        change(task.id, { phase: 'in_review' });
        await push();
        expect(getTask(ledger.db, task.id)).toMatchObject({ title: 'Renamed by a person', phase: 'in_review' });
        expect(vendor.items.get('1')).toMatchObject({ title: 'Renamed by a person', labels: ['ghostpm:in_review'] });
        expect(listEvents(ledger.db, { taskId: task.id, kinds: ['renamed'] }).map(event => event.source)).toEqual(['vendor']);
    });

    it('pauses only the workspace whose CLI is logged out, keeping its rows and attempts', async () => {
        const other = ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'gadgets', 'https://github.com/acme/gadgets.git'));
        const otherVendor = new FakeVendor();
        deps.adapterFor = ws => (ws.id === workspace.id ? vendor : otherVendor);
        const blocked = track('Blocked');
        const flowing = track('Flows', other.id);
        vendor.failNext = new SyncPausedError(GH_LOGGED_OUT);

        const summary = await push();

        expect(getSyncPause(ledger.db, workspace.id)).toBe(GH_LOGGED_OUT);
        expect(summary.paused).toEqual([`${workspace.path}: ${GH_LOGGED_OUT}`]);
        expect(outboxRows(ledger.db, blocked.id)).toMatchObject([{ op: 'create', status: 'pending', attempts: 0 }]);
        expect(getVendorLink(ledger.db, flowing.id)?.remote_id).toBe('1');
        expect((await push()).pushed).toBe(0);
    });

    it('marks the link broken and keeps the task when the item is gone', async () => {
        const task = track('Login fix');
        await push();
        vendor.items.delete('1');
        change(task.id, { title: 'Renamed' });
        const summary = await push();
        expect(summary.broken).toBe(1);
        expect(getVendorLink(ledger.db, task.id)!.broken_at).not.toBeNull();
        expect(getTask(ledger.db, task.id)!.title).toBe('Renamed');
        const linked = listEvents(ledger.db, { taskId: task.id, kinds: ['linked'] });
        expect(JSON.parse(linked[linked.length - 1].payload!)).toMatchObject({ broken: true, remoteId: '1' });
        expect(statuses(task.id)).toEqual(['create:done', 'sync_state:done']);
    });

    it('retries a transient failure with backoff, then gives up after max_push_attempts', async () => {
        setSetting(ledger.db, SETTING_MAX_PUSH_ATTEMPTS, 2);
        const task = track();
        vendor.failNext = new Error('HTTP 502');
        const before = Date.now();
        expect((await push()).retried).toBe(1);
        const [row] = outboxRows(ledger.db, task.id);
        expect(row).toMatchObject({ status: 'pending', attempts: 1, error: 'HTTP 502' });
        expect(Date.parse(row.next_attempt_at) - before).toBeGreaterThanOrEqual(PUSH_BACKOFF_BASE_MS);
        expect(Date.parse(row.next_attempt_at) - before).toBeLessThan(PUSH_BACKOFF_BASE_MS + SLACK_MS);

        expect((await push()).retried).toBe(0);   // not due yet
        skewMs = PUSH_BACKOFF_BASE_MS + SLACK_MS;
        vendor.failNext = new Error('HTTP 503');
        expect((await push()).failed).toBe(1);
        expect(outboxRows(ledger.db, task.id)).toMatchObject([{ status: 'failed', attempts: 2, error: 'HTTP 503' }]);
    });

    it('fails a row at once when retrying cannot help', async () => {
        const task = track();
        vendor.failNext = new PermanentError('No Azure DevOps state is set for phase planned.');
        expect((await push()).failed).toBe(1);
        expect(outboxRows(ledger.db, task.id)).toMatchObject([{ status: 'failed', attempts: 0 }]);
    });

    it('holds a comment until its task exists on the vendor', async () => {
        const task = track();
        change(task.id, { comment: 'first thoughts' });
        vendor.failNext = new Error('HTTP 502');   // the create fails once and backs off
        const before = Date.now();
        const summary = await push();
        expect(summary).toMatchObject({ retried: 1, deferred: 1 });
        const comment = outboxRows(ledger.db, task.id).find(row => row.op === 'comment')!;
        expect(comment).toMatchObject({ status: 'pending', attempts: 0 });
        expect(Date.parse(comment.next_attempt_at) - before).toBeLessThan(DEFER_MS + SLACK_MS);
        expect(vendor.calls.some(call => call.op === 'comment')).toBe(false);
    });

    it('redacts secrets before anything leaves the machine', async () => {
        const token = `ghp_${'a1'.repeat(18)}`;
        const task = track(`Rotate ${token}`);
        const summary = await push();
        expect(summary.redacted).toBe(1);
        expect(vendor.items.get('1')!.title).toBe('Rotate [redacted]');
        expect(getTask(ledger.db, task.id)!.title).toBe(`Rotate ${token}`);
    });

    it('closes a merged duplicate on the vendor', async () => {
        const duplicate = track('Login bug again');
        const kept = track('Login bug');
        await push();
        mergeTask(ledger.db, { fromRef: `T${duplicate.id}`, intoRef: `T${kept.id}`, workspaceId: workspace.id, source: SOURCE, sessionId: SESSION_ID });
        await push();
        expect(vendor.calls.filter(call => call.op === 'closeDuplicate')).toEqual([{ op: 'closeDuplicate', remoteId: '1', text: '2' }]);
        expect(vendor.items.get('1')!.state).toBe('closed:duplicate');
        expect(getVendorLink(ledger.db, duplicate.id)!.remote_state).toBe('closed:duplicate');
    });

    it('completes, never pushes, rows queued before the workspace was switched off', async () => {
        const task = track();
        setWorkspaceSetting(ledger.db, workspace.id, SETTING_SYNC_POLICY, SYNC_POLICY_OFF);
        expect(await push()).toMatchObject({ pushed: 0, skipped: 1 });
        expect(vendor.calls).toEqual([]);
        expect(statuses(task.id)).toEqual(['create:done']);
    });

    it('never creates a vendor item for a task closed since its create failed', async () => {
        const task = track();
        vendor.failNext = new PermanentError('refused');
        await push();
        change(task.id, { phase: 'done' });
        rearmFailed(ledger.db, Date.now());
        expect((await push()).skipped).toBe(1);
        expect(vendor.calls).toEqual([]);
        expect(getVendorLink(ledger.db, task.id)).toBeUndefined();
        expect(statuses(task.id)).toEqual(['create:done']);
    });

    it('links a created item whose phase did not land, and pushes the phase next', async () => {
        const create = vendor.create.bind(vendor);
        // What an adapter answers when its follow-up state move failed: the item as first created.
        jest.spyOn(vendor, 'create').mockImplementationOnce((desired, body) => create({ ...desired, phase: 'brainstorming' }, body));
        const task = track();
        expect((await push()).pushed).toBe(2);
        expect(vendor.items.get('1')!.labels).toEqual(['ghostpm:planned']);
        expect(getVendorLink(ledger.db, task.id)).toMatchObject({ remote_id: '1', labels: '["ghostpm:planned"]', last_pushed_rev: task.rev });
        expect(statuses(task.id)).toEqual(['create:done', 'sync_state:done']);
    });

    it('completes a comment that was posted but could not be re-read, keeping the baseline', async () => {
        const task = track();
        await push();
        const baseline = getVendorLink(ledger.db, task.id);
        change(task.id, { comment: 'progress' });
        jest.spyOn(vendor, 'comment').mockResolvedValueOnce(null);
        expect((await push()).pushed).toBe(1);
        expect(getVendorLink(ledger.db, task.id)).toEqual(baseline);
        expect(statuses(task.id)).toEqual(['create:done', 'comment:done']);
    });

    it('stops at once, writing nothing, when the lease is gone before a vendor call', async () => {
        const task = track();
        await push();
        vendor.humanEdit('1', { title: 'Renamed by a person' });
        change(task.id, { phase: 'in_review' });
        const fetch = vendor.fetch.bind(vendor);
        jest.spyOn(vendor, 'fetch').mockImplementation(remoteId => {
            acquireLease(ledger.db, OTHER_HOLDER, laterRunnerNow());
            return fetch(remoteId);
        });

        expect(await push()).toEqual(emptyPushSummary());

        expect(vendor.calls.map(call => call.op)).toEqual(['create', 'fetch']);
        expect(getTask(ledger.db, task.id)!.title).toBe('Login fix');   // the person's edit waits for the next runner
        expect(outboxRows(ledger.db, task.id).find(row => row.op === 'sync_state')).toMatchObject({ status: 'claimed', claimed_by: HOLDER });
    });

    it("never reads a push that landed after another runner took its row over as a person's edit", async () => {
        const task = track('Login fix');
        await push();
        change(task.id, { title: 'First rename' });
        let release!: () => void;
        vendor.hold = new Promise<void>(resolve => { release = resolve; });

        const inFlight = push();
        await settle();
        change(task.id, { title: 'Second rename' });               // the user, while our push is out
        const later = laterRunnerNow();
        acquireLease(ledger.db, OTHER_HOLDER, later);              // our lease ran out: another runner takes over
        releaseStaleClaims(ledger.db, later);
        vendor.hold = null;
        release();

        expect((await inFlight).pushed).toBe(0);                   // it landed, but the claim is gone: nothing recorded
        expect(vendor.items.get('1')!.title).toBe('First rename');
        expect(getVendorLink(ledger.db, task.id)).toMatchObject({ remote_title: 'Login fix', last_pushed_rev: 0, intent_title: 'First rename' });

        await pushDue(ledger.db, { holder: OTHER_HOLDER, now: () => later, adapterFor: () => vendor });

        expect(vendor.items.get('1')!.title).toBe('Second rename');
        expect(getTask(ledger.db, task.id)!.title).toBe('Second rename');
        expect(listEvents(ledger.db, { taskId: task.id, kinds: ['renamed'] }).map(event => event.source)).toEqual([SOURCE, SOURCE]);
        expect(getVendorLink(ledger.db, task.id)).toMatchObject({ remote_title: 'Second rename', intent_title: null });
    });

    it("recognises its own push that landed although the call failed, and keeps the user's newer rename", async () => {
        const task = track('A');
        await push();
        change(task.id, { title: 'B' });
        vendor.failAfterApply = new Error('gh timed out after 45000 ms');   // the edit landed; its answer did not
        expect((await push()).retried).toBe(1);
        change(task.id, { title: 'C' });                                    // the user renames again before the retry
        skewMs = PUSH_BACKOFF_BASE_MS + SLACK_MS;

        await push();

        expect(getTask(ledger.db, task.id)!.title).toBe('C');
        expect(vendor.items.get('1')!.title).toBe('C');
        expect(listEvents(ledger.db, { taskId: task.id, kinds: ['renamed'] }).map(event => event.source)).toEqual([SOURCE, SOURCE]);
        expect(getVendorLink(ledger.db, task.id)).toMatchObject({ remote_title: 'C', last_pushed_rev: getTask(ledger.db, task.id)!.rev, intent_title: null });
    });

    it('writes nothing of a fetch whose row another runner finished while it was out', async () => {
        const task = track('Login fix');
        await push();
        vendor.humanEdit('1', { title: 'Person title' });
        change(task.id, { phase: 'in_review' });
        const fetch = vendor.fetch.bind(vendor);
        let first = true;
        jest.spyOn(vendor, 'fetch').mockImplementation(async remoteId => {
            const snapshot = await fetch(remoteId);
            if (first) {
                first = false;
                // Our fetch outlives the lease: another runner pushes the row, exits, and the user renames.
                const later = laterRunnerNow();
                acquireLease(ledger.db, OTHER_HOLDER, later);
                releaseStaleClaims(ledger.db, later);
                await pushDue(ledger.db, { holder: OTHER_HOLDER, now: () => later, adapterFor: () => vendor });
                releaseLease(ledger.db, OTHER_HOLDER);
                change(task.id, { title: 'Local rename' });
            }
            return snapshot;
        });

        await push();

        expect(getTask(ledger.db, task.id)).toMatchObject({ title: 'Local rename', phase: 'in_review' });
        expect(vendor.items.get('1')).toMatchObject({ title: 'Local rename', labels: ['ghostpm:in_review'] });
        expect(listEvents(ledger.db, { taskId: task.id, kinds: ['renamed'] }).map(event => event.source)).toEqual(['vendor', SOURCE]);
        // One push by the other runner, one for the user's rename: none for the row we no longer held.
        expect(vendor.calls.filter(call => call.op === 'syncState')).toHaveLength(2);
    });

    it('never lets an older answer replace a newer baseline', async () => {
        const task = track();
        await push();
        const link = getVendorLink(ledger.db, task.id)!;
        const older = { ...vendor.items.get('1')!, title: 'Stale', updatedAt: new Date(Date.parse(link.remote_updated_at!) - SLACK_MS).toISOString() };
        recordOwnPush(ledger.db, link, older, 'Stale', link.last_pushed_rev);
        expect(getVendorLink(ledger.db, task.id)).toEqual(link);
    });

    it('checks the lease before every CLI call an adapter makes, not once per adapter method', async () => {
        const task = track();
        const next = track('Waits for the next runner');
        const repo = `acme/guarded-${Date.now()}`;
        const spawned: string[] = [];
        const gh: Runner = async (_command: string, args: CliArg[]) => {
            const words = args.slice(0, 2).map(arg => (typeof arg === 'string' ? arg : arg.freeText)).join(' ');
            spawned.push(words);
            if (words !== 'issue create') return '';
            acquireLease(ledger.db, OTHER_HOLDER, laterRunnerNow());   // a slow call outlived the lease
            return `https://github.com/${repo}/issues/12\n`;
        };
        deps.adapterFor = (_workspace, guard) => new GitHubAdapter(repo, guard(gh));

        await push();

        expect(spawned).toEqual(['label create', 'issue create']);    // the follow-up read never started
        expect(getVendorLink(ledger.db, task.id)?.remote_id).toBe('12');   // and the created issue is not lost
        expect(outboxRows(ledger.db, next.id)).toMatchObject([{ op: 'create', status: 'pending' }]);
    });

    it('adopts the item a create made before it failed, instead of making a second one', async () => {
        const task = track('Login fix');
        vendor.failAfterApply = new Error('gh timed out after 45000 ms');
        expect((await push()).retried).toBe(1);
        change(task.id, { title: 'Renamed before the retry' });
        skewMs = PUSH_BACKOFF_BASE_MS + SLACK_MS;

        await push();

        expect(vendor.items.size).toBe(1);
        expect(vendor.calls.map(call => call.op)).toEqual(['create', 'findCreated', 'fetch', 'syncState']);
        expect(vendor.items.get('1')!.title).toBe('Renamed before the retry');
        expect(getVendorLink(ledger.db, task.id)).toMatchObject({ remote_id: '1', remote_title: 'Renamed before the retry' });
        expect(statuses(task.id)).toEqual(['create:done', 'sync_state:done']);
    });

    it('adopts the item on retry when the local write failed after a successful create', async () => {
        const task = track();
        ledger.db.exec(FAIL_LINK_INSERTS);
        expect((await push()).retried).toBe(1);
        ledger.db.exec(ALLOW_LINK_INSERTS);
        skewMs = PUSH_BACKOFF_BASE_MS + SLACK_MS;

        expect((await push()).pushed).toBe(1);

        expect(vendor.items.size).toBe(1);
        expect(vendor.calls.map(call => call.op)).toEqual(['create', 'findCreated']);
        expect(getVendorLink(ledger.db, task.id)).toMatchObject({ remote_id: '1', last_pushed_rev: 0 });
    });

    it('never posts a comment twice when the first attempt landed but failed', async () => {
        const task = track();
        await push();
        change(task.id, { comment: 'progress' });
        vendor.failAfterApply = new Error('HTTP 502');
        expect((await push()).retried).toBe(1);
        skewMs = PUSH_BACKOFF_BASE_MS + SLACK_MS;

        expect((await push()).pushed).toBe(1);

        expect(vendor.comments.get('1')).toHaveLength(1);
        expect(vendor.comments.get('1')![0]).toMatch(/^progress\n\n<!-- ghostpm:[0-9a-f]{16} -->$/);
        expect(statuses(task.id)).toEqual(['create:done', 'comment:done']);
    });

    it('completes, never pushes, a create left from before the workspace went linked-only', async () => {
        const task = track();
        setWorkspaceSetting(ledger.db, workspace.id, SETTING_SYNC_POLICY, SYNC_POLICY_LINKED_ONLY);
        expect(await push()).toMatchObject({ pushed: 0, skipped: 1 });
        expect(vendor.calls).toEqual([]);
        expect(statuses(task.id)).toEqual(['create:done']);
    });

    it('redacts secrets in a comment and in the created body', async () => {
        const task = track();
        ledger.db.prepare('UPDATE tasks SET body = ? WHERE id = ?').run(`Deploy with ${GITHUB_TOKEN}`, task.id);
        await push();
        change(task.id, { comment: `password=${GITHUB_TOKEN}` });
        const summary = await push();

        expect(summary.redacted).toBe(1);
        expect(vendor.items.get('1')!.body).toMatch(/^Deploy with \[redacted\]\n\n<!-- ghostpm:/);
        expect(vendor.comments.get('1')![0]).toMatch(/^password=\[redacted\]\n\n<!-- ghostpm:/);
        expect(JSON.stringify(vendor.calls)).not.toContain(GITHUB_TOKEN);
    });

    it('pushes what the task is when the push goes out, though it changed during the pre-push read', async () => {
        const task = track('Login fix');
        await push();
        change(task.id, { title: 'First' });
        const fetch = vendor.fetch.bind(vendor);
        jest.spyOn(vendor, 'fetch').mockImplementationOnce(async remoteId => {
            const snapshot = await fetch(remoteId);
            change(task.id, { title: 'Changed during the read' });
            return snapshot;
        });

        await push();

        expect(vendor.items.get('1')!.title).toBe('Changed during the read');
        expect(getVendorLink(ledger.db, task.id)).toMatchObject({ remote_title: 'Changed during the read', last_pushed_rev: getTask(ledger.db, task.id)!.rev });
        expect(vendor.calls.filter(call => call.op === 'syncState')).toHaveLength(1);
    });

    it('pauses the workspace when syncState finds the CLI logged out, keeping the row and its attempts', async () => {
        const task = track();
        await push();
        change(task.id, { title: 'Renamed' });
        jest.spyOn(vendor, 'syncState').mockRejectedValueOnce(new SyncPausedError(GH_LOGGED_OUT));
        expect((await push()).paused).toEqual([`${workspace.path}: ${GH_LOGGED_OUT}`]);
        expect(outboxRows(ledger.db, task.id)[1]).toMatchObject({ op: 'sync_state', status: 'pending', attempts: 0 });
    });

    it('marks the link broken when syncState finds the item gone', async () => {
        const task = track();
        await push();
        change(task.id, { title: 'Renamed' });
        jest.spyOn(vendor, 'syncState').mockRejectedValueOnce(new GoneError('Issue #1 is no longer in acme/widgets'));
        expect((await push()).broken).toBe(1);
        expect(getVendorLink(ledger.db, task.id)!.broken_at).not.toBeNull();
        expect(statuses(task.id)).toEqual(['create:done', 'sync_state:done']);
    });

    it('pauses the workspace when a comment finds the CLI logged out, keeping the row and its attempts', async () => {
        const task = track();
        await push();
        change(task.id, { comment: 'progress' });
        vendor.failNext = new SyncPausedError(GH_LOGGED_OUT);
        expect((await push()).paused).toEqual([`${workspace.path}: ${GH_LOGGED_OUT}`]);
        expect(outboxRows(ledger.db, task.id)[1]).toMatchObject({ op: 'comment', status: 'pending', attempts: 0 });
    });

    it('marks the link broken when a comment finds the item gone', async () => {
        const task = track();
        await push();
        change(task.id, { comment: 'progress' });
        vendor.items.delete('1');
        expect((await push()).broken).toBe(1);
        expect(getVendorLink(ledger.db, task.id)!.broken_at).not.toBeNull();
        expect(statuses(task.id)).toEqual(['create:done', 'comment:done']);
    });
});
