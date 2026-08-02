import { Db, OutboxItem } from './db';
import { PmAdapter, Task } from './pm-adapter';
import { loadConfig, McpPmConfig } from './config';
import { GitHubAdapter } from './github-adapter';
import { AzureAdapter } from './azure-adapter';

export class Engine {
    private db: Db;
    private adapter: PmAdapter;
    private config: McpPmConfig;
    private isSyncing: boolean = false;

    public getDb(): Db { return this.db; }
    public getConfig(): McpPmConfig { return this.config; }

    constructor(currentPath: string = process.cwd()) {
        this.config = loadConfig(currentPath);
        this.db = new Db(currentPath);
        this.adapter = this.config.vendor === 'azure_devops' ? new AzureAdapter() : new GitHubAdapter();
    }

    public async sync() {
        if (this.isSyncing) return;
        this.isSyncing = true;
        try {
            await this.pollDeltas();
            await this.processOutbox();
        } finally {
            this.isSyncing = false;
        }
    }

    private async pollDeltas() {
        const lastSync = this.db.getMetadata('last_sync');
        let filter = '';

        if (lastSync) {
            if (this.config.vendor === 'github') {
                filter = `updated:>=${lastSync}`;
            } else if (this.config.vendor === 'azure_devops') {
                // Approximate wiql filter addition
                filter = `SELECT [System.Id], [System.State], [System.Title], [System.AssignedTo], [System.ChangedDate] FROM workitems WHERE [System.ChangedDate] >= '${lastSync}'`;
            }
        }

        const tasks = await this.adapter.getTasks(filter);
        const syncTime = new Date().toISOString();

        for (const task of tasks) {
            // Optional: fetch full task details to get body and comments if needed,
            // but usually list gives basic fields. For PM MCP, it's good to have it in cache.
            // For now, just upsert what we got from getTasks. 
            // In a real scenario we might call getTask(task.id) for full data if modified.
            const fullTask = await this.adapter.getTask(task.id);
            this.db.upsertTask(fullTask);
        }

        this.db.setMetadata('last_sync', syncTime);
    }

    private async processOutbox() {
        const pendingItems = this.db.getPendingOutboxItems();

        for (const item of pendingItems) {
            try {
                // Process Action
                const payload = JSON.parse(item.payload);

                // Conflict check
                const remoteTask = await this.adapter.getTask(item.taskId);
                
                if (payload.baseUpdatedAt && remoteTask.updatedAt) {
                    const baseTime = new Date(payload.baseUpdatedAt).getTime();
                    const remoteTime = new Date(remoteTask.updatedAt).getTime();
                    
                    // If remote task has been updated since we queued this action (base time)
                    if (remoteTime > baseTime) {
                        this.db.updateOutboxItemStatus(item.id!, 'conflict', 'Remote task was updated by someone else after this change was queued.');
                        continue;
                    }
                }

                if (item.action === 'updateTask') {
                    await this.adapter.updateTask(item.taskId, payload.state, payload.comment);
                    // Update cache with the latest after mutating
                    const updatedTask = await this.adapter.getTask(item.taskId);
                    this.db.upsertTask(updatedTask);
                }

                // Delete or mark success
                this.db.deleteOutboxItem(item.id!);
            } catch (error: any) {
                this.db.updateOutboxItemStatus(item.id!, 'failed', error.message || 'Unknown error');
            }
        }
    }

    public async queueUpdateTask(taskId: string, state?: string, comment?: string) {
        const task = this.db.getTask(taskId);
        
        this.db.addOutboxItem({
            taskId,
            action: 'updateTask',
            payload: JSON.stringify({ state, comment, baseUpdatedAt: task?.updatedAt }),
            status: 'pending'
        });
        
        // Optimistic update of local cache
        if (task) {
            if (state) task.state = state;
            if (comment) task.comments = task.comments ? task.comments + '\n---\n' + comment : comment;
            this.db.upsertTask(task);
        }

        // Trigger background sync
        this.sync().catch(e => console.error('Background sync failed', e));
    }

    public resolveConflict(outboxId: number, strategy: 'force_push' | 'drop') {
        if (strategy === 'drop') {
            this.db.deleteOutboxItem(outboxId);
        } else {
            this.db.updateOutboxItemStatus(outboxId, 'pending');
            // Re-run sync to attempt push again
            this.sync().catch(e => console.error('Background sync failed', e));
        }
    }
}
