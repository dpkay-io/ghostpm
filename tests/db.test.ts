import { Db } from '../src/db';
import * as init from '../src/init';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

jest.mock('../src/init');

describe('db', () => {
    let tmpDir: string;
    let db: Db;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-db-test-'));
        (init.findGitRoot as jest.Mock).mockReturnValue(tmpDir);
        db = new Db(tmpDir);
    });

    afterEach(() => {
        db['db'].close(); // close connection
        fs.rmSync(tmpDir, { recursive: true, force: true });
        jest.clearAllMocks();
    });

    it('should throw if not in a git root', () => {
        (init.findGitRoot as jest.Mock).mockReturnValue(null);
        expect(() => new Db('/non/existent')).toThrow('Not a git repository. Cannot initialize database.');
    });

    describe('metadata', () => {
        it('should set and get metadata', () => {
            db.setMetadata('key1', 'value1');
            expect(db.getMetadata('key1')).toBe('value1');

            db.setMetadata('key1', 'value2'); // upsert
            expect(db.getMetadata('key1')).toBe('value2');

            expect(db.getMetadata('unknown')).toBeUndefined();
        });

        it('should delete metadata', () => {
            db.setMetadata('key1', 'value1');
            expect(db.getMetadata('key1')).toBe('value1');
            db.deleteMetadata('key1');
            expect(db.getMetadata('key1')).toBeUndefined();
        });
    });

    describe('tasks', () => {
        it('should upsert and get tasks', () => {
            const task = {
                id: '123',
                title: 'Test Task',
                state: 'open',
                assignee: 'john',
                body: 'body',
                comments: 'comments',
                updatedAt: '2023-01-01T00:00:00Z',
                labels: '["bug"]',
                milestone: 'Sprint 1',
                url: 'https://github.com/repo/issues/123',
            };

            db.upsertTask(task);

            const fetched = db.getTask('123');
            expect(fetched).toEqual(task);

            const allTasks = db.getTasks();
            expect(allTasks).toHaveLength(1);
            expect(allTasks[0]).toEqual(task);

            // Upsert again
            const updatedTask = { ...task, state: 'closed' };
            db.upsertTask(updatedTask);
            expect(db.getTask('123')?.state).toBe('closed');

            // clear cache
            db.clearCache();
            expect(db.getTasks()).toHaveLength(0);
        });

        it('should handle null optional fields', () => {
            const task = { id: '1', title: 'Minimal', state: 'open' };
            db.upsertTask(task);
            const fetched = db.getTask('1')!;
            expect(fetched.labels).toBeNull();
            expect(fetched.milestone).toBeNull();
            expect(fetched.url).toBeNull();
        });
    });

    describe('outbox', () => {
        it('should add, get, update, delete outbox items', () => {
            db.addOutboxItem({
                taskId: '123',
                action: 'updateTask',
                payload: '{}',
                status: 'pending'
            });
            
            const pending = db.getPendingOutboxItems();
            expect(pending).toHaveLength(1);
            expect(pending[0].taskId).toBe('123');
            
            const id = pending[0].id!;
            
            db.updateOutboxItemStatus(id, 'conflict', 'some error');
            expect(db.getPendingOutboxItems()).toHaveLength(0);
            
            const conflicted = db.getConflictedOutboxItems();
            expect(conflicted).toHaveLength(1);
            expect(conflicted[0].errorMsg).toBe('some error');
            
            const conflictByTask = db.getConflictedOutboxItemByTaskId('123');
            expect(conflictByTask).toBeDefined();
            
            db.deleteOutboxItem(id);
            expect(db.getConflictedOutboxItems()).toHaveLength(0);
        });
    });
});
