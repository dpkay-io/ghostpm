import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as child_process from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PmServer } from '../src/mcp-server';
import { Ledger, openLedger, LEDGER_FILE } from '../src/ledger/db';
import { ensureWorkspace } from '../src/ledger/workspaces';
import { recordEvent } from '../src/ledger/events';
import { SINCE_HELP } from '../src/surfaces/since';
import { createTask, updateTask, insertVendorLink, getTask, NewTask } from '../src/ledger/tasks';
import {
    setSetting, setSyncPause, setWorkspaceSetting, SETTING_CREATE_BRANCH, SETTING_CURRENT_USER, SETTING_SYNC_POLICY,
    SYNC_POLICY_AUTO, SYNC_POLICY_LINKED_ONLY, SYNC_POLICY_OFF, SYNC_POLICY_PROMOTE,
} from '../src/ledger/settings';
import * as ledgerTypes from '../src/ledger/types';
import { tempLedger, TempLedger, clonedRepo, outboxRows } from './ledger/helpers';
import { removeTempDir } from './temp-dir';

jest.mock('child_process');

const SESSION_ID = 'mcp:test';
const GIT_FAILURE = 'not a git repository';
const TOOL_NAMES = [
    'get_project_state', 'get_task', 'merge_task', 'open_attachment',
    'query_tasks', 'set_sprint', 'timeline', 'track_work', 'update_task',
];

