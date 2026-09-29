import * as fs from 'fs';
import * as path from 'path';
import { tempLedger, TempLedger, clonedRepo, outboxRows } from './helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask, insertVendorLink, updateTask, ChangeContext } from '../../src/ledger/tasks';
import { startSession } from '../../src/ledger/sessions';
import { trackWork, mergeTask, recordEvidence, EvidenceInput } from '../../src/ledger/work';
import {
    setSetting, setWorkspaceSetting, SETTING_PROGRESS_COMMENTS, SETTING_SYNC_POLICY,
    SYNC_POLICY_AUTO, SYNC_POLICY_LINKED_ONLY, SYNC_POLICY_OFF, SYNC_POLICY_PROMOTE,
} from '../../src/ledger/settings';
import { publishTask } from '../../src/ledger/projection';
import { TaskRow, VENDOR_SOURCE } from '../../src/ledger/types';

const SESSION_ID = 'writer-session';
const SOURCE = 'mcp:test';
const HUMAN: ChangeContext = { source: SOURCE, sessionId: SESSION_ID, human: true };
const FROM_VENDOR: ChangeContext = { source: VENDOR_SOURCE, human: true };

describe('queueing vendor projections', () => {
    let ledger: TempLedger;
    let repo: string;
    let workspaceId: number;

    const track = (title = 'Login fix', workspace = workspaceId): TaskRow =>
        trackWork(ledger.db, { sessionId: SESSION_ID, source: SOURCE, workspaceId: workspace, title, intent: 'implement' }).task;
    const linked = (title = 'Linked', remoteId = '7'): TaskRow => {
        const task = createTask(ledger.db, { title, phase: 'planned', workspaceId, origin: 'vendor', source: VENDOR_SOURCE });
        insertVendorLink(ledger.db, { taskId: task.id, vendor: 'github', remoteId });
        return task;
    };
    const evidence = (task: TaskRow, overrides: Partial<EvidenceInput> = {}): TaskRow => recordEvidence(ledger.db, {
        taskId: task.id, sessionId: SESSION_ID, source: SOURCE, workspaceId, cwd: repo,
        files: [], committed: false, prUrls: [], ...overrides,
    });
    const ops = (taskId: number): string[] => outboxRows(ledger.db, taskId).map(row => `${row.op}:${row.status}`);
    const payloads = (taskId: number, op: string): unknown[] =>
        outboxRows(ledger.db, taskId).filter(row => row.op === op).map(row => JSON.parse(row.payload ?? 'null'));
    const markClaimed = (taskId: number, op: string): void => {
        ledger.db.prepare("UPDATE outbox SET status = 'claimed', claimed_by = 'another-process' WHERE task_id = ? AND op = ?").run(taskId, op);
    };

    beforeEach(() => {
        ledger = tempLedger();
        // The global default is off (nothing queued); these tests are about what a workspace that opted in queues.
        setSetting(ledger.db, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);
        repo = clonedRepo(ledger.dir, 'widgets');
        workspaceId = ensureWorkspace(ledger.db, repo).id;
        startSession(ledger.db, { id: SESSION_ID, client: 'mcp', cwd: repo, workspaceId });
    });

    afterEach(() => ledger.cleanup());

    it('queues nothing at all in a workspace with no vendor', () => {
        const plainDir = path.join(ledger.dir, 'plain');
        fs.mkdirSync(plainDir);
        const plain = ensureWorkspace(ledger.db, plainDir).id;
        const task = track('Local only', plain);
        updateTask(ledger.db, task.id, { title: 'Renamed', phase: 'in_progress', comment: 'note' }, HUMAN);
        recordEvidence(ledger.db, {
            taskId: task.id, sessionId: SESSION_ID, source: SOURCE, workspaceId: plain, cwd: plainDir,
            files: ['src/a.ts'], committed: true, prUrls: ['https://github.com/acme/widgets/pull/1'],
        });
        expect(publishTask(ledger.db, task.id)).toBe('no_vendor');
        expect(ledger.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 0 });
    });

    it('queues nothing under the default off: no create, no sync_state for a linked task, no comment, and publishTask is not_allowed', () => {
        ledger.db.prepare('DELETE FROM settings WHERE key = ?').run(SETTING_SYNC_POLICY);
        const local = track('Local');
        const remote = linked();
        updateTask(ledger.db, local.id, { title: 'Renamed', phase: 'in_progress', comment: 'note' }, HUMAN);
        updateTask(ledger.db, remote.id, { title: 'Renamed', phase: 'in_progress', comment: 'note' }, HUMAN);
        evidence(local, { committed: true, prUrls: ['https://github.com/acme/widgets/pull/1'] });
        const other = createTask(ledger.db, { title: 'Other', phase: 'planned', workspaceId, origin: 'local', source: SOURCE });
        mergeTask(ledger.db, { fromRef: `T${remote.id}`, intoRef: `T${other.id}`, workspaceId, source: SOURCE, sessionId: SESSION_ID });
        expect(publishTask(ledger.db, local.id)).toBe('not_allowed');
        expect(publishTask(ledger.db, remote.id)).toBe('not_allowed');
        expect(ledger.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 0 });
    });

    it('queues nothing when the policy is set to off explicitly', () => {
        setWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY, SYNC_POLICY_OFF);
        const task = track();
        expect(publishTask(ledger.db, task.id)).toBe('not_allowed');
        expect(ops(task.id)).toEqual([]);
    });

    it('queues one create for a new task, which carries every change made before it is pushed', () => {
        const task = track();
        updateTask(ledger.db, task.id, { title: 'Login token fix', phase: 'in_progress', comment: 'started' }, HUMAN);
        expect(ops(task.id)).toEqual(['create:pending', 'comment:pending', 'comment:pending']);
        expect(payloads(task.id, 'comment')).toEqual([{ text: 'Phase: planned → in_progress' }, { text: 'started' }]);
    });

    it('keeps one pending sync_state per task however often it changes', () => {
        const task = linked();
        updateTask(ledger.db, task.id, { title: 'A' }, HUMAN);
        updateTask(ledger.db, task.id, { title: 'B' }, HUMAN);
        updateTask(ledger.db, task.id, { phase: 'in_progress' }, { ...HUMAN, human: false });
        expect(ops(task.id).filter(op => op.startsWith('sync_state'))).toEqual(['sync_state:pending']);
    });

    it('queues a new sync_state when the previous one is already being pushed', () => {
        const task = linked();
        updateTask(ledger.db, task.id, { title: 'First' }, HUMAN);
        markClaimed(task.id, 'sync_state');
        updateTask(ledger.db, task.id, { title: 'Second' }, HUMAN);
        expect(ops(task.id)).toEqual(['sync_state:claimed', 'sync_state:pending']);
    });

    it('queues a sync_state behind a create that is already being pushed', () => {
        const task = track();
        markClaimed(task.id, 'create');
        updateTask(ledger.db, task.id, { title: 'Renamed mid-push' }, HUMAN);
        expect(ops(task.id)).toEqual(['create:claimed', 'sync_state:pending']);
    });

    it('comments on a phase move with the evidence since the last one', () => {
        const task = linked();
        evidence(task, { files: ['src/a.ts', 'src/b.ts'], committed: true });
        expect(payloads(task.id, 'comment')).toEqual([{ text: 'Phase: planned → in_progress · 1 commit · 2 files' }]);
    });

    it('posts no phase comment when progress_comments is none', () => {
        setWorkspaceSetting(ledger.db, workspaceId, SETTING_PROGRESS_COMMENTS, 'none');
        const task = linked();
        updateTask(ledger.db, task.id, { phase: 'in_review' }, HUMAN);
        expect(ops(task.id)).toEqual(['sync_state:pending']);
    });

    it('queues an explicit comment without a sync, and nothing that came from the vendor', () => {
        const task = linked();
        updateTask(ledger.db, task.id, { comment: 'from the user' }, HUMAN);
        updateTask(ledger.db, task.id, { title: 'Renamed on GitHub', comment: 'from GitHub' }, FROM_VENDOR);
        expect(ops(task.id)).toEqual(['comment:pending']);
        expect(payloads(task.id, 'comment')).toEqual([{ text: 'from the user' }]);
    });

    it('waits for promotion under promote: an explicit publish or a first commit', () => {
        setSetting(ledger.db, SETTING_SYNC_POLICY, SYNC_POLICY_PROMOTE);
        const published = track('Published');
        updateTask(ledger.db, published.id, { title: 'Still quiet', comment: 'not yet' }, HUMAN);
        expect(ops(published.id)).toEqual([]);
        expect(publishTask(ledger.db, published.id)).toBe('create_queued');
        expect(ops(published.id)).toEqual(['create:pending']);

        const committed = track('Committed');
        evidence(committed, { committed: true });
        expect(ops(committed.id)).toEqual(['create:pending']);
    });

    it('never creates under linked-only, yet keeps linked tasks in sync', () => {
        setSetting(ledger.db, SETTING_SYNC_POLICY, SYNC_POLICY_LINKED_ONLY);
        const local = track('Local');
        const remote = linked();
        expect(publishTask(ledger.db, local.id)).toBe('not_allowed');
        updateTask(ledger.db, remote.id, { title: 'Renamed' }, HUMAN);
        expect(ops(local.id)).toEqual([]);
        expect(ops(remote.id)).toEqual(['sync_state:pending']);
    });

    it('closes a merged-away duplicate instead of syncing it when both tasks are linked', () => {
        const duplicate = linked('Dup', '51');
        const kept = linked('Kept', '50');
        mergeTask(ledger.db, { fromRef: `T${duplicate.id}`, intoRef: `T${kept.id}`, workspaceId, source: SOURCE, sessionId: SESSION_ID });
        expect(ops(duplicate.id)).toEqual(['comment:pending', 'close_duplicate:pending']);
        expect(payloads(duplicate.id, 'close_duplicate')).toEqual([{ of: '50' }]);
    });

    it('never creates a vendor item for a task merged away before it was pushed', () => {
        const duplicate = track('Local dup');
        const kept = track('Kept');
        expect(ops(duplicate.id)).toEqual(['create:pending']);
        mergeTask(ledger.db, { fromRef: `T${duplicate.id}`, intoRef: `T${kept.id}`, workspaceId, source: SOURCE, sessionId: SESSION_ID });
        expect(ops(duplicate.id)).toEqual([]);
    });

    it('queues nothing for a task dropped before its create was pushed', () => {
        const task = track();
        updateTask(ledger.db, task.id, { comment: 'note' }, HUMAN);
        updateTask(ledger.db, task.id, { phase: 'dropped' }, HUMAN);
        expect(ops(task.id)).toEqual([]);
    });

    it('leaves a claimed create for the pusher when the task is dropped', () => {
        const task = track();
        markClaimed(task.id, 'create');
        updateTask(ledger.db, task.id, { phase: 'dropped' }, HUMAN);
        expect(ops(task.id)).toEqual(['create:claimed', 'sync_state:pending', 'comment:pending']);
    });

    it('queues nothing for a task whose vendor item is gone', () => {
        const task = linked();
        ledger.db.prepare('UPDATE vendor_links SET broken_at = ? WHERE task_id = ?').run(new Date().toISOString(), task.id);
        updateTask(ledger.db, task.id, { title: 'Renamed', comment: 'note' }, HUMAN);
        expect(publishTask(ledger.db, task.id)).toBe('broken_link');
        expect(ops(task.id)).toEqual([]);
    });

    it('lets a newer desired state replace a sync_state that gave up', () => {
        const task = linked();
        updateTask(ledger.db, task.id, { title: 'A' }, HUMAN);
        ledger.db.prepare("UPDATE outbox SET status = 'failed' WHERE task_id = ?").run(task.id);
        updateTask(ledger.db, task.id, { title: 'B' }, HUMAN);
        expect(ops(task.id)).toEqual(['sync_state:pending']);
    });
});
