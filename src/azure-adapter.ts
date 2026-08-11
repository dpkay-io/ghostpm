import { PmAdapter, Task } from './pm-adapter';
import { runCli } from './cli';

export class AzureAdapter implements PmAdapter {
    private static readonly LIST_WIQL = "SELECT [System.Id], [System.State], [System.Title], [System.AssignedTo], [System.ChangedDate], [System.Tags], [System.IterationPath] FROM workitems";

    async getTasks(filter?: string): Promise<Task[]> {
        const wiql = filter || AzureAdapter.LIST_WIQL;
        try {
            const output = await runCli('az', ['boards', 'query', '--wiql', wiql]);
            const result = JSON.parse(output || '[]');
            const items = Array.isArray(result) ? result : (result.items || []);

            return items.map((item: any) => {
                const fields = item.fields || {};
                return {
                    id: (item.id ?? fields['System.Id'])?.toString(),
                    title: fields['System.Title'] || 'Unknown',
                    state: fields['System.State']?.toLowerCase() || 'unknown',
                    assignee: fields['System.AssignedTo']?.uniqueName,
                    updatedAt: fields['System.ChangedDate'],
                    labels: fields['System.Tags'] || undefined,
                    milestone: fields['System.IterationPath'] || undefined,
                } as Task;
            });
        } catch (error) {
            console.error('Failed to query Azure boards:', error);
            return [];
        }
    }

    async getTask(taskId: string): Promise<Task> {
        const output = await runCli('az', ['boards', 'work-item', 'show', '--id', taskId]);
        if (!output) throw new Error(`No data returned for work item ${taskId}`);
        const item = JSON.parse(output);
        const fields = item.fields;

        return {
            id: item.id.toString(),
            title: fields['System.Title'],
            state: fields['System.State'].toLowerCase(),
            assignee: fields['System.AssignedTo']?.uniqueName,
            body: fields['System.Description'],
            comments: fields['System.History'],
            updatedAt: fields['System.ChangedDate'],
            labels: fields['System.Tags'],
            milestone: fields['System.IterationPath'],
            url: item._links?.html?.href,
        };
    }

    async updateTask(taskId: string, state?: string, comment?: string): Promise<void> {
        const args = ['boards', 'work-item', 'update', '--id', taskId];
        const fields: string[] = [];

        if (comment) fields.push(`System.History=${comment}`);
        if (state) args.push('--state', state);
        if (fields.length > 0) args.push('--fields', ...fields);

        if (state || comment) await runCli('az', args);
    }

    async getCurrentUser(): Promise<string> {
        const output = await runCli('az', ['account', 'show', '--query', 'user.name', '-o', 'tsv']);
        return output.trim();
    }
}
