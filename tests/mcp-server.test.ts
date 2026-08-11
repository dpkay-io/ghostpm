import { PmServer } from '../src/mcp-server';
import { Engine } from '../src/engine';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as child_process from 'child_process';

jest.mock('../src/engine');
jest.mock('child_process');

describe('mcp-server', () => {
    let pmServer: PmServer;
    let mockEngine: jest.Mocked<Engine>;
    let mockTool: jest.SpyInstance;
    let mockConnect: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        
        mockTool = jest.spyOn(McpServer.prototype, 'tool').mockImplementation(() => ({} as any));
        mockConnect = jest.spyOn(McpServer.prototype, 'connect').mockResolvedValue(undefined as any);

        mockEngine = new Engine() as jest.Mocked<Engine>;
        (Engine as unknown as jest.Mock).mockImplementation(() => mockEngine);

        pmServer = new PmServer();
    });

    afterEach(() => {
        mockTool.mockRestore();
        mockConnect.mockRestore();
    });

    it('should register tools', () => {
        expect(mockTool).toHaveBeenCalledWith('get_project_state', expect.any(String), expect.any(Object), expect.any(Function));
        expect(mockTool).toHaveBeenCalledWith('set_sprint', expect.any(String), expect.any(Object), expect.any(Function));
        expect(mockTool).toHaveBeenCalledWith('query_tasks', expect.any(String), expect.any(Object), expect.any(Function));
        expect(mockTool).toHaveBeenCalledWith('get_task', expect.any(String), expect.any(Object), expect.any(Function));
        expect(mockTool).toHaveBeenCalledWith('start_task', expect.any(String), expect.any(Object), expect.any(Function));
        expect(mockTool).toHaveBeenCalledWith('update_task', expect.any(String), expect.any(Object), expect.any(Function));
        expect(mockTool).toHaveBeenCalledWith('open_attachment', expect.any(String), expect.any(Object), expect.any(Function));
        expect(mockTool).toHaveBeenCalledWith('resolve_conflict', expect.any(String), expect.any(Object), expect.any(Function));
    });

    describe('query_tasks tool', () => {
        let toolHandler: Function;

        beforeEach(() => {
            const call = mockTool.mock.calls.find((c: any) => c[0] === 'query_tasks');
            toolHandler = call[3];
        });

        it('should format tasks as markdown table', async () => {
            const mockDb = {
                getTasks: jest.fn().mockReturnValue([
                    { id: '1', state: 'open', title: 'Task 1', assignee: 'john' }
                ])
            };
            const mockConfig = {
                views: { list_columns: ['id', 'state', 'title', 'assignee'] }
            };
            mockEngine.getDb.mockReturnValue(mockDb as any);
            mockEngine.getConfig.mockReturnValue(mockConfig as any);
            mockEngine.getProjectState.mockReturnValue({ vendor: 'github', currentUser: null, activeSprint: null, lastSync: null, activeTask: null });

            const result = await toolHandler({});

            expect(result.content[0].type).toBe('text');
            expect(result.content[0].text).toContain('| id | state | title | assignee |');
            expect(result.content[0].text).toContain('| 1 | open | Task 1 | john |');
        });

        it('should filter by active sprint', async () => {
            const mockDb = {
                getTasks: jest.fn().mockReturnValue([
                    { id: '1', state: 'open', title: 'Sprint task', assignee: 'john', milestone: 'Sprint 1' },
                    { id: '2', state: 'open', title: 'Other task', assignee: 'john', milestone: 'Sprint 2' },
                ])
            };
            mockEngine.getDb.mockReturnValue(mockDb as any);
            mockEngine.getConfig.mockReturnValue({ views: { list_columns: ['id', 'state', 'title'] } } as any);
            mockEngine.getProjectState.mockReturnValue({ vendor: 'github', currentUser: null, activeSprint: { name: 'Sprint 1' }, lastSync: null, activeTask: null });

            const result = await toolHandler({});

            expect(result.content[0].text).toContain('Sprint task');
            expect(result.content[0].text).not.toContain('Other task');
        });

        it('should show all tasks when sprint=all', async () => {
            const mockDb = {
                getTasks: jest.fn().mockReturnValue([
                    { id: '1', state: 'open', title: 'T1', milestone: 'Sprint 1' },
                    { id: '2', state: 'open', title: 'T2', milestone: 'Sprint 2' },
                ])
            };
            mockEngine.getDb.mockReturnValue(mockDb as any);
            mockEngine.getConfig.mockReturnValue({ views: { list_columns: ['id', 'title'] } } as any);
            mockEngine.getProjectState.mockReturnValue({ vendor: 'github', currentUser: null, activeSprint: { name: 'Sprint 1' }, lastSync: null, activeTask: null });

            const result = await toolHandler({ sprint: 'all' });

            expect(result.content[0].text).toContain('T1');
            expect(result.content[0].text).toContain('T2');
        });
    });

    describe('get_task tool', () => {
        let toolHandler: Function;

        beforeEach(() => {
            const call = mockTool.mock.calls.find((c: any) => c[0] === 'get_task');
            toolHandler = call[3];
        });

        it('should return task not found', async () => {
            mockEngine.getDb.mockReturnValue({ getTask: jest.fn().mockReturnValue(undefined) } as any);
            const result = await toolHandler({ task_id: '99' });
            expect(result.content[0].text).toBe('Task 99 not found.');
        });

        it('should return filtered task JSON', async () => {
            const mockTask = { id: '1', title: 'Task 1', body: 'body', extra: 'hide this' };
            mockEngine.getDb.mockReturnValue({ getTask: jest.fn().mockReturnValue(mockTask) } as any);
            mockEngine.getConfig.mockReturnValue({ views: { detail_fields: ['id', 'title'] } } as any);

            const result = await toolHandler({ task_id: '1' });
            const parsed = JSON.parse(result.content[0].text);
            expect(parsed.id).toBe('1');
            expect(parsed.title).toBe('Task 1');
            expect(parsed.extra).toBeUndefined();
        });
    });

    describe('start_task tool', () => {
        let toolHandler: Function;

        beforeEach(() => {
            const call = mockTool.mock.calls.find((c: any) => c[0] === 'start_task');
            toolHandler = call[3];
        });

        it('should queue update task and trigger git branch', async () => {
            mockEngine.getConfig.mockReturnValue({ workflow: { transitions: { start_task: 'in_progress' } } } as any);
            mockEngine.queueUpdateTask.mockResolvedValue(undefined);

            (child_process.execFile as unknown as jest.Mock).mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') cb(null, 'checked out', '');
            });

            const result = await toolHandler({ task_id: 'abc-123' });

            expect(mockEngine.queueUpdateTask).toHaveBeenCalledWith('abc-123', 'in_progress');
            expect(child_process.execFile).toHaveBeenCalledWith('git', ['checkout', '-b', 'task/abc-123'], expect.any(Function));
            expect(result.content[0].text).toContain('Checked out new branch: task/abc-123');
        });

        it('should handle git error gracefully', async () => {
            mockEngine.getConfig.mockReturnValue({ workflow: { transitions: { start_task: 'in_progress' } } } as any);
            mockEngine.queueUpdateTask.mockResolvedValue(undefined);

            (child_process.execFile as unknown as jest.Mock).mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') cb(new Error('git error'), '', '');
            });

            const result = await toolHandler({ task_id: '1' });
            expect(result.content[0].text).toContain('(Note: Failed to checkout git branch: git error)');
        });
    });

    describe('update_task tool', () => {
        let toolHandler: Function;

        beforeEach(() => {
            const call = mockTool.mock.calls.find((c: any) => c[0] === 'update_task');
            toolHandler = call[3];
        });

        it('should return error if no state and comment', async () => {
            const result = await toolHandler({ task_id: '1' });
            expect(result.content[0].text).toBe('Must provide state or comment to update task 1.');
        });

        it('should queue update task', async () => {
            mockEngine.queueUpdateTask.mockResolvedValue(undefined);
            const result = await toolHandler({ task_id: '1', state: 'closed', comment: 'done' });
            expect(mockEngine.queueUpdateTask).toHaveBeenCalledWith('1', 'closed', 'done');
            expect(result.content[0].text).toContain('update queued');
        });
    });

    describe('open_attachment tool', () => {
        let toolHandler: Function;
        const originalPlatform = process.platform;

        beforeEach(() => {
            const call = mockTool.mock.calls.find((c: any) => c[0] === 'open_attachment');
            toolHandler = call[3];
        });

        afterEach(() => {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
        });

        it('should open url on windows', async () => {
            Object.defineProperty(process, 'platform', { value: 'win32' });
            (child_process.execFile as unknown as jest.Mock).mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') cb(null, '', '');
            });

            const result = await toolHandler({ url: 'http://example.com' });

            expect(child_process.execFile).toHaveBeenCalledWith('cmd', ['/c', 'start', '', 'http://example.com'], expect.any(Function));
            expect(result.content[0].text).toBe('Attachment opened successfully in local browser.');
        });

        it('should open url on mac', async () => {
            Object.defineProperty(process, 'platform', { value: 'darwin' });
            (child_process.execFile as unknown as jest.Mock).mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') cb(null, '', '');
            });

            await toolHandler({ url: 'http://example.com' });
            expect(child_process.execFile).toHaveBeenCalledWith('open', ['http://example.com'], expect.any(Function));
        });

        it('should open url on linux', async () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            (child_process.execFile as unknown as jest.Mock).mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') cb(null, '', '');
            });

            await toolHandler({ url: 'http://example.com' });
            expect(child_process.execFile).toHaveBeenCalledWith('xdg-open', ['http://example.com'], expect.any(Function));
        });

        it('should handle error', async () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            (child_process.execFile as unknown as jest.Mock).mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') cb(new Error('xdg-open failed'), '', '');
            });

            const result = await toolHandler({ url: 'http://example.com' });
            expect(result.content[0].text).toBe('Failed to open attachment: xdg-open failed');
        });
    });

    describe('resolve_conflict tool', () => {
        let toolHandler: Function;

        beforeEach(() => {
            const call = mockTool.mock.calls.find((c: any) => c[0] === 'resolve_conflict');
            toolHandler = call[3];
        });

        it('should return error if no conflict found', async () => {
            mockEngine.getDb.mockReturnValue({ getConflictedOutboxItemByTaskId: jest.fn().mockReturnValue(undefined) } as any);
            const result = await toolHandler({ task_id: '1', winning_state: 'local' });
            expect(result.content[0].text).toBe('No conflicting outbox item found for task 1.');
        });

        it('should resolve local', async () => {
            mockEngine.getDb.mockReturnValue({ getConflictedOutboxItemByTaskId: jest.fn().mockReturnValue({ id: 99 }) } as any);
            const result = await toolHandler({ task_id: '1', winning_state: 'local' });
            expect(mockEngine.resolveConflict).toHaveBeenCalledWith(99, 'force_push');
            expect(result.content[0].text).toContain('forcing local changes');
        });

        it('should resolve remote', async () => {
            mockEngine.getDb.mockReturnValue({ getConflictedOutboxItemByTaskId: jest.fn().mockReturnValue({ id: 99 }) } as any);
            const result = await toolHandler({ task_id: '1', winning_state: 'remote' });
            expect(mockEngine.resolveConflict).toHaveBeenCalledWith(99, 'drop');
            expect(result.content[0].text).toContain('dropping local changes');
        });
    });

    describe('run', () => {
        it('should connect and start sync interval', async () => {
            jest.useFakeTimers();
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
            mockEngine.sync.mockResolvedValue(undefined);
            
            await pmServer.run();
            
            expect(mockConnect).toHaveBeenCalled();
            expect(mockEngine.sync).toHaveBeenCalledTimes(1); // initial sync
            
            jest.advanceTimersByTime(5 * 60 * 1000);
            expect(mockEngine.sync).toHaveBeenCalledTimes(2); // interval sync
            
            jest.useRealTimers();
            consoleErrorSpy.mockRestore();
        });
    });
});
