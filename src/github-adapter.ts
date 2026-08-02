import { PmAdapter, Task } from './pm-adapter';
import { runCli } from './cli';

export class GitHubAdapter implements PmAdapter {
    async getTasks(filter?: string): Promise<Task[]> {
        let args = ['issue', 'list', '--json', 'number,state,title,assignees,updatedAt'];
        if (filter) {
            args.push('--search', filter);
        }
        const output = await runCli('gh', args);
        const issues = JSON.parse(output || '[]');
        return issues.map((issue: any) => this.mapToTask(issue));
    }

    async getTask(taskId: string): Promise<Task> {
        const args = ['issue', 'view', taskId, '--json', 'number,state,title,assignees,body,comments,updatedAt'];
        const output = await runCli('gh', args);
        const issue = JSON.parse(output);
        return this.mapToTask(issue);
    }

    async updateTask(taskId: string, state?: string, comment?: string): Promise<void> {
        if (comment) {
            await runCli('gh', ['issue', 'comment', taskId, '--body', comment]);
        }
        if (state) {
            // Mapping unified state to gh state. GH issues can be closed or open (or reopened).
            if (state === 'closed') {
                await runCli('gh', ['issue', 'close', taskId]);
            } else if (state === 'open') {
                await runCli('gh', ['issue', 'reopen', taskId]);
            } else {
                // If the state is a label (like in_progress), we would add the label.
                // Assuming state mapping is done via labels for now if not closed/open.
                await runCli('gh', ['issue', 'edit', taskId, '--add-label', state]);
            }
        }
    }

    private mapToTask(issue: any): Task {
        return {
            id: issue.number.toString(),
            title: issue.title,
            state: issue.state.toLowerCase(),
            assignee: issue.assignees && issue.assignees.length > 0 ? issue.assignees[0].login : undefined,
            body: issue.body,
            comments: issue.comments ? issue.comments.map((c: any) => c.body).join('\n---\n') : undefined,
            updatedAt: issue.updatedAt
        };
    }
}