describe('mcp server on the ledger', () => {
    let dir: string;
    let db: Ledger;
    let client: Client;
    let workspaceId: number;

    const mockExecFile = (error: Error | null, stdout = '') => {
        (child_process.execFile as unknown as jest.Mock).mockImplementation((...args: unknown[]) => {
            const cb = args[args.length - 1];
            if (typeof cb === 'function') (cb as (e: Error | null, out: string, err: string) => void)(error, stdout, '');
        });
    };

    const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
        const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[] };
        return result.content[0].text;
    };

    /** Discriminates by the git subcommand, unlike mockExecFile which answers every call the same way. */
    const mockExecFileByArgs = (handler: (args: string[]) => { error: Error | null; stdout?: string }) => {
        (child_process.execFile as unknown as jest.Mock).mockImplementation((...callArgs: unknown[]) => {
            const cb = callArgs[callArgs.length - 1];
            const gitArgs = (callArgs[1] as string[]) ?? [];
            const { error, stdout = '' } = handler(gitArgs);
            if (typeof cb === 'function') (cb as (e: Error | null, out: string, err: string) => void)(error, stdout, '');
        });
    };

    const task = (title: string, overrides: Partial<NewTask> = {}) =>
        createTask(db, { title, phase: 'planned', workspaceId, origin: 'local', source: 'test', ...overrides });

    beforeEach(async () => {
        mockExecFile(new Error(GIT_FAILURE));
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-mcp-'));
        db = openLedger(path.join(dir, LEDGER_FILE));
        workspaceId = ensureWorkspace(db, dir).id;
        const server = new PmServer({ db, cwd: dir, sessionId: SESSION_ID, legacyImport: false });
        client = new Client({ name: 'test-client', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.run(serverTransport)]);
    });

    afterEach(async () => {
        await client.close();
        db.close();
        removeTempDir(dir);
        jest.clearAllMocks();
    });

    it('registers the ledger tools and none of the removed ones', async () => {
        const names = (await client.listTools()).tools.map(t => t.name).sort();
        expect(names).toEqual(TOOL_NAMES);
    });

    it('reports workspace, phase counts, live sessions and no active task', async () => {
        task('Login fix', { phase: 'in_progress' });
        task('Docs');
        const state = await call('get_project_state');
        expect(state).toContain(`(vendor: none)`);
        expect(state).toContain('**Tasks:** 2 total — 1 planned, 1 in_progress');
        expect(state).toContain('**Active Task:** _none_');
        expect(state).toContain('**Live Sessions:** 1');
        expect(state).toContain('**Current Branch:** _unknown_');
    });

    it('reports sync as off in a workspace with no vendor', async () => {
        expect(await call('get_project_state')).toContain('**Sync:** off (no GitHub or Azure DevOps remote)');
    });

    it('shows the task named by the current task/<ref> branch', async () => {
        const tracked = task('Branch task');
        mockExecFile(null, `task/T${tracked.id}\n`);
        expect(await call('get_project_state')).toContain(`**Active Task:** T${tracked.id} Branch task · planned`);
    });

    it('renders tasks as a table with local and remote ids', async () => {
        const imported = task('Login fix', { origin: 'vendor', assignee: 'dpk' });
        insertVendorLink(db, { taskId: imported.id, vendor: 'github', remoteId: '42' });
        const table = await call('query_tasks');
        expect(table).toContain('| id | phase | title | assignee | remote |');
        expect(table).toContain(`| T${imported.id} | planned | Login fix | dpk | #42 |`);
    });

    it('resolves @me only when the user is known', async () => {
        task('Mine', { assignee: 'dpk' });
        task('Theirs', { assignee: 'sam' });
        expect(await call('query_tasks', { assignee: '@me' })).toContain('not detected');
        setWorkspaceSetting(db, workspaceId, SETTING_CURRENT_USER, 'dpk');
        const mine = await call('query_tasks', { assignee: '@me' });
        expect(mine).toContain('Mine');
        expect(mine).not.toContain('Theirs');
    });

    it('filters by phase and reports when nothing matches', async () => {
        task('Planned one');
        expect(await call('query_tasks', { phase: 'planned' })).toContain('Planned one');
        expect(await call('query_tasks', { phase: 'done' })).toBe('No tasks found.');
    });

    it('activates, lists and clears the sprint', async () => {
        task('Sprint task', { origin: 'vendor', milestone: 'Sprint 1' });
        expect(await call('set_sprint', { sprint_name: 'Sprint 1' })).toContain('Active sprint set to **Sprint 1** (1 task)');
        expect(await call('set_sprint')).toContain('→ Sprint 1');
        expect(await call('query_tasks')).toContain('_Sprint: Sprint 1_');
        expect(await call('set_sprint', { sprint_name: '__clear__' })).toContain('cleared');
    });

    it('returns task details with vendor link and comments', async () => {
        const imported = task('Login fix', { origin: 'vendor', body: 'details' });
        insertVendorLink(db, { taskId: imported.id, vendor: 'github', remoteId: '42', remoteUrl: 'https://example.invalid/42', remoteState: 'open' });
        updateTask(db, imported.id, { comment: 'from the board' }, { source: 'vendor', human: false });
        const parsed = JSON.parse(await call('get_task', { task_id: `T${imported.id}` }));
        expect(parsed).toMatchObject({
            id: `T${imported.id}`, title: 'Login fix', phase: 'planned', origin: 'vendor', body: 'details',
            vendor: { vendor: 'github', id: '42', url: 'https://example.invalid/42', state: 'open' },
        });
        expect(parsed.comments[0].text).toBe('from the board');
        expect(await call('get_task', { task_id: 'T999' })).toBe('Task T999 not found.');
    });

    it("reports the task's own workspace, not the caller's", async () => {
        const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-other-'));
        try {
            const callerWorkspace = ensureWorkspace(db, dir);
            const other = ensureWorkspace(db, otherDir);
            const elsewhere = createTask(db, {
                title: 'Elsewhere', phase: 'planned', workspaceId: other.id, origin: 'local', source: 'test',
            });
            const parsed = JSON.parse(await call('get_task', { task_id: `T${elsewhere.id}` }));
            expect(parsed.workspace).toBe(other.path);
            expect(parsed.workspace).not.toBe(callerWorkspace.path);
        } finally {
            fs.rmSync(otherDir, { recursive: true, force: true });
        }
    });

    it('opens an attachment through the platform command', async () => {
        mockExecFile(null);
        expect(await call('open_attachment', { url: 'https://example.invalid/x' })).toContain('opened');
        expect(child_process.execFile).toHaveBeenCalled();
    });

    it('opens a vendor URL with shell metacharacters via rundll32, never through cmd.exe', async () => {
        mockExecFile(null);
        // A vendor-supplied URL (spec §8.9) can carry '&'; a shell-parsed cmd.exe form would
        // split this into two commands. The exact argv below only holds for a shell-free call.
        const url = 'https://example.invalid/x?a=1&b=2';
        expect(await call('open_attachment', { url })).toContain('opened');
        expect(child_process.execFile).toHaveBeenCalledWith(
            'rundll32.exe', ['url.dll,FileProtocolHandler', url], expect.any(Function)
        );
    });

    it('creates a task and attaches later work to it', async () => {
        const created = await call('track_work', { title: 'Login fix', intent: 'implement' });
        expect(created).toMatch(/^Created T\d+ "Login fix" \(planned\)\.$/);
        const id = created.match(/T\d+/)![0];
        expect(await call('track_work', { title: 'now planning', intent: 'plan', task_id: id })).toContain(`Attached to ${id}`);
        expect(await call('get_project_state')).toContain(`**Active Task:** ${id} Login fix · planned`);
    });

    it('reopens a closed task', async () => {
        const closed = task('Closed', { phase: 'done' });
        expect(await call('track_work', { title: 'more work', intent: 'fix', task_id: `T${closed.id}` }))
            .toContain(`Reopened T${closed.id}`);
    });

    it('updates phase, title and comment as a human change', async () => {
        const existing = task('Login fix');
        expect(await call('update_task', { task_id: `T${existing.id}` })).toContain('Provide a phase');
        expect(await call('update_task', { task_id: `T${existing.id}`, phase: 'in_review', comment: 'PR up' })).toContain('in_review');
        expect(getTask(db, existing.id)!.human_phase_at).not.toBeNull();
        expect(await call('update_task', { task_id: 'T999', phase: 'done' })).toBe('Task T999 not found.');
    });

    it('merges duplicates and reports refusals as errors', async () => {
        const duplicate = task('Dup');
        const kept = task('Kept');
        expect(await call('merge_task', { from: `T${duplicate.id}`, into: `T${kept.id}` }))
            .toContain(`Merged T${duplicate.id} into T${kept.id}`);
        expect(getTask(db, duplicate.id)!.phase).toBe('dropped');

        const refused = await client.callTool({ name: 'merge_task', arguments: { from: `T${kept.id}`, into: `T${kept.id}` } }) as { isError?: boolean; content: { text: string }[] };
        expect(refused.isError).toBe(true);
        expect(refused.content[0].text).toContain('Cannot merge a task into itself');
    });

    it('lists recent activity in the timeline', async () => {
        const created = await call('track_work', { title: 'Login fix', intent: 'implement' });
        const id = created.match(/T\d+/)![0];
        await call('update_task', { task_id: id, phase: 'in_review' });
        const timeline = await call('timeline');
        expect(timeline).toContain(`${id} Login fix · created`);
        expect(timeline).toContain('planned → in_review');
        expect(await call('timeline', { since: new Date(Date.now() + 60_000).toISOString() })).toBe('Nothing recorded in that period.');
    });

    it('renders hook evidence and keeps PR links instead of printing undefined (gap N1)', async () => {
        const tracked = task('Login fix');
        const hook = 'hook:claude-code';
        recordEvent(db, { taskId: tracked.id, kind: 'progress', source: hook, payload: { files: ['C:\\repo\\src\\a.ts', 'C:\\repo\\src\\b.ts'] } });
        recordEvent(db, { taskId: tracked.id, kind: 'commit', source: hook, payload: {} });
        recordEvent(db, { taskId: tracked.id, kind: 'pr', source: hook, payload: { url: 'https://github.com/acme/app/pull/7' } });
        const timeline = await call('timeline');
        expect(timeline).not.toContain('undefined');
        expect(timeline).toContain('edited 2 files: a.ts, b.ts');
        expect(timeline).toContain('committed');
        expect(timeline).toContain('PR https://github.com/acme/app/pull/7');
    });

    it('reads since as a duration or keyword and refuses what it cannot read (Review Focus 3)', async () => {
        task('Login fix');
        expect(await call('timeline', { since: '2d' })).toContain('Login fix');
        expect(await call('timeline', { since: 'yesterday' })).toContain('Login fix');
        const refused = await client.callTool({ name: 'timeline', arguments: { since: 'whenever' } }) as { isError?: boolean; content: { text: string }[] };
        expect(refused.isError).toBe(true);
        expect(refused.content[0].text).toContain(SINCE_HELP);
    });

    it('renders merged task ids in the timeline using the real id format', async () => {
        // formatTaskId(id) === `T${id}` today, so a plain string check can't tell a call
        // through formatTaskId apart from a hardcoded `T${id}` template. Replacing its
        // implementation makes the two observably different: only a real call picks up
        // the replaced prefix, so this fails if the merged case reverts to a literal.
        const formatSpy = jest.spyOn(ledgerTypes, 'formatTaskId').mockImplementation(id => `X${id}`);
        try {
            const duplicate = task('Dup');
            const kept = task('Kept');
            await call('merge_task', { from: `T${duplicate.id}`, into: `T${kept.id}` });
            const timeline = await call('timeline');
            expect(timeline).toContain(`merged into X${kept.id}`);
            expect(timeline).toContain(`absorbed X${duplicate.id}`);
        } finally {
            formatSpy.mockRestore();
        }
    });

    it('does not touch git branches when the setting is off', async () => {
        mockExecFile(null, '');
        await call('track_work', { title: 'No branch', intent: 'fix' });
        expect(child_process.execFile).not.toHaveBeenCalledWith('git', expect.arrayContaining(['checkout']), expect.anything(), expect.anything());
    });

    it('switches to an existing task/<id> branch when one is already checked out', async () => {
        setSetting(db, SETTING_CREATE_BRANCH, true);
        // rev-parse --verify succeeds for every ref, so ensureBranch takes the existing-branch path.
        mockExecFile(null, '');
        const result = await call('track_work', { title: 'With branch', intent: 'fix' });
        expect(result).toContain('Switched to existing branch task/T');
        expect(result).not.toContain('Created branch');
    });

    it('creates a new task/<id> branch when it does not exist yet', async () => {
        setSetting(db, SETTING_CREATE_BRANCH, true);
        mockExecFileByArgs(gitArgs => gitArgs.includes('--verify')
            ? { error: new Error('unknown revision') }
            : { error: null, stdout: '' });
        const result = await call('track_work', { title: 'With branch', intent: 'fix' });
        expect(result).toContain('Created branch task/T');
        expect(result).not.toContain('Switched to existing branch');
    });

    it("notes the owning workspace when a write touches another workspace's task", async () => {
        const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-other-'));
        try {
            const other = ensureWorkspace(db, otherDir);
            const forTrack = createTask(db, { title: 'Elsewhere A', phase: 'planned', workspaceId: other.id, origin: 'local', source: 'test' });
            const forUpdate = createTask(db, { title: 'Elsewhere B', phase: 'planned', workspaceId: other.id, origin: 'local', source: 'test' });
            const forMerge = createTask(db, { title: 'Elsewhere C', phase: 'planned', workspaceId: other.id, origin: 'local', source: 'test' });
            const localDup = task('Local dup');

            expect(await call('track_work', { title: 'poke', intent: 'fix', task_id: `T${forTrack.id}` })).toContain(other.path);
            expect(await call('update_task', { task_id: `T${forUpdate.id}`, comment: 'poke' })).toContain(other.path);
            expect(await call('merge_task', { from: `T${localDup.id}`, into: `T${forMerge.id}` })).toContain(other.path);

            // The merged-away task is a write too: a foreign `from` must be named even when `into` is local.
            const foreignDup = createTask(db, { title: 'Elsewhere D', phase: 'planned', workspaceId: other.id, origin: 'local', source: 'test' });
            const localKeep = task('Local keep');
            const merged = await call('merge_task', { from: `T${foreignDup.id}`, into: `T${localKeep.id}` });
            expect(merged).toContain(other.path);
            expect(merged).toContain(`T${foreignDup.id} belongs to workspace`);
        } finally {
            fs.rmSync(otherDir, { recursive: true, force: true });
        }
    });

    it('does not claim a phase change when only a comment is added', async () => {
        const existing = task('Login fix');
        const result = await call('update_task', { task_id: `T${existing.id}`, comment: 'note only' });
        expect(result).toContain('comment added');
        expect(result).not.toContain('phase');
    });
});

