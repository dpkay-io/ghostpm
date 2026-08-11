export interface Task {
    id: string;
    title: string;
    state: string;
    assignee?: string;
    body?: string;
    comments?: string;
    updatedAt?: string;
    labels?: string;
    milestone?: string;
    url?: string;
}

export interface SprintInfo {
    name: string;
    state?: 'open' | 'closed' | 'active';
    startDate?: string;
    endDate?: string;
}

export interface ProjectState {
    vendor: string;
    currentUser: string | null;
    activeSprint: SprintInfo | null;
    lastSync: string | null;
    activeTask: string | null;
}

export interface PmAdapter {
    getTasks(filter?: string): Promise<Task[]>;
    getTask(taskId: string): Promise<Task>;
    updateTask(taskId: string, state?: string, comment?: string): Promise<void>;
    getCurrentUser(): Promise<string>;
}
