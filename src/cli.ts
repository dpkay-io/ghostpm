import { ChildProcess, execFile, execFileSync, ExecFileException } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MAX_BUFFER = 10 * 1024 * 1024;
const IS_WINDOWS = process.platform === 'win32';
const WIN_EXECUTABLE_EXTS = new Set(['.exe', '.cmd', '.bat', '.com']);
const BATCH_EXTS = new Set(['.cmd', '.bat']);
/** An override ending in .js runs under this node: an argv-safe stand-in for a CLI on Windows. */
const NODE_SCRIPT_EXT = '.js';
const SYSTEM32_SEGMENTS = ['System32'];
const DEFAULT_SYSTEM_ROOT = 'C:\\Windows';
/** Windows tools are run by absolute path from System32: a copy planted in the working folder must never win. */
const systemTool = (name: string): string => path.join(process.env.SystemRoot || DEFAULT_SYSTEM_ROOT, ...SYSTEM32_SEGMENTS, name);
const systemDir = (): string => path.dirname(systemTool('where.exe'));
/** taskkill: the process tree (/T), forcibly (/F); the pid follows. */
const TASKKILL_TREE = ['/T', '/F', '/PID'];
/** No AutoRun, no delayed expansion, strip the outer quotes, run. */
const CMD_SWITCHES = ['/d', '/v:off', '/s', '/c'];
/** What cmd.exe passes through untouched: no quotes, metacharacters, whitespace or leading @. */
const CMD_SAFE_TOKEN = /^[A-Za-z0-9_.:/-]+$/;
/** Characters cmd.exe acts on even inside double quotes. */
const UNSAFE_IN_QUOTES = /["%!\r\n]/;
const ARG_DIR_PREFIX = 'ghostpm-args-';
const argFile = (index: number): string => `arg${index}.txt`;
const AT_FILE_PREFIX = '@';
/** az's first pass decodes utf-8-sig and drops one leading U+FEFF; every file it reads starts with this one for it to drop. */
const FIRST_PASS_BOM = '\uFEFF';
const ARG_PATH_SPLIT = '=';
const MAX_ASCII_CODE = 0x7f;
const hasNonAscii = (text: string): boolean => Array.from(text).some(char => char.charCodeAt(0) > MAX_ASCII_CODE);
/** A plain (non-free-text) az value that az would read as a file: leading @, or `name=@file` (az splits on = and expands the value). */
const AT_FILE_VALUE = /^@|=@/;
const pointerFile = (index: number): string => `arg${index}.ref.txt`;
/** An MSI az.cmd is `"%~dp0..python.exe" -IBm azure.cli %*` with AZ_INSTALLER=MSI; -X utf8 makes stdout UTF-8 instead of the ANSI code page. */
const MSI_PYTHON_RELATIVE = ['..', 'python.exe'];
const MSI_PYTHON_ARGS = ['-X', 'utf8', '-IBm', 'azure.cli'];
const MSI_COMMAND = 'az';
/** What the MSI az.cmd contains; anything else next to a python.exe (a pip az.bat, say) is not the MSI launcher. */
const MSI_SCRIPT_MARKERS = [/SET\s+AZ_INSTALLER=MSI/i, /-IBm\s+azure\.cli/i];
const MSI_ENV = { AZ_INSTALLER: 'MSI' };
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

export interface RunOptions {
    input?: string;
    /** Kill the command once it has run this long; the call then rejects with a CliError marked timedOut. */
    timeoutMs?: number;
}
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
        /** Killed for running past RunOptions.timeoutMs. */
        readonly timedOut: boolean = false,
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
        // Resolved now, so cmd.exe cannot search PATH or its own cwd for a relative override.
        const absolute = path.resolve(override);
        if (!fs.existsSync(absolute)) throw missing(command, absolute);
        return absolute;
    }
    if (!IS_WINDOWS) return command;
    const cached = resolvedCommands.get(command);
    if (cached !== undefined) return cached;
    try {
        const lines = execFileSync(systemTool('where.exe'), [command], { encoding: 'utf8', windowsHide: true, cwd: systemDir(), stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(LINE_BREAK);
        const resolved = lines.find(line => WIN_EXECUTABLE_EXTS.has(path.extname(line).toLowerCase())) || lines[0];
        resolvedCommands.set(command, resolved);
        return resolved;
    } catch {
        // Not on PATH (yet): look again next time. Never fall back to the bare name.
        throw new CliError(`${command} was not found on PATH`, null, '', true, false);
    }
}

interface Invocation {
    file: string;
    args: string[];
    cwd?: string;
    verbatim: boolean;
    env?: NodeJS.ProcessEnv;
    argDir: string | null;
}

/**
 * az 2.85 expands `@<file>` in two passes: azure.cli.core reads the argv value as utf-8-sig, then knack expands the result
 * again when it starts with @ (text mode, so the ANSI code page unless python runs with -X utf8; a third level stays literal,
 * verified offline). Free text that does not start with @ is therefore one file, `@B`. Text that does start with @ goes
 * through a pointer: argv `@A`, file A holds `@B`, so the text is never at the start of an expanded value; on a launcher
 * without -X utf8 (`utf8Second` false) that second pass would garble non-ASCII, so such text is refused.
 * utf-8-sig drops one leading U+FEFF, which would turn text `\uFEFF@<path>` into `@<path>` for knack to load: every file the
 * first pass reads (B alone, or A) is written with a BOM of its own, so that pass returns the content exactly and the level
 * decision sees what knack sees. B behind a pointer is read by knack as plain utf-8/ANSI, which keeps a BOM, so it has none.
 * `ref(name, dir)` renders a file path.
 */
function writeArgFiles(args: CliArg[], ref: (name: string, dir: string) => string, utf8Second: boolean): { tokens: string[]; argDir: string | null } {
    const texts = args.filter((arg): arg is FreeText => typeof arg !== 'string').map(arg => arg.freeText);
    if (texts.length > 0 && os.tmpdir().includes(ARG_PATH_SPLIT)) {
        throw refuse(`the temporary folder ${os.tmpdir()} contains "${ARG_PATH_SPLIT}", which az would split an argument file path on`);
    }
    const lossy = utf8Second ? undefined : texts.find(text => text.startsWith(AT_FILE_PREFIX) && hasNonAscii(text));
    if (lossy !== undefined) throw refuse(`refusing to pass ${JSON.stringify(lossy)} through this az launcher: text starting with @ and holding non-ASCII characters would be garbled`);
    let argDir: string | null = null;
    const tokens: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (typeof arg === 'string') {
            tokens.push(arg);
            continue;
        }
        if (argDir === null) argDir = fs.mkdtempSync(path.join(os.tmpdir(), ARG_DIR_PREFIX));
        if (!arg.freeText.startsWith(AT_FILE_PREFIX)) {
            fs.writeFileSync(path.join(argDir, argFile(index)), `${FIRST_PASS_BOM}${arg.freeText}`, 'utf8');
            tokens.push(`${AT_FILE_PREFIX}${ref(argFile(index), argDir)}`);
            continue;
        }
        fs.writeFileSync(path.join(argDir, argFile(index)), arg.freeText, 'utf8');
        fs.writeFileSync(path.join(argDir, pointerFile(index)), `${FIRST_PASS_BOM}${AT_FILE_PREFIX}${ref(argFile(index), argDir)}`, 'utf8');
        tokens.push(`${AT_FILE_PREFIX}${ref(pointerFile(index), argDir)}`);
    }
    return { tokens, argDir };
}

