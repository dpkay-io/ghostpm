import { GitHubAdapter } from './github-adapter';
import { AzureAdapter } from './azure-adapter';

async function main() {
    const args = process.argv.slice(2);
    const adapterType = args[0] || 'github';

    console.log(`Testing ${adapterType} adapter...`);

    const adapter = adapterType === 'azure' ? new AzureAdapter() : new GitHubAdapter();

    try {
        console.log('Fetching tasks...');
        const tasks = await adapter.getTasks();
        console.log('Tasks:', JSON.stringify(tasks, null, 2));

        if (tasks.length > 0 && tasks[0]?.id) {
            console.log(`\nFetching task details for ${tasks[0].id}...`);
            const task = await adapter.getTask(tasks[0].id);
            console.log('Task Details:', JSON.stringify(task, null, 2));
        } else {
            console.log('\nNo tasks found to fetch details for.');
        }
    } catch (error: any) {
        if (error.stderr && error.stderr.includes('not a git repository')) {
            console.log('Skipping real fetch: Not currently in a git repository. To test fetching, run inside a valid git repo or pass -R <owner>/<repo> via gh args in the adapter.');
        } else {
            console.error('Error during testing:', error);
        }
    }
}

main();
