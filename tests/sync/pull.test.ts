import * as fs from 'fs';
import * as path from 'path';
import { tempLedger, TempLedger, clonedRepo, outboxRows } from '../ledger/helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { getTask, getVendorLink, updateTask, TaskUpdate } from '../../src/ledger/tasks';
import { listEvents, recordEvent } from '../../src/ledger/events';
import { startSession } from '../../src/ledger/sessions';
import { recordEvidence, trackWork } from '../../src/ledger/work';
import {
    getWorkspaceSetting, setSetting, setWorkspaceSetting, DEFAULT_SYNC_PULL_MINUTES, SETTING_CURRENT_USER, SETTING_LAST_SYNC,
    SETTING_PROGRESS_COMMENTS, SETTING_PULL_WATERMARK, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO,
} from '../../src/ledger/settings';
import { TaskRow, WorkspaceRow } from '../../src/ledger/types';
import { acquireLease, LeaseLostError, LEASE_TTL_MS } from '../../src/sync/lease';
import { PUSH_BACKOFF_BASE_MS } from '../../src/sync/outbox';
import { pullWorkspace, PULL_OVERLAP_MS, PULL_WINDOW_DAYS, LINK_CHECK_LIMIT, PR_CHECK_LIMIT, WorkspaceGoneError } from '../../src/sync/pull';
import { unregisterWorkspace } from '../../src/workspace-commands';
import { pushDue, PushDeps } from '../../src/sync/push';
import { pullIsDue } from '../../src/sync/schedule';
import { GoneError, VENDOR_CALL_TIMEOUT_MS } from '../../src/sync/vendor';
import { SYNC_LOG_FILE } from '../../src/hook/log';
import { FakeVendor } from './fake-vendor';

const SOURCE = 'mcp:test';
const SESSION_ID = 'pull-session';
const HOLDER = 'pid:pull-test';
const OTHER_HOLDER = 'pid:other-runner';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const PR_URL = 'https://github.com/acme/widgets/pull/9';
const LOST_ANSWER = 'gh timed out after 45000 ms';
/** Past the first retry's backoff: the retried push is due. */
const RETRY_DUE_MS = PUSH_BACKOFF_BASE_MS + 5000;
/** A change the vendor dates this long before a pull began, but lists only afterwards (clock skew, index lag). */
const LATE_CHANGE_MS = 2 * 60 * 1000;
const UNREADABLE_PR = 'HTTP 502: Bad Gateway';

