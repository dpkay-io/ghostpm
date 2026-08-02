import { PmAdapter, Task } from './pm-adapter';
import { runCli } from './cli';

export class AzureAdapter implements PmAdapter {
    async getTasks(filter?: string): Promise<Task[]> {
        // Warning: Simplified query. Real implementation might need proper WIQL construction.
        const wiql = filter ? filter : "SELECT [System.Id], [System.State], [System.Title], [System.AssignedTo], [System.ChangedDate] FROM workitems";
        const args = ['boards', 'query', '--wiql', wiql];
        
        try {
            const output = await runCli('az', args);
            // az boards query returns an array or an object depending on the results and CLI version.
            const result = JSON.parse(output || '[]');
            const items = Array.isArray(result) ? result : (result.items || []);
            
            return Promise.all(items.map(async (item: any) => {
                // To get full details, we often need to fetch the work item directly
                // but we try to map from query results first if fields are present.
                const fields = item.fields || {};
                return {
                    id: item.id?.toString() || fields['System.Id']?.toString(),
                    title: fields['System.Title'] || 'Unknown',
                    state: fields['System.State']?.toLowerCase() || 'unknown',
                    assignee: fields['System.AssignedTo']?.uniqueName || undefined,
                    updatedAt: fields['System.ChangedDate'] || undefined
                };
            }));
        } catch (error) {
            console.error('Failed to query Azure boards:', error);
            return [];
        }
    }

    async getTask(taskId: string): Promise<Task> {
        const args = ['boards', 'work-item', 'show', '--id', taskId];
        const output = await runCli('az', args);
        if (!output) throw new Error(`No data returned for work item ${taskId}`);
        const item = JSON.parse(output);
        const fields = item.fields;
        
        return {
            id: item.id.toString(),
            title: fields['System.Title'],
            state: fields['System.State'].toLowerCase(),
            assignee: fields['System.AssignedTo']?.uniqueName || undefined,
            body: fields['System.Description'],
            // Comments in Azure DevOps are fetched differently (from history/discussion),
            // but for phase 1 we can leave it empty or map from history if available in `show`.
            comments: fields['System.History'] || undefined,
            updatedAt: fields['System.ChangedDate'] || undefined
        };
    }

    async updateTask(taskId: string, state?: string, comment?: string): Promise<void> {
        const args = ['boards', 'work-item', 'update', '--id', taskId];
        const fields: string[] = [];

        if (comment) {
            fields.push(`System.History=${comment}`);
        }
        if (state) {
            args.push('--state', state);
        }

        if (fields.length > 0) {
            args.push('--fields', ...fields);
        }

        if (state || comment) {
            await runCli('az', args);
        }
    }
}
