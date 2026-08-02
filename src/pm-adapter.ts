export interface Task {
    id: string;
    title: string;
    state: string;
    assignee?: string;
    body?: string;
    comments?: string;
    updatedAt?: string;
}

export interface PmAdapter {
    getTasks(filter?: string): Promise<Task[]>;
    getTask(taskId: string): Promise<Task>;
    updateTask(taskId: string, state?: string, comment?: string): Promise<void>;
}
