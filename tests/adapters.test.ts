import { GitHubAdapter } from '../src/github-adapter';
import { AzureAdapter } from '../src/azure-adapter';
import { runCli } from '../src/cli';

jest.mock('../src/cli');

describe('Adapters', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('GitHubAdapter', () => {
        let adapter: GitHubAdapter;

        beforeEach(() => {
            adapter = new GitHubAdapter();
        });

        it('should fetch tasks without filter', async () => {
            (runCli as jest.Mock).mockResolvedValue(JSON.stringify([
                { number: 1, title: 'Task 1', state: 'OPEN', assignees: [{ login: 'john' }], updatedAt: '2023-01-01' }
            ]));
            const tasks = await adapter.getTasks();
            expect(runCli).toHaveBeenCalledWith('gh', ['issue', 'list', '--json', 'number,state,title,assignees,updatedAt']);
            expect(tasks).toHaveLength(1);
            expect(tasks[0]).toEqual({
                id: '1',
                title: 'Task 1',
                state: 'open',
                assignee: 'john',
                body: undefined,
                comments: undefined,
                updatedAt: '2023-01-01'
            });
        });

        it('should fetch tasks with filter', async () => {
            (runCli as jest.Mock).mockResolvedValue('[]');
            await adapter.getTasks('updated:>=2023-01-01');
            expect(runCli).toHaveBeenCalledWith('gh', ['issue', 'list', '--json', 'number,state,title,assignees,updatedAt', '--search', 'updated:>=2023-01-01']);
        });

        it('should get a single task', async () => {
            (runCli as jest.Mock).mockResolvedValue(JSON.stringify(
                { number: 1, title: 'Task 1', state: 'OPEN', body: 'some body', comments: [{body: 'comment1'}], updatedAt: '2023-01-01' }
            ));
            const task = await adapter.getTask('1');
            expect(runCli).toHaveBeenCalledWith('gh', ['issue', 'view', '1', '--json', 'number,state,title,assignees,body,comments,updatedAt']);
            expect(task.comments).toBe('comment1');
            expect(task.body).toBe('some body');
        });

        it('should update task comment and state', async () => {
            await adapter.updateTask('1', 'closed', 'closing note');
            expect(runCli).toHaveBeenCalledWith('gh', ['issue', 'comment', '1', '--body', 'closing note']);
            expect(runCli).toHaveBeenCalledWith('gh', ['issue', 'close', '1']);
        });

        it('should update task state to open', async () => {
            await adapter.updateTask('1', 'open');
            expect(runCli).toHaveBeenCalledWith('gh', ['issue', 'reopen', '1']);
        });

        it('should update task state to custom label', async () => {
            await adapter.updateTask('1', 'in_progress');
            expect(runCli).toHaveBeenCalledWith('gh', ['issue', 'edit', '1', '--add-label', 'in_progress']);
        });
    });

    describe('AzureAdapter', () => {
        let adapter: AzureAdapter;

        beforeEach(() => {
            adapter = new AzureAdapter();
        });

        it('should fetch tasks without filter', async () => {
            (runCli as jest.Mock).mockResolvedValue(JSON.stringify([
                { id: 1, fields: { 'System.Title': 'Task 1', 'System.State': 'Active', 'System.AssignedTo': { uniqueName: 'john' }, 'System.ChangedDate': '2023-01-01' } }
            ]));
            const tasks = await adapter.getTasks();
            expect(runCli).toHaveBeenCalledWith('az', ['boards', 'query', '--wiql', "SELECT [System.Id], [System.State], [System.Title], [System.AssignedTo], [System.ChangedDate] FROM workitems"]);
            expect(tasks).toHaveLength(1);
            expect(tasks[0]).toEqual({
                id: '1',
                title: 'Task 1',
                state: 'active',
                assignee: 'john',
                body: undefined,
                comments: undefined,
                updatedAt: '2023-01-01'
            });
        });

        it('should fetch tasks with filter', async () => {
            (runCli as jest.Mock).mockResolvedValue('[]');
            await adapter.getTasks("SELECT [System.Id] FROM workitems WHERE [System.Id] = 1");
            expect(runCli).toHaveBeenCalledWith('az', ['boards', 'query', '--wiql', "SELECT [System.Id] FROM workitems WHERE [System.Id] = 1"]);
        });

        it('should get a single task', async () => {
            (runCli as jest.Mock).mockResolvedValue(JSON.stringify(
                { id: 1, fields: { 'System.Title': 'Task 1', 'System.State': 'Active', 'System.Description': 'some body', 'System.History': 'comment1' } }
            ));
            const task = await adapter.getTask('1');
            expect(runCli).toHaveBeenCalledWith('az', ['boards', 'work-item', 'show', '--id', '1']);
            expect(task.body).toBe('some body');
            expect(task.comments).toBe('comment1');
        });

        it('should update task', async () => {
            await adapter.updateTask('1', 'Closed', 'closing note');
            expect(runCli).toHaveBeenCalledWith('az', ['boards', 'work-item', 'update', '--id', '1', '--state', 'Closed', '--fields', 'System.History=closing note']);
        });

        it('should update task state only', async () => {
            await adapter.updateTask('1', 'Closed');
            expect(runCli).toHaveBeenCalledWith('az', ['boards', 'work-item', 'update', '--id', '1', '--state', 'Closed']);
        });

        it('should update task comment only', async () => {
            await adapter.updateTask('1', undefined, 'closing note');
            expect(runCli).toHaveBeenCalledWith('az', ['boards', 'work-item', 'update', '--id', '1', '--fields', 'System.History=closing note']);
        });
    });
});