describe('mcp server in a GitHub workspace', () => {
    let ledger: TempLedger;
    let client: Client;

    const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
        const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[] };
        return result.content[0].text;
    };
    const trackedId = async (title: string): Promise<number> =>
        Number((await call('track_work', { title, intent: 'implement' })).match(/T(\d+)/)![1]);

    beforeEach(async () => {
        (child_process.execFile as unknown as jest.Mock).mockImplementation((...args: unknown[]) => {
            const cb = args[args.length - 1];
            if (typeof cb === 'function') (cb as (e: Error | null, out: string, err: string) => void)(new Error(GIT_FAILURE), '', '');
        });
        ledger = tempLedger();
        // The global default is off; these tests are about a workspace that opted in.
        setSetting(ledger.db, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);
        const repo = clonedRepo(ledger.dir, 'widgets');
        const server = new PmServer({ db: ledger.db, cwd: repo, sessionId: SESSION_ID, legacyImport: false });
        client = new Client({ name: 'test-client', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.run(serverTransport)]);
    });

    afterEach(async () => {
        await client.close();
        ledger.cleanup();
        jest.clearAllMocks();
    });

    it('queues a vendor create when track_work creates a task', async () => {
        const id = await trackedId('Login fix');
        expect(outboxRows(ledger.db, id).map(row => row.op)).toEqual(['create']);
    });

    it('publishes on request under promote, and says why when it cannot', async () => {
        setSetting(ledger.db, SETTING_SYNC_POLICY, SYNC_POLICY_PROMOTE);
        const quiet = await trackedId('Quiet until asked');
        expect(outboxRows(ledger.db, quiet)).toEqual([]);
        expect(await call('update_task', { task_id: `T${quiet}`, publish: true })).toBe(`T${quiet} updated: queued to publish.`);
        expect(outboxRows(ledger.db, quiet).map(row => row.op)).toEqual(['create']);

        setSetting(ledger.db, SETTING_SYNC_POLICY, SYNC_POLICY_LINKED_ONLY);
        const local = await trackedId('Stays local');
        expect(await call('update_task', { task_id: `T${local}`, publish: true })).toContain('not published: sync_policy');
    });

    it('queues the comment that comes with a publish under promote (F13)', async () => {
        setSetting(ledger.db, SETTING_SYNC_POLICY, SYNC_POLICY_PROMOTE);
        const id = await trackedId('Quiet until asked');
        expect(await call('update_task', { task_id: `T${id}`, comment: 'Ready for review', publish: true }))
            .toBe(`T${id} updated: comment added, queued to publish.`);
        expect(outboxRows(ledger.db, id).map(row => [row.op, row.payload])).toEqual([
            ['create', null],
            ['comment', JSON.stringify({ text: 'Ready for review' })],
        ]);
    });

    it('says a publish waits on a failed create, and how to retry it, rather than that it is on its way (F13)', async () => {
        const id = await trackedId('Gave up');
        ledger.db.prepare("UPDATE outbox SET status = 'failed' WHERE task_id = ?").run(id);
        const answer = await call('update_task', { task_id: `T${id}`, publish: true });
        expect(answer).toContain('not published: its create failed');
        expect(answer).toContain('ghostpm sync');
        expect(answer).not.toContain('on its way');
    });

    it("reports this workspace's pending pushes and why sync is paused", async () => {
        await trackedId('Login fix');
        const workspaceId = ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'widgets')).id;
        setSyncPause(ledger.db, workspaceId, 'GitHub CLI is not logged in. Run `gh auth login`, then `ghostpm sync`.');
        expect(await call('get_project_state')).toContain(
            '**Sync:** 1 pending, 0 failed — paused: GitHub CLI is not logged in. Run `gh auth login`, then `ghostpm sync`.',
        );
    });

    it('says sync is off in a GitHub workspace whose sync_policy is off, and how to turn it on (ruling 4)', async () => {
        setSetting(ledger.db, SETTING_SYNC_POLICY, SYNC_POLICY_OFF);
        const workspacePath = ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'widgets')).path;
        expect(await call('get_project_state')).toContain(
            `**Sync:** off (sync_policy off; \`ghostpm config set sync_policy auto --workspace "${workspacePath}"\` turns it on)`,
        );
    });
});