describe('pulling a vendor workspace', () => {
    let ledger: TempLedger;
    let workspace: WorkspaceRow;
    let vendor: FakeVendor;
    let deps: PushDeps;
    let originalHome: string | undefined;

    /** One pull that begins at `now`. */
    const pull = (now: number = Date.now(), pageLimit?: number) => pullWorkspace(ledger.db, workspace, { ...deps, now: () => now }, pageLimit);
    const push = (laterMs = 0) => pushDue(ledger.db, { ...deps, now: () => Date.now() + laterMs });
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

    /** Runs `during` at the start of each vendor call the pull loops make. */
    const onEachCall = (during: (op: string) => void): void => {
        const list = vendor.listChangedSince.bind(vendor);
        const fetch = vendor.fetch.bind(vendor);
        const mergedAt = vendor.mergedAt.bind(vendor);
        jest.spyOn(vendor, 'listChangedSince').mockImplementation((since, limit) => { during('list'); return list(since, limit); });
        jest.spyOn(vendor, 'fetch').mockImplementation(remoteId => { during('fetch'); return fetch(remoteId); });
        jest.spyOn(vendor, 'mergedAt').mockImplementation(url => { during('mergedAt'); return mergedAt(url); });
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

    it('starts 90 days back, and moves the watermark to a little before the pull began', async () => {
        const now = Date.now();
        const watermark = new Date(now - PULL_OVERLAP_MS).toISOString();
        await pull(now);
        expect(vendor.calls.find(call => call.op === 'list')!.text).toBe(new Date(now - PULL_WINDOW_DAYS * DAY_MS).toISOString());
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_PULL_WATERMARK)).toBe(watermark);
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC)).toBe(new Date(now).toISOString());
        await pull(now + HOUR_MS);
        expect(vendor.calls.filter(call => call.op === 'list')[1].text).toBe(watermark);
    });

    it('is not due again right after a pull, only sync_pull_minutes later', async () => {
        const now = Date.now();
        await pull(now);
        expect(pullIsDue(ledger.db, workspace, now)).toBe(false);
        expect(pullIsDue(ledger.db, workspace, now + DEFAULT_SYNC_PULL_MINUTES * MINUTE_MS - 1)).toBe(false);
        expect(pullIsDue(ledger.db, workspace, now + DEFAULT_SYNC_PULL_MINUTES * MINUTE_MS)).toBe(true);
    });

    it('still pulls a ledger from before the watermark, reading from its last_sync', async () => {
        const legacy = '2026-09-01T00:00:00.000Z';
        setWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC, legacy);
        vendor.seed({ title: 'Changed since' });
        const now = Date.now();

        expect((await pull(now)).created).toBe(1);

        expect(vendor.calls.find(call => call.op === 'list')!.text).toBe(legacy);
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_PULL_WATERMARK)).toBe(new Date(now - PULL_OVERLAP_MS).toISOString());
    });

    it('still pulls a change the vendor dates shortly before the last pull began but listed only after it', async () => {
        const now = Date.now();
        await pull(now);
        const late = vendor.seed({ title: 'Indexed late' });
        vendor.items.get(late.remoteId)!.updatedAt = new Date(now - LATE_CHANGE_MS).toISOString();

        expect((await pull(now + HOUR_MS)).created).toBe(1);
    });

    it('leaves the watermark and the last pull time where they were when the vendor call fails', async () => {
        setWorkspaceSetting(ledger.db, workspace.id, SETTING_CURRENT_USER, 'octocat');
        setWorkspaceSetting(ledger.db, workspace.id, SETTING_PULL_WATERMARK, '2026-09-01T00:00:00.000Z');
        setWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC, '2026-09-01T00:05:00.000Z');
        vendor.failNext = new Error('HTTP 502');
        await expect(pull()).rejects.toThrow('HTTP 502');
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_PULL_WATERMARK)).toBe('2026-09-01T00:00:00.000Z');
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC)).toBe('2026-09-01T00:05:00.000Z');
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
        vendor.failAfterApply = new Error(LOST_ANSWER);   // B landed; its answer did not
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
        vendor.failAfterApply = new Error(LOST_ANSWER);
        expect((await push()).retried).toBe(1);

        expect((await pull()).humanEdits).toBe(0);

        expect(getTask(ledger.db, task.id)!.title).toBe('B');
        expect(getVendorLink(ledger.db, task.id)).toMatchObject({ remote_title: 'B', last_pushed_rev: renamed.rev, intent_title: null });
    });

    // Ruling F1: ownership is decided per field.
    it('keeps a local rename made since our push landed, when a person only closed the item, and pushes it', async () => {
        const task = track('A');
        await push();
        change(task.id, { title: 'B' });
        vendor.failAfterApply = new Error(LOST_ANSWER);   // B landed; its answer did not
        expect((await push()).retried).toBe(1);
        change(task.id, { title: 'C' });
        vendor.humanEdit('1', { state: 'closed:completed' });   // a person only closes it

        expect((await pull()).humanEdits).toBe(1);

        expect(getTask(ledger.db, task.id)).toMatchObject({ title: 'C', phase: 'done' });
        expect(listEvents(ledger.db, { taskId: task.id, kinds: ['renamed'] }).map(event => event.source)).toEqual([SOURCE, SOURCE]);
        expect(pendingOps(task.id)).toContain('sync_state');
        await push(RETRY_DUE_MS);
        expect(vendor.items.get('1')).toMatchObject({ title: 'C', state: 'closed:completed' });
    });

    it('keeps a local phase change made since our push landed, when a person only renamed the item, and pushes it', async () => {
        setSetting(ledger.db, SETTING_PROGRESS_COMMENTS, 'none');   // the lost answer is then the state push's
        const task = track('A');
        await push();
        change(task.id, { phase: 'in_review' });
        vendor.failAfterApply = new Error(LOST_ANSWER);   // in_review landed; its answer did not
        expect((await push()).retried).toBe(1);
        change(task.id, { phase: 'planned' });
        vendor.humanEdit('1', { title: 'Renamed by a person' });

        expect((await pull()).humanEdits).toBe(1);

        expect(getTask(ledger.db, task.id)).toMatchObject({ title: 'Renamed by a person', phase: 'planned' });
        expect(listEvents(ledger.db, { taskId: task.id, kinds: ['phase'] }).map(event => event.source)).toEqual([SOURCE, SOURCE]);
        expect(pendingOps(task.id)).toContain('sync_state');
        await push(RETRY_DUE_MS);
        expect(vendor.items.get('1')).toMatchObject({ title: 'Renamed by a person', labels: ['ghostpm:planned'] });
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
        vendor.items.set('1', item);   // no newer than the baseline
        // A full re-read lists it.
        setWorkspaceSetting(ledger.db, workspace.id, SETTING_PULL_WATERMARK, undefined);
        setWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC, undefined);

        await pull();

        expect(getVendorLink(ledger.db, task.id)!.broken_at).toBeNull();
    });

    it(`re-reads at most ${LINK_CHECK_LIMIT} unseen linked items per pull, rotating through all of them`, async () => {
        const total = LINK_CHECK_LIMIT + 2;
        for (let i = 0; i < total; i++) vendor.seed({ title: `Item ${i}` });
        await pull();
        // Nothing changed since: every link is unseen by the list.
        const later = Date.now() + DAY_MS;
        setWorkspaceSetting(ledger.db, workspace.id, SETTING_PULL_WATERMARK, new Date(later).toISOString());
        const first = await fetchedDuring(later);
        const second = await fetchedDuring(later + HOUR_MS);
        expect(first).toHaveLength(LINK_CHECK_LIMIT);
        expect(second).toHaveLength(LINK_CHECK_LIMIT);
        expect(new Set(first.concat(second)).size).toBe(total);
    });

    it('resumes from the newest change seen when a page comes back full, due again at once until a page comes back short', async () => {
        vendor.seed({ title: 'A' });
        const second = vendor.seed({ title: 'B' });
        const third = vendor.seed({ title: 'C' });
        const now = Date.now();
        const sinceOf = (call: number): string => vendor.calls.filter(entry => entry.op === 'list')[call].text!;

        expect((await pull(now, 2)).more).toBe(true);   // A, B
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_PULL_WATERMARK)).toBe(second.updatedAt);
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC)).toBeUndefined();
        expect(pullIsDue(ledger.db, workspace, now)).toBe(true);

        expect((await pull(now, 2)).more).toBe(true);   // B again, C: full once more
        expect(sinceOf(1)).toBe(second.updatedAt);
        expect(pullIsDue(ledger.db, workspace, now)).toBe(true);

        expect((await pull(now, 2)).more).toBe(false);   // C alone: caught up
        expect(sinceOf(2)).toBe(third.updatedAt);
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC)).toBe(new Date(now).toISOString());
        expect(pullIsDue(ledger.db, workspace, now)).toBe(false);
    });

    it('reads an answer as complete, however long, from a vendor that does not list by page (F6)', async () => {
        vendor.pages = false;
        ['A', 'B', 'C'].forEach(title => vendor.seed({ title }));
        const now = Date.now();

        const summary = await pull(now, 2);

        expect(summary).toMatchObject({ fetched: 3, created: 3, more: false });
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_PULL_WATERMARK)).toBe(new Date(now - PULL_OVERLAP_MS).toISOString());
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC)).toBe(new Date(now).toISOString());
    });

    it('skips a pull request that is gone, logs one it cannot read, checks the rest and still finishes the pull (F5)', async () => {
        vendor.seed({ title: 'Gone PR' });
        vendor.seed({ title: 'Unreadable PR' });
        vendor.seed({ title: 'Merged PR', labels: ['ghostpm:in_review'] });
        await pull();
        const urls = ['1', '2', '3'].map(id => `https://github.com/acme/widgets/pull/${id}`);
        urls.forEach((url, index) => recordEvent(ledger.db, {
            taskId: taskFor(String(index + 1)).id, kind: 'pr', source: 'hook:claude-code', sessionId: 'earlier', payload: { url },
        }));
        const mergedAt = new Date(Date.now() - HOUR_MS).toISOString();
        jest.spyOn(vendor, 'mergedAt').mockImplementation(async url => {
            if (url === urls[0]) throw new GoneError('GraphQL: Could not resolve to a PullRequest with the number of 1.');
            if (url === urls[1]) throw new Error(UNREADABLE_PR);
            return mergedAt;
        });
        const now = Date.now() + HOUR_MS;

        expect((await pull(now)).merged).toBe(1);

        expect(taskFor('3').phase).toBe('done');
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_LAST_SYNC)).toBe(new Date(now).toISOString());
        const log = fs.readFileSync(path.join(ledger.dir, SYNC_LOG_FILE), 'utf8');
        expect(log).toContain(`${urls[1]}: ${UNREADABLE_PR}`);
        expect(log).not.toContain(urls[0]);
    });

    it(`asks about each pull request once however often it was recorded, rotating through all of them ${PR_CHECK_LIMIT} a pull (F9)`, async () => {
        vendor.seed({ title: 'Many PRs' });
        vendor.seed({ title: 'Shares one' });
        await pull();
        const total = PR_CHECK_LIMIT + 2;
        const urls = Array.from({ length: total }, (_, index) => `https://github.com/acme/widgets/pull/${index + 1}`);
        for (const url of urls.concat(urls)) {   // each recorded twice
            recordEvent(ledger.db, { taskId: taskFor('1').id, kind: 'pr', source: 'hook:claude-code', sessionId: 'earlier', payload: { url } });
        }
        recordEvent(ledger.db, { taskId: taskFor('2').id, kind: 'pr', source: 'hook:claude-code', sessionId: 'earlier', payload: { url: urls[0] } });
        const askedDuring = async (now: number): Promise<string[]> => {
            const before = vendor.calls.length;
            await pull(now);
            return vendor.calls.slice(before).filter(call => call.op === 'mergedAt').map(call => call.text!);
        };
        const later = Date.now() + DAY_MS;

        const first = await askedDuring(later);
        const second = await askedDuring(later + HOUR_MS);

        expect(first).toEqual(urls.slice(0, PR_CHECK_LIMIT));
        expect(second).toHaveLength(PR_CHECK_LIMIT);
        expect(new Set(first.concat(second)).size).toBe(total);
        vendor.prs.set(urls[0], new Date(Date.now() - HOUR_MS).toISOString());
        await pull(later + 2 * HOUR_MS);
        expect([taskFor('1').phase, taskFor('2').phase]).toEqual(['done', 'done']);   // one merge moves every task that recorded it
    });

    it('has nothing more to read at once after a full page whose changes all share the time it read from (tie stall, F10)', async () => {
        const items = [vendor.seed({ title: 'A' }), vendor.seed({ title: 'B' })];
        const tied = items[0].updatedAt;
        items.forEach(item => { vendor.items.get(item.remoteId)!.updatedAt = tied; });
        const now = Date.now();

        expect((await pull(now, 2)).more).toBe(true);    // the watermark moves up to the tied time
        expect((await pull(now, 2)).more).toBe(false);   // the same page again: it cannot move past it
        expect(getWorkspaceSetting(ledger.db, workspace.id, SETTING_PULL_WATERMARK)).toBe(tied);
    });

    describe('racing `ghostpm unregister` of the workspace it pulls', () => {
        /** Workspace ids are reused (INTEGER PRIMARY KEY without AUTOINCREMENT): the next folder registered takes this one's. */
        const nextWorkspace = (): WorkspaceRow => ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'gadgets'));
        const ownedBy = (id: number): { title: string; remote_id: string | null }[] => ledger.db.prepare(
            'SELECT t.title, l.remote_id FROM tasks t LEFT JOIN vendor_links l ON l.task_id = t.id WHERE t.workspace_id = ?',
        ).all(id) as { title: string; remote_id: string | null }[];
        const count = (table: string): number => (ledger.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

        it('stops, writing nothing it listed, once the workspace is unregistered during the list', async () => {
            vendor.seed({ title: 'Issue 1 from widgets' });
            onEachCall(op => { if (op === 'list') unregisterWorkspace(ledger.db, workspace); });

            await expect(pull()).rejects.toThrow(WorkspaceGoneError);

            expect([count('tasks'), count('vendor_links')]).toEqual([0, 0]);
            const next = nextWorkspace();
            expect(next.id).toBe(workspace.id);
            expect(ownedBy(next.id)).toEqual([]);
        });

        it('writes nothing into a workspace that took the unregistered one\'s id while the list was out', async () => {
            vendor.seed({ title: 'Issue 1 from widgets' });
            let next: WorkspaceRow | undefined;
            onEachCall(op => {
                if (op !== 'list') return;
                unregisterWorkspace(ledger.db, workspace);
                next = nextWorkspace();
            });

            await expect(pull()).rejects.toThrow(WorkspaceGoneError);

            expect(next!.id).toBe(workspace.id);
            expect(ownedBy(next!.id)).toEqual([]);
            expect([SETTING_PULL_WATERMARK, SETTING_LAST_SYNC].map(key => getWorkspaceSetting(ledger.db, next!.id, key))).toEqual([undefined, undefined]);
        });
    });

    describe('holding the sync lease (rulings D7, F2)', () => {
        /** The pull's clock, which the tests move themselves. */
        let clock: number;
        const pullOnClock = () => pullWorkspace(ledger.db, workspace, { ...deps, now: () => clock });
        /** Our lease ran out while a call was out, and another runner took it. */
        const otherRunnerTakesLease = (): boolean => acquireLease(ledger.db, OTHER_HOLDER, clock + LEASE_TTL_MS + 1);
        /** The watermark and the last pull time: a pull that stops part way moves neither. */
        const pullMarks = (): (string | undefined)[] => [SETTING_PULL_WATERMARK, SETTING_LAST_SYNC]
            .map(key => getWorkspaceSetting<string>(ledger.db, workspace.id, key));
        /** A pull with every vendor call (list, item re-read, PR view) to make. */
        const linkedWithPr = async (): Promise<void> => {
            vendor.seed({ title: 'Linked' });
            await pull();
            recordEvent(ledger.db, { taskId: taskFor('1').id, kind: 'pr', source: 'hook:claude-code', sessionId: 'earlier', payload: { url: PR_URL } });
            clock = Date.now() + DAY_MS;
            // Nothing changed since: the list returns nothing, so the link is re-read.
            setWorkspaceSetting(ledger.db, workspace.id, SETTING_PULL_WATERMARK, new Date(clock).toISOString());
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

            await pullOnClock();

            expect(vendorOps(before)).toEqual(['list', 'fetch', 'mergedAt']);
            expect(othersGotIt).toEqual([false, false, false]);
        });

        it('stops at once, leaving the watermark, when another runner took the lease during a vendor call', async () => {
            await linkedWithPr();
            const marks = pullMarks();
            const before = vendor.calls.length;
            onEachCall(op => { if (op === 'list') otherRunnerTakesLease(); });

            await expect(pullOnClock()).rejects.toThrow(LeaseLostError);

            expect(vendorOps(before)).toEqual(['list']);
            expect(pullMarks()).toEqual(marks);
        });

        it('writes nothing it listed once another runner took the lease during the list', async () => {
            clock = Date.now();
            vendor.seed({ title: 'Listed as the lease ran out' });
            onEachCall(op => { if (op === 'list') otherRunnerTakesLease(); });

            await expect(pullOnClock()).rejects.toThrow(LeaseLostError);

            expect(taskFor('1')).toBeUndefined();
            expect(pullMarks()).toEqual([undefined, undefined]);
        });

        it('moves no task and leaves the watermark once another runner took the lease during the last vendor call', async () => {
            await linkedWithPr();
            vendor.prs.set(PR_URL, new Date(Date.now() - HOUR_MS).toISOString());
            const marks = pullMarks();
            onEachCall(op => { if (op === 'mergedAt') otherRunnerTakesLease(); });

            await expect(pullOnClock()).rejects.toThrow(LeaseLostError);

            expect(taskFor('1').phase).toBe('planned');
            expect(pullMarks()).toEqual(marks);
        });
    });
});
