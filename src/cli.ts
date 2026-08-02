import { execFile, execFileSync } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

import { ExecFileOptions } from 'child_process';

const execFileAsync: (cmd: string, args: string[], opts: ExecFileOptions & { encoding: string }) => Promise<{ stdout: string; stderr: string }> =
    promisify(execFile) as any;

const MAX_BUFFER = 1024 * 1024 * 10;
const IS_WINDOWS = process.platform === 'win32';
const WIN_EXECUTABLE_EXTS = new Set(['.exe', '.cmd', '.bat', '.com']);
const WIN_SHELL_META = /[ \t"&|<>^()]/;

const resolvedCommands = new Map<string, string>();

function resolveCommand(command: string): string {
    if (!IS_WINDOWS) return command;

    const cached = resolvedCommands.get(command);
    if (cached !== undefined) return cached;

    try {
        const result = execFileSync('where.exe', [command], { encoding: 'utf8' });
        const lines = result.trim().split(/\r?\n/);
        const resolved = lines.find(l => WIN_EXECUTABLE_EXTS.has(path.extname(l).toLowerCase())) || lines[0];
        resolvedCommands.set(command, resolved);
        return resolved;
    } catch {
        resolvedCommands.set(command, command);
        return command;
    }
}

function quoteWinArg(arg: string): string {
    if (!WIN_SHELL_META.test(arg)) return arg;
    return `"${arg.replace(/"/g, '\\"')}"`;
}

export async function runCli(command: string, args: string[] = []): Promise<string> {
    try {
        let cmd: string;
        let finalArgs: string[];
        const options: any = { maxBuffer: MAX_BUFFER, encoding: 'utf8' };

        const resolved = resolveCommand(command);
        const ext = path.extname(resolved).toLowerCase();

        if (IS_WINDOWS && (ext === '.cmd' || ext === '.bat')) {
            cmd = process.env.ComSpec || 'cmd.exe';
            const cmdLine = [quoteWinArg(resolved), ...args.map(quoteWinArg)].join(' ');
            finalArgs = ['/d', '/s', '/c', `"${cmdLine}"`];
            options.windowsVerbatimArguments = true;
        } else {
            cmd = resolved;
            finalArgs = args;
        }

        const { stdout, stderr } = await execFileAsync(cmd, finalArgs, options);
        if (stderr) {
            console.warn(`[CLI Warn] ${stderr}`);
        }
        return stdout.trim();
    } catch (error) {
        console.error(`[CLI Error] Failed to execute: ${command} ${args.join(' ')}`, error);
        throw error;
    }
}
