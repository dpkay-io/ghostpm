import { Engine } from '../src/engine';
import { Db } from '../src/db';
import * as config from '../src/config';
import { GitHubAdapter } from '../src/github-adapter';
import { AzureAdapter } from '../src/azure-adapter';

jest.mock('../src/db');
jest.mock('../src/config');
jest.mock('../src/github-adapter');
jest.mock('../src/azure-adapter');

describe('engine', () => {
    let engine: Engine;
    let mockDb: jest.Mocked<Db>;
    let mockGitHubAdapter: jest.Mocked<GitHubAdapter>;
    let mockAzureAdapter: jest.Mocked<AzureAdapter>;

    beforeEach(() => {
        (config.loadConfig as jest.Mock).mockReturnValue({
            vendor: 'github',
            workflow: { states: [], transitions: {} },
            views: { list_columns: [], detail_fields: [] },
            notifications: []
        });

        mockDb = new Db('') as jest.Mocked<Db>;
        (Db as jest.Mock).mockImplementation(() => mockDb);

        mockGitHubAdapter = new GitHubAdapter() as jest.Mocked<GitHubAdapter>;
        (GitHubAdapter as jest.Mock).mockImplementation(() => mockGitHubAdapter);

        mockAzureAdapter = new AzureAdapter() as jest.Mocked<AzureAdapter>;
        (AzureAdapter as jest.Mock).mockImplementation(() => mockAzureAdapter);
        
        jest.clearAllMocks(); // Clear the instantiations above so we can assert on Engine initialization
        engine = new Engine();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('initialization', () => {
        it('should initialize github adapter if vendor is github', () => {
            expect(GitHubAdapter).toHaveBeenCalled();
            expect(AzureAdapter).not.toHaveBeenCalled();
        });

        it('should initialize azure adapter if vendor is azure_devops', () => {
            jest.clearAllMocks();
            (config.loadConfig as jest.Mock).mockReturnValue({ vendor: 'azure_devops' });
            engine = new Engine();
            expect(AzureAdapter).toHaveBeenCalled();
            expect(GitHubAdapter).not.toHaveBeenCalled();
        });
    });

    describe('sync', () => {
        it('should skip if already syncing', async () => {
            mockDb.getPendingOutboxItems.mockReturnValue([]);
            mockGitHubAdapter.getTasks.mockResolvedValue([]);
            
            // force isSyncing to true
            (engine as any).isSyncing = true;
            await engine.sync();
            expect(mockGitHubAdapter.getTasks).not.toHaveBeenCalled();
        });

        it('should poll deltas and process outbox', async () => {
            mockDb.getMetadata.mockReturnValue(undefined); // no last sync
            mockGitHubAdapter.getTasks.mockResolvedValue([{ id: '1', title: 'Task 1', state: 'open' }]);
            mockGitHubAdapter.getTask.mockResolvedValue({ id: '1', title: 'Task 1', state: 'open' });
            
            mockDb.getPendingOutboxItems.mockReturnValue([
                { id: 1, taskId: '2', action: 'updateTask', payload: JSON.stringify({ state: 'closed', baseUpdatedAt: '2023-01-01T00:00:00Z' }), status: 'pending' }
            ]);
            mockGitHubAdapter.getTask.mockResolvedValueOnce({ id: '1', title: 'Task 1', state: 'open' }); // for pollDeltas
            mockGitHubAdapter.getTask.mockResolvedValueOnce({ id: '2', title: 'Task 2', state: 'open', updatedAt: '2023-01-01T00:00:00Z' }); // for conflict check
            mockGitHubAdapter.getTask.mockResolvedValueOnce({ id: '2', title: 'Task 2', state: 'closed' }); // for updating cache after mutate

            await engine.sync();

            // verify poll deltas
            expect(mockGitHubAdapter.getTasks).toHaveBeenCalledWith('');
            expect(mockDb.upsertTask).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
            expect(mockDb.setMetadata).toHaveBeenCalledWith('last_sync', expect.any(String));

            // verify outbox processing
            expect(mockGitHubAdapter.updateTask).toHaveBeenCalledWith('2', 'closed', undefined);
            expect(mockDb.deleteOutboxItem).toHaveBeenCalledWith(1);
        });

        it('should detect conflict in outbox processing', async () => {
            mockDb.getMetadata.mockReturnValue(undefined);
            mockGitHubAdapter.getTasks.mockResolvedValue([]);
            
            mockDb.getPendingOutboxItems.mockReturnValue([
                { id: 1, taskId: '2', action: 'updateTask', payload: JSON.stringify({ state: 'closed', baseUpdatedAt: '2023-01-01T00:00:00Z' }), status: 'pending' }
            ]);
            mockGitHubAdapter.getTask.mockResolvedValueOnce({ id: '2', title: 'Task 2', state: 'open', updatedAt: '2023-01-02T00:00:00Z' }); // newer timestamp!

            await engine.sync();

            expect(mockGitHubAdapter.updateTask).not.toHaveBeenCalled();
            expect(mockDb.updateOutboxItemStatus).toHaveBeenCalledWith(1, 'conflict', expect.any(String));
        });

        it('should handle outbox processing error gracefully', async () => {
            mockDb.getMetadata.mockReturnValue(undefined);
            mockGitHubAdapter.getTasks.mockResolvedValue([]);
            
            mockDb.getPendingOutboxItems.mockReturnValue([
                { id: 1, taskId: '2', action: 'updateTask', payload: JSON.stringify({ state: 'closed' }), status: 'pending' }
            ]);
            mockGitHubAdapter.getTask.mockResolvedValueOnce({ id: '2', title: 'Task 2', state: 'open' });
            mockGitHubAdapter.updateTask.mockRejectedValue(new Error('Network error'));

            await engine.sync();

            expect(mockDb.updateOutboxItemStatus).toHaveBeenCalledWith(1, 'failed', 'Network error');
        });
    });

    describe('queueUpdateTask', () => {
        it('should queue update and optimistically update cache', async () => {
            mockDb.getTask.mockReturnValue({ id: '1', title: 'Task 1', state: 'open' });
            
            // mock sync to avoid real sync logic running in background
            const syncSpy = jest.spyOn(engine, 'sync').mockResolvedValue(undefined);

            await engine.queueUpdateTask('1', 'closed', 'closing this');

            expect(mockDb.addOutboxItem).toHaveBeenCalledWith(expect.objectContaining({
                taskId: '1',
                action: 'updateTask',
                status: 'pending'
            }));
            
            expect(mockDb.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
                id: '1',
                state: 'closed',
                comments: 'closing this'
            }));

            expect(syncSpy).toHaveBeenCalled();
        });
    });

    describe('resolveConflict', () => {
        it('should drop outbox item', () => {
            engine.resolveConflict(1, 'drop');
            expect(mockDb.deleteOutboxItem).toHaveBeenCalledWith(1);
        });

        it('should force push and trigger sync', () => {
            const syncSpy = jest.spyOn(engine, 'sync').mockResolvedValue(undefined);
            engine.resolveConflict(1, 'force_push');
            expect(mockDb.updateOutboxItemStatus).toHaveBeenCalledWith(1, 'pending');
            expect(syncSpy).toHaveBeenCalled();
        });
    });
});
