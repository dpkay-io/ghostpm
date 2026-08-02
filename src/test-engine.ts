import { Engine } from './engine';
import { Db } from './db';

async function main() {
    console.log('Initializing engine...');
    const engine = new Engine();
    
    console.log('Running sync (fetching deltas)...');
    await engine.sync();
    
    const db = new Db();
    const tasks = db.getTasks();
    console.log(`Cache has ${tasks.length} tasks.`);
    if (tasks.length > 0) {
        console.log('First task:', tasks[0]);
    }
    
    console.log('Queueing a task update (test)...');
    if (tasks.length > 0) {
        const testTaskId = tasks[0].id;
        await engine.queueUpdateTask(testTaskId, undefined, 'Test outbox comment');
        const pending = db.getPendingOutboxItems();
        console.log(`Pending outbox items: ${pending.length}`);
        console.log('First outbox item:', pending[0]);
    } else {
        console.log('No tasks to queue update for.');
    }
}

main().catch(console.error);