/** Free text for az travels through argument files on every path; other commands get it as plain argv. */
function atFileInvocation(file: string, prefix: string[], command: string, args: CliArg[], extra: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Invocation {
    const { tokens, argDir } = writeArgFiles(
        AT_FILE_COMMANDS.has(command) ? args : args.map(textOf),
        (name, dir) => path.join(dir, name),
        true,
    );
    // Without a cwd of its own, a child that inherits it (az's telemetry uploader) must not hold the argument folder.
    return { file, args: [...prefix, ...tokens], verbatim: false, argDir, ...extra };
}

/** The MSI az.cmd's own python.exe, when this az.cmd sits in an MSI layout. */
function msiPython(resolved: string): string | undefined {
    const python = path.resolve(path.dirname(resolved), ...MSI_PYTHON_RELATIVE);
    if (!fs.existsSync(python)) return undefined;
    let script: string;
    try {
        script = fs.readFileSync(resolved, 'utf8');
    } catch (error) {
        throw refuse(`cannot read ${resolved}: ${(error as Error).message}`);
    }
    return MSI_SCRIPT_MARKERS.every(marker => marker.test(script)) ? python : undefined;
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
    // Relative to the child's working directory, so no temp path reaches cmd.exe either.
    const { tokens, argDir } = writeArgFiles(args, name => name, false);
    return {
        file: process.env.ComSpec || systemTool('cmd.exe'),
        args: [...CMD_SWITCHES, `""${resolved}" ${tokens.join(' ')}"`],
        cwd: argDir ?? undefined,
        verbatim: true,
        argDir,
    };
}

function plan(command: string, args: CliArg[]): Invocation {
    if (AT_FILE_COMMANDS.has(command)) {
        const plain = args.find(arg => typeof arg === 'string' && AT_FILE_VALUE.test(arg));
        if (plain !== undefined) throw refuse(`refusing to pass ${JSON.stringify(plain)} to ${command}: it would be read as a file`);
    }
    const resolved = resolveCommand(command);
    const ext = path.extname(resolved).toLowerCase();
    if (ext === NODE_SCRIPT_EXT) return atFileInvocation(process.execPath, [resolved], command, args);
    if (IS_WINDOWS && BATCH_EXTS.has(ext)) {
        const python = command === MSI_COMMAND ? msiPython(resolved) : undefined;
        if (python !== undefined) return atFileInvocation(python, MSI_PYTHON_ARGS, command, args, { cwd: systemDir(), env: { ...process.env, ...MSI_ENV } });
        return batchInvocation(command, resolved, args);
    }
    return atFileInvocation(resolved, [], command, args);
}

/** Ends the child and stops waiting on pipes a grandchild of it may still hold. */
function abandon(child: ChildProcess): void {
    child.kill();
    child.stdout?.destroy();
    child.stderr?.destroy();
}

/** On Windows the whole tree: killing cmd.exe alone leaves az.cmd's python running, free to finish a create after the retry. */
function killTree(child: ChildProcess): void {
    if (child.exitCode !== null || child.pid === undefined) return;
    if (!IS_WINDOWS) {
        abandon(child);
        return;
    }
    execFile(systemTool('taskkill.exe'), [...TASKKILL_TREE, String(child.pid)], { windowsHide: true, cwd: systemDir() }, error => {
        if (error) abandon(child);
    });
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
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const child = execFile(invocation.file, invocation.args, {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        windowsVerbatimArguments: invocation.verbatim,
        cwd: invocation.cwd,
        env: invocation.env,
    }, (error, stdout, stderr) => {
        if (timer !== undefined) clearTimeout(timer);
        // Best effort: a process that inherited the folder as its cwd can keep it busy on Windows.
        if (argDir !== null) try { fs.rmSync(argDir, { recursive: true, force: true }); } catch { /* left behind */ }
        if (error && timedOut) reject(new CliError(`${command} timed out after ${options.timeoutMs} ms`, null, String(stderr), false, false, true));
        else if (error) reject(toCliError(command, error, String(stderr)));
        else resolve(String(stdout).trim());
    });
    if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
            timedOut = true;
            killTree(child);
        }, options.timeoutMs);
    }
    // A child that never started closes its pipe; the callback above reports why.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.input ?? '');
});
