import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function runCli(command: string, args: string[] = []): Promise<string> {
    try {
        const { stdout, stderr } = await execFileAsync(command, args, { maxBuffer: 1024 * 1024 * 10 });
        if (stderr) {
            console.warn(`[CLI Warn] ${stderr}`);
        }
        return stdout.trim();
    } catch (error) {
        console.error(`[CLI Error] Failed to execute: ${command} ${args.join(' ')}`, error);
        throw error;
    }
}
