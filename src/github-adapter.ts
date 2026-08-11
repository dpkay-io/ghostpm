import { PmAdapter, Task } from './pm-adapter';
import { runCli } from './cli';

export class GitHubAdapter implements PmAdapter {
    private static readonly LIST_FIELDS = 'number,state,title,assignees,updatedAt,labels,milestone,url';
    private static readonly DETAIL_FIELDS = 'number,state,title,assignees,body,comments,updatedAt,labels,milestone,url';

    async getTasks(filter?: string): Promise<Task[]> {
        const args = ['issue', 'list', '--json', GitHubAdapter.LIST_FIELDS];
        if (filter) {
            args.push('--search', filter);
        }
        const output = await runCli('gh', args);
        return JSON.parse(output || '[]').map((issue: any) => this.mapToTask(issue));
    }

    async getTask(taskId: string): Promise<Task> {
        const output = await runCli('gh', ['issue', 'view', taskId, '--json', GitHubAdapter.DETAIL_FIELDS]);
        if (!output) throw new Error(`No data returned for issue ${taskId}`);
        return this.mapToTask(JSON.parse(output));
    }

    async updateTask(taskId: string, state?: string, comment?: string): Promise<void> {
        if (comment) {
            await runCli('gh', ['issue', 'comment', taskId, '--body', comment]);
        }
        if (state) {
            if (state === 'closed') {
                await runCli('gh', ['issue', 'close', taskId]);
            } else if (state === 'open') {
                await runCli('gh', ['issue', 'reopen', taskId]);
            } else {
                try {
                    await runCli('gh', ['label', 'create', state, '--force']);
                } catch { /* label may already exist */ }
                await runCli('gh', ['issue', 'edit', taskId, '--add-label', state]);
            }
        }
    }

    async getCurrentUser(): Promise<string> {
        const output = await runCli('gh', ['api', 'user', '--jq', '.login']);
        return output.trim();
    }

    private mapToTask(issue: any): Task {
        return {
            id: issue.number.toString(),
            title: issue.title,
            state: issue.state.toLowerCase(),
            assignee: issue.assignees?.[0]?.login,
            body: issue.body,
            comments: issue.comments?.map((c: any) => c.body).join('\n---\n'),
            updatedAt: issue.updatedAt,
            labels: issue.labels?.length ? JSON.stringify(issue.labels.map((l: any) => l.name)) : undefined,
            milestone: issue.milestone?.title,
            url: issue.url,
        };
    }
}
