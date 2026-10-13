import { tempLedger, TempLedger, clonedRepo, outboxRows } from '../ledger/helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { getTask, getVendorLink, updateTask, TaskUpdate } from '../../src/ledger/tasks';
import { listEvents, recordEvent } from '../../src/ledger/events';
import { startSession } from '../../src/ledger/sessions';
import { recordEvidence, trackWork } from '../../src/ledger/work';
import {
    getWorkspaceSetting, setSetting, setWorkspaceSetting, SETTING_CURRENT_USER, SETTING_LAST_SYNC, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO,
} from '../../src/ledger/settings';
import { TaskRow, WorkspaceRow } from '../../src/ledger/types';
import { acquireLease, LeaseLostError, LEASE_TTL_MS } from '../../src/sync/lease';
import { pullWorkspace, PULL_WINDOW_DAYS, LINK_CHECK_LIMIT } from '../../src/sync/pull';
import { pushDue, PushDeps } from '../../src/sync/push';
import { VENDOR_CALL_TIMEOUT_MS } from '../../src/sync/vendor';
import { FakeVendor } from './fake-vendor';

const SOURCE = 'mcp:test';
const SESSION_ID = 'pull-session';
const HOLDER = 'pid:pull-test';
const OTHER_HOLDER = 'pid:other-runner';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PR_URL = 'https://github.com/acme/widgets/pull/9';
const RETRY_MARKER = '<!-- ghostpm:0123456789abcdef -->';

