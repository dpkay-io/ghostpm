import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as child_process from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PmServer } from '../src/mcp-server';
import { Ledger, openLedger, LEDGER_FILE } from '../src/ledger/db';
import { ensureWorkspace } from '../src/ledger/workspaces';
import { createTask, updateTask, insertVendorLink, getTask, NewTask } from '../src/ledger/tasks';
import { setSetting, setWorkspaceSetting, SETTING_CREATE_BRANCH, SETTING_CURRENT_USER } from '../src/ledger/settings';

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
        fs.rmSync(dir, { recursive: true, force: true });
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

    it('opens an attachment through the platform command', async () => {
        mockExecFile(null);
        expect(await call('open_attachment', { url: 'https://example.invalid/x' })).toContain('opened');
        expect(child_process.execFile).toHaveBeenCalled();
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

    it('renders merged task ids in the timeline using the real id format', async () => {
        const duplicate = task('Dup');
        const kept = task('Kept');
        await call('merge_task', { from: `T${duplicate.id}`, into: `T${kept.id}` });
        const timeline = await call('timeline');
        expect(timeline).toContain(`merged into T${kept.id}`);
    });

    it('creates a git branch only when the setting is on', async () => {
        mockExecFile(null, '');
        await call('track_work', { title: 'No branch', intent: 'fix' });
        expect(child_process.execFile).not.toHaveBeenCalledWith('git', expect.arrayContaining(['checkout']), expect.anything(), expect.anything());
        setSetting(db, SETTING_CREATE_BRANCH, true);
        expect(await call('track_work', { title: 'With branch', intent: 'fix' })).toContain('branch task/T');
    });
});
