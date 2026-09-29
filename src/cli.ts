import { execFile, execFileSync, ExecFileException } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MAX_BUFFER = 10 * 1024 * 1024;
const IS_WINDOWS = process.platform === 'win32';
const WIN_EXECUTABLE_EXTS = new Set(['.exe', '.cmd', '.bat', '.com']);
const BATCH_EXTS = new Set(['.cmd', '.bat']);
/** An override ending in .js runs under this node: an argv-safe stand-in for a CLI on Windows. */
const NODE_SCRIPT_EXT = '.js';
const DEFAULT_COMSPEC = 'cmd.exe';
/** No AutoRun, no delayed expansion, strip the outer quotes, run. */
const CMD_SWITCHES = ['/d', '/v:off', '/s', '/c'];
/** What cmd.exe passes through untouched: no quotes, metacharacters, whitespace or leading @. */
const CMD_SAFE_TOKEN = /^[A-Za-z0-9_.:/-]+$/;
/** Characters cmd.exe acts on even inside double quotes. */
const UNSAFE_IN_QUOTES = /["%!\r\n]/;
const ARG_DIR_PREFIX = 'ghostpm-args-';
const argFile = (index: number): string => `arg${index}.txt`;
const AT_FILE_PREFIX = '@';
/** Commands that read `@<file>` as that file's contents (azure.cli.core does it for every command). */
const AT_FILE_COMMANDS: ReadonlySet<string> = new Set(['az']);
const NOT_FOUND_TEXT = /is not recognized as an internal or external command|The system cannot find the path specified/i;
const NOT_FOUND_CODE = 'ENOENT';
const LINE_BREAK = /\r?\n/;

/** Point GhostPM at one specific binary. Once set, PATH is never consulted for that command. */
export const COMMAND_OVERRIDE_ENV: { readonly [command: string]: string | undefined } = { gh: 'GHOSTPM_GH', az: 'GHOSTPM_AZ' };

/** Text GhostPM does not control (titles, bodies, comments, queries, names read from config). */
export interface FreeText { readonly freeText: string }
export type CliArg = string | FreeText;
export const freeText = (text: string): FreeText => ({ freeText: text });

export interface RunOptions { input?: string }
export type Runner = (command: string, args: CliArg[], options?: RunOptions) => Promise<string>;

export class CliError extends Error {
    constructor(
        message: string,
        readonly exitCode: number | null,
        readonly stderr: string,
        /** The executable could not be found at all. */
        readonly notFound: boolean,
        /** GhostPM refused to run it rather than let cmd.exe parse the arguments. */
        readonly refused: boolean,
    ) {
        super(message);
        this.name = 'CliError';
    }
}

const refuse = (message: string): CliError => new CliError(message, null, '', false, true);
const missing = (command: string, file: string): CliError => new CliError(`${command}: ${file} does not exist`, null, '', true, false);
const textOf = (arg: CliArg): string => (typeof arg === 'string' ? arg : arg.freeText);

const resolvedCommands = new Map<string, string>();

/** The override if set; else on Windows the first executable `where.exe` finds (cached once found). */
function resolveCommand(command: string): string {
    const envName = COMMAND_OVERRIDE_ENV[command];
    const override = envName === undefined ? undefined : process.env[envName];
    if (override) {
        if (!fs.existsSync(override)) throw missing(command, override);
        return override;
    }
    if (!IS_WINDOWS) return command;
    const cached = resolvedCommands.get(command);
    if (cached !== undefined) return cached;
    try {
        const lines = execFileSync('where.exe', [command], { encoding: 'utf8', windowsHide: true }).trim().split(LINE_BREAK);
        const resolved = lines.find(line => WIN_EXECUTABLE_EXTS.has(path.extname(line).toLowerCase())) || lines[0];
        resolvedCommands.set(command, resolved);
        return resolved;
    } catch {
        // Not on PATH (yet): let the spawn report it, and look again next time.
        return command;
    }
}

interface Invocation {
    file: string;
    args: string[];
    cwd?: string;
    verbatim: boolean;
    argDir: string | null;
}

/** Spec §8.9 and Appendix A S1: nothing GhostPM does not control is ever parsed by cmd.exe. */
function batchInvocation(command: string, resolved: string, args: CliArg[]): Invocation {
    if (UNSAFE_IN_QUOTES.test(resolved)) throw refuse(`${command} resolves to ${resolved}, a path cmd.exe would reinterpret`);
    const readsFiles = AT_FILE_COMMANDS.has(command);
    for (const arg of args) {
        if (typeof arg === 'string' && !CMD_SAFE_TOKEN.test(arg)) {
            throw refuse(`refusing to pass ${JSON.stringify(arg)} to ${command} through cmd.exe`);
        }
        if (typeof arg !== 'string' && !readsFiles) {
            throw refuse(`${command} resolves to the batch file ${resolved}, which cannot take text safely; point ${COMMAND_OVERRIDE_ENV[command] ?? 'it'} at an executable`);
        }
    }
    let argDir: string | null = null;
    const tokens: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (typeof arg === 'string') {
            tokens.push(arg);
            continue;
        }
        if (argDir === null) argDir = fs.mkdtempSync(path.join(os.tmpdir(), ARG_DIR_PREFIX));
        fs.writeFileSync(path.join(argDir, argFile(index)), arg.freeText, 'utf8');
        // Relative to the child's working directory, so no temp path reaches cmd.exe either.
        tokens.push(`${AT_FILE_PREFIX}${argFile(index)}`);
    }
    return {
        file: process.env.ComSpec || DEFAULT_COMSPEC,
        args: [...CMD_SWITCHES, `""${resolved}" ${tokens.join(' ')}"`],
        cwd: argDir ?? undefined,
        verbatim: true,
        argDir,
    };
}

function plan(command: string, args: CliArg[]): Invocation {
    const resolved = resolveCommand(command);
    const ext = path.extname(resolved).toLowerCase();
    if (ext === NODE_SCRIPT_EXT) {
        return { file: process.execPath, args: [resolved, ...args.map(textOf)], verbatim: false, argDir: null };
    }
    if (IS_WINDOWS && BATCH_EXTS.has(ext)) return batchInvocation(command, resolved, args);
    return { file: resolved, args: args.map(textOf), verbatim: false, argDir: null };
}

function toCliError(command: string, error: ExecFileException, stderr: string): CliError {
    const exitCode = typeof error.code === 'number' ? error.code : null;
    const notFound = error.code === NOT_FOUND_CODE || NOT_FOUND_TEXT.test(stderr);
    const detail = stderr.trim().split(LINE_BREAK)[0] || error.message;
    return new CliError(`${command} failed${exitCode === null ? '' : ` (exit ${exitCode})`}: ${detail}`, exitCode, stderr, notFound, false);
}

/** Runs a vendor CLI with no shell in between, except the guarded batch-file path above. */
export const runCli: Runner = (command, args, options = {}) => new Promise<string>((resolve, reject) => {
    let invocation: Invocation;
    try {
        invocation = plan(command, args);
    } catch (error) {
        reject(error);
        return;
    }
    const argDir = invocation.argDir;
    const child = execFile(invocation.file, invocation.args, {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        windowsVerbatimArguments: invocation.verbatim,
        cwd: invocation.cwd,
    }, (error, stdout, stderr) => {
        if (argDir !== null) fs.rmSync(argDir, { recursive: true, force: true });
        if (error) reject(toCliError(command, error, String(stderr)));
        else resolve(String(stdout).trim());
    });
    // A child that never started closes its pipe; the callback above reports why.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.input ?? '');
});