describe('pulling a vendor workspace', () => {
    let ledger: TempLedger;
    let workspace: WorkspaceRow;
    let vendor: FakeVendor;
    let deps: PushDeps;
    let originalHome: string | undefined;

    /** One pull that begins at `now`. */
    const pull = (now: number = Date.now(), pageLimit?: number) => pullWorkspace(ledger.db, workspace, { ...deps, now: () => now }, pageLimit);
    const push = () => pushDue(ledger.db, deps);
    const track = (title: string): TaskRow =>
        trackWork(ledger.db, { sessionId: SESSION_ID, source: SOURCE, workspaceId: workspace.id, title, intent: 'implement' }).task;
    const taskFor = (remoteId: string): TaskRow => ledger.db.prepare(
        'SELECT t.* FROM tasks t JOIN vendor_links l ON l.task_id = t.id WHERE l.remote_id = ?',
    ).get(remoteId) as TaskRow;
    const change = (taskId: number, update: TaskUpdate): TaskRow => updateTask(ledger.db, taskId, update, { source: SOURCE, human: true });
    const pendingOps = (taskId: number): string[] => outboxRows(ledger.db, taskId).filter(row => row.status === 'pending').map(row => row.op);
    const vendorOps = (from: number): string[] => vendor.calls.slice(from).map(call => call.op);
    const fetchedDuring = async (now: number): Promise<string[]> => {
        const before = vendor.calls.length;
        await pull(now);
        return vendor.calls.slice(before).filter(call => call.op === 'fetch').map(call => call.remoteId!);
    };

    beforeEach(() => {
        ledger = tempLedger();
        originalHome = process.env.GHOSTPM_HOME;
        process.env.GHOSTPM_HOME = ledger.dir;
        // Linked tasks only queue their state while sync is on; the global default is off.
        setSetting(ledger.db, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);
        workspace = ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'widgets'));
        startSession(ledger.db, { id: SESSION_ID, client: 'mcp', cwd: workspace.path, workspaceId: workspace.id });
        vendor = new FakeVendor();
        deps = { holder: HOLDER, now: () => Date.now(), adapterFor: () => vendor };
    });

    afterEach(() => {
        if (originalHome !== undefined) process.env.GHOSTPM_HOME = originalHome;
        else delete process.env.GHOSTPM_HOME;
        ledger.cleanup();
    });

    it('starts 90 days back, and moves the watermark to when the pull began', async () => {
        const now = Date.now();
        await pull(now);
        expect(vendor.calls.find(call => call.op === 'list')!.text).toBe(new Date(now - PULL_WINDOW_DAYS * DAY_MS).toISOString());
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC)).toBe(new Date(now).toISOString());
        await pull(now + HOUR_MS);
        expect(vendor.calls.filter(call => call.op === 'list')[1].text).toBe(new Date(now).toISOString());
    });

    it('leaves the watermark where it was when the vendor call fails', async () => {
        setWorkspaceSetting(ledger.db, workspace.id, SETTING_CURRENT_USER, 'octocat');
        setWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC, '2026-09-01T00:00:00.000Z');
        vendor.failNext = new Error('HTTP 502');
        await expect(pull()).rejects.toThrow('HTTP 502');
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC)).toBe('2026-09-01T00:00:00.000Z');
    });

    it('brings vendor items in as vendor-origin tasks, in the phase they show, and pushes nothing back', async () => {
        vendor.seed({ title: 'Open one' });
        vendor.seed({ title: 'Shipped', state: 'closed:completed' });
        vendor.seed({ title: 'Will not do', state: 'closed:not_planned' });
        vendor.seed({ title: 'Reviewing', labels: ['ghostpm:in_review'], assignee: 'octocat' });
        expect(await pull()).toMatchObject({ fetched: 4, created: 4 });
        expect(['1', '2', '3', '4'].map(id => taskFor(id).phase)).toEqual(['planned', 'done', 'dropped', 'in_review']);
        expect(taskFor('4')).toMatchObject({ origin: 'vendor', title: 'Reviewing', assignee: 'octocat' });
        expect(getVendorLink(ledger.db, taskFor('4').id)).toMatchObject({ remote_title: 'Reviewing', labels: '["ghostpm:in_review"]' });
        expect(ledger.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 0 });
    });

    it('keeps retry markers out of the body of a task it brings in', async () => {
        vendor.seed({ title: 'Made by an earlier attempt', body: `Details\n\n${RETRY_MARKER}` });
        await pull();
        expect(taskFor('1').body).toBe('Details');
    });

    it('detects the current user once', async () => {
        await pull();
        await pull();
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_CURRENT_USER)).toBe('octocat');
        expect(vendor.calls.filter(call => call.op === 'currentUser')).toHaveLength(1);
    });

    it("applies a person's rename and close, and drops the push they make moot", async () => {
        vendor.seed({ title: 'Login fix' });
        await pull();
        const task = taskFor('1');
        change(task.id, { title: 'Local rename' });
        expect(pendingOps(task.id)).toEqual(['sync_state']);
        vendor.humanEdit('1', { title: 'Renamed on GitHub', state: 'closed:not_planned' });

        expect((await pull()).humanEdits).toBe(1);

        const after = getTask(ledger.db, task.id)!;
        expect(after).toMatchObject({ title: 'Renamed on GitHub', phase: 'dropped' });
        expect(after.human_phase_at).not.toBeNull();
        expect(pendingOps(task.id)).toEqual([]);
        expect(listEvents(ledger.db, { taskId: task.id, kinds: ['renamed', 'phase'] }).map(event => event.source))
            .toEqual([SOURCE, 'vendor', 'vendor']);
    });

    it('keeps a pending local change the vendor edit does not cover', async () => {
        vendor.seed({ title: 'Login fix' });
        await pull();
        const task = taskFor('1');
        change(task.id, { phase: 'in_review' });
        vendor.humanEdit('1', { title: 'Renamed on GitHub' });
        await pull();
        expect(getTask(ledger.db, task.id)).toMatchObject({ title: 'Renamed on GitHub', phase: 'in_review' });
        expect(pendingOps(task.id)).toContain('sync_state');
    });

    it('ignores an unrelated vendor update while a local rename is pending', async () => {
        vendor.seed({ title: 'Login fix' });
        await pull();
        const task = taskFor('1');
        change(task.id, { title: 'Local rename' });
        vendor.humanEdit('1', { assignee: 'someone' });
        expect((await pull()).humanEdits).toBe(0);
        expect(getTask(ledger.db, task.id)).toMatchObject({ title: 'Local rename', assignee: 'someone' });
        expect(pendingOps(task.id)).toEqual(['sync_state']);
    });

    it('does not treat a title az dropped characters from as a rename', async () => {
        vendor.lossyTitles = true;
        vendor.seed({ title: 'Déjà vu — ✓' });
        await pull();
        const task = taskFor('1');
        vendor.humanEdit('1', { title: 'Déjà vu  ' });   // what az prints on a cp1252 console
        expect((await pull()).humanEdits).toBe(0);
        expect(getTask(ledger.db, task.id)!.title).toBe('Déjà vu — ✓');
    });

    it("takes a vendor edit that differs from the push in flight as a person's", async () => {
        const task = track('A');
        await push();
        change(task.id, { title: 'B' });
        vendor.failAfterApply = new Error('gh timed out after 45000 ms');   // B landed; its answer did not
        expect((await push()).retried).toBe(1);
        vendor.humanEdit('1', { title: 'C' });

        expect((await pull()).humanEdits).toBe(1);

        expect(getTask(ledger.db, task.id)!.title).toBe('C');
        expect(listEvents(ledger.db, { taskId: task.id, kinds: ['renamed'] }).map(event => event.source)).toEqual([SOURCE, 'vendor']);
        expect(getVendorLink(ledger.db, task.id)).toMatchObject({ remote_title: 'C', intent_title: null });
    });

    it('takes a vendor item that matches the push in flight as ours, not as an edit', async () => {
        const task = track('A');
        await push();
        const renamed = change(task.id, { title: 'B' });
        vendor.failAfterApply = new Error('gh timed out after 45000 ms');
        expect((await push()).retried).toBe(1);

        expect((await pull()).humanEdits).toBe(0);

        expect(getTask(ledger.db, task.id)!.title).toBe('B');
        expect(getVendorLink(ledger.db, task.id)).toMatchObject({ remote_title: 'B', last_pushed_rev: renamed.rev, intent_title: null });
    });

    it("ends a push's intent when a pull stored a newer baseline before the push's answer came back", async () => {
        const task = track('A');
        await push();
        change(task.id, { title: 'B' });
        const syncState = vendor.syncState.bind(vendor);
        jest.spyOn(vendor, 'syncState').mockImplementation(async (link, desired) => {
            const answer = await syncState(link, desired);   // our rename lands,
            vendor.humanEdit('1', { title: 'A' });            // a person puts the old title back,
            await pull();                                     // and a pull reads that before our answer is recorded
            return answer;
        });

        expect((await push()).pushed).toBe(1);

        expect(getVendorLink(ledger.db, task.id)).toMatchObject({ intent_title: null, intent_phase: null, intent_rev: null });
    });

    it('moves a task to done when its PR merged, unless a person changed the phase after the merge', async () => {
        vendor.seed({ title: 'Merged work', labels: ['ghostpm:in_review'] });
        vendor.seed({ title: 'Moved by hand', labels: ['ghostpm:in_review'] });
        await pull();
        const merged = taskFor('1');
        const guarded = taskFor('2');
        const mergedAt = new Date(Date.now() - HOUR_MS).toISOString();
        const prs: [TaskRow, string][] = [
            [merged, 'https://github.com/acme/widgets/pull/7'],
            [guarded, 'https://github.com/acme/widgets/pull/8'],
        ];
        for (const [task, url] of prs) {
            recordEvent(ledger.db, { taskId: task.id, kind: 'pr', source: 'hook:claude-code', sessionId: 'earlier', payload: { url } });
            vendor.prs.set(url, mergedAt);
        }
        change(guarded.id, { phase: 'in_progress' });   // a person, after the merge

        expect((await pull()).merged).toBe(1);

        expect(getTask(ledger.db, merged.id)!.phase).toBe('done');
        expect(listEvents(ledger.db, { taskId: merged.id, kinds: ['phase'] }).map(event => event.source)).toEqual(['sync']);
        expect(pendingOps(merged.id)).toContain('sync_state');
        expect(getTask(ledger.db, guarded.id)!.phase).toBe('in_progress');
    });

    // Ruling D2. syncOnce arrives with Task 12; until then the sync path is a pull, then a push.
    it('closes the vendor item of a pushed task once its PR merged', async () => {
        const task = track('Ship it');
        recordEvidence(ledger.db, {
            taskId: task.id, sessionId: SESSION_ID, source: SOURCE, workspaceId: workspace.id, cwd: workspace.path,
            files: [], committed: false, prUrls: [PR_URL],
        });
        await push();
        expect(vendor.items.get('1')).toMatchObject({ state: 'open', labels: ['ghostpm:in_review'] });
        vendor.prs.set(PR_URL, new Date(Date.now() - HOUR_MS).toISOString());

        expect((await pull()).merged).toBe(1);
        await push();

        expect(vendor.items.get('1')!.state).toBe('closed:completed');
    });

    it('marks the link of a deleted item broken and keeps the task', async () => {
        vendor.seed({ title: 'Soon gone' });
        await pull();
        const task = taskFor('1');
        vendor.items.delete('1');
        expect((await pull()).broken).toBe(1);
        expect(getTask(ledger.db, task.id)).toBeDefined();
        expect(getVendorLink(ledger.db, task.id)!.broken_at).not.toBeNull();
    });

    it('repairs a broken link when its item is seen again, even unchanged', async () => {
        vendor.seed({ title: 'Back again' });
        await pull();
        const task = taskFor('1');
        const item = vendor.items.get('1')!;
        vendor.items.delete('1');
        await pull();
        expect(getVendorLink(ledger.db, task.id)!.broken_at).not.toBeNull();
        vendor.items.set('1', item);                                                   // no newer than the baseline
        setWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC, undefined);   // a full re-read lists it

        await pull();

        expect(getVendorLink(ledger.db, task.id)!.broken_at).toBeNull();
    });

    it(`re-reads at most ${LINK_CHECK_LIMIT} unseen linked items per pull, rotating through all of them`, async () => {
        const total = LINK_CHECK_LIMIT + 2;
        for (let i = 0; i < total; i++) vendor.seed({ title: `Item ${i}` });
        await pull();
        // Nothing changed since: every link is unseen by the list.
        const later = Date.now() + DAY_MS;
        setWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC, new Date(later).toISOString());
        const first = await fetchedDuring(later);
        const second = await fetchedDuring(later + HOUR_MS);
        expect(first).toHaveLength(LINK_CHECK_LIMIT);
        expect(second).toHaveLength(LINK_CHECK_LIMIT);
        expect(new Set(first.concat(second)).size).toBe(total);
    });

    it('resumes from the newest change seen when a page comes back full', async () => {
        vendor.seed({ title: 'A' });
        const second = vendor.seed({ title: 'B' });
        vendor.seed({ title: 'C' });
        await pull(Date.now(), 2);
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC)).toBe(second.updatedAt);
    });

    describe('holding the sync lease (ruling D7)', () => {
        /** A pull with every vendor call (list, item re-read, PR view) to make, and a clock it moves itself. */
        let clock: number;
        const linkedWithPr = async (): Promise<void> => {
            vendor.seed({ title: 'Linked' });
            await pull();
            recordEvent(ledger.db, { taskId: taskFor('1').id, kind: 'pr', source: 'hook:claude-code', sessionId: 'earlier', payload: { url: PR_URL } });
            clock = Date.now() + DAY_MS;
            // Nothing changed since: the list returns nothing, so the link is re-read.
            setWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC, new Date(clock).toISOString());
        };
        /** Runs `during` at the start of each vendor call the pull loops make. */
        const onEachCall = (during: () => void): void => {
            const list = vendor.listChangedSince.bind(vendor);
            const fetch = vendor.fetch.bind(vendor);
            const mergedAt = vendor.mergedAt.bind(vendor);
            jest.spyOn(vendor, 'listChangedSince').mockImplementation((since, limit) => { during(); return list(since, limit); });
            jest.spyOn(vendor, 'fetch').mockImplementation(remoteId => { during(); return fetch(remoteId); });
            jest.spyOn(vendor, 'mergedAt').mockImplementation(url => { during(); return mergedAt(url); });
        };

        it('renews the lease before every vendor call, so a pull longer than the lease keeps it', async () => {
            await linkedWithPr();
            const before = vendor.calls.length;
            const othersGotIt: boolean[] = [];
            // Each call takes as long as a vendor call may; after each, another runner tries for the lease.
            onEachCall(() => {
                clock += VENDOR_CALL_TIMEOUT_MS;
                othersGotIt.push(acquireLease(ledger.db, OTHER_HOLDER, clock));
            });

            await pullWorkspace(ledger.db, workspace, { ...deps, now: () => clock });

            expect(vendorOps(before)).toEqual(['list', 'fetch', 'mergedAt']);
            expect(othersGotIt).toEqual([false, false, false]);
        });

        it('stops at once, leaving the watermark, when another runner took the lease during a vendor call', async () => {
            await linkedWithPr();
            const watermark = getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC);
            const before = vendor.calls.length;
            let first = true;
            onEachCall(() => {
                if (first) acquireLease(ledger.db, OTHER_HOLDER, clock + LEASE_TTL_MS + 1);   // our lease ran out mid-call
                first = false;
            });

            await expect(pullWorkspace(ledger.db, workspace, { ...deps, now: () => clock })).rejects.toThrow(LeaseLostError);

            expect(vendorOps(before)).toEqual(['list']);
            expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC)).toBe(watermark);
        });
    });
});
