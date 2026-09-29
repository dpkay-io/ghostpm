import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import child_process = require('child_process');
import osModule = require('os');
import { runCli, freeText, CliError, COMMAND_OVERRIDE_ENV } from '../src/cli';
import { removeTempDir } from './temp-dir';

const HOSTILE = 'a&b | "q" %PATH% ^ <x> (p)\nsecond line';
const HOSTILE_FRAGMENTS = ['&b', '"q"', '%PATH%', '^', '<x>', '(p)', 'second line'];
const NON_ASCII = 'Déjà vu — ✓ 日本 😀';
const BOM = '\uFEFF';
const AUTH_EXIT = 4;
const KNACK_ENCODING_ENV = 'GHOSTPM_TEST_KNACK_ENCODING';
const ANSI_ENCODING = 'latin1';
const LINGER_TEST_TIMEOUT_MS = 20000;
const TIMEOUT_MS = 300;
/** Longer than jest's own test timeout: a child that is not killed fails the test. */
const HANG_MS = 30000;
/** The child exits well before its timeout; the descendant it leaves behind holds the output pipes. */
const PARENT_EXIT_MS = 300;
const DESCENDANT_TIMEOUT_MS = 1500;
const TIMEOUT_SLACK_MS = 2000;
/** Long enough for cmd.exe to start node, which records its pid before hanging. */
const BATCH_TIMEOUT_MS = 3000;
const POLL_MS = 50;
const isAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};
const diesWithin = async (pid: number, ms: number): Promise<boolean> => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, POLL_MS))) {
        if (!isAlive(pid)) return true;
    }
    return !isAlive(pid);
};
const MSI_AZ_SCRIPT = '@IF EXIST "%~dp0\\..\\python.exe" (\r\n  SET AZ_INSTALLER=MSI\r\n  "%~dp0\\..\\python.exe" -IBm azure.cli %*\r\n)\r\n';
const itOnWindows = process.platform === 'win32' ? it : it.skip;

/** Prints what it received: argv (expanding @file the way az does) and stdin. */
const ECHO_SOURCE = `
const fs = require('fs');
const BOM = '\\uFEFF';
const load = (arg, encoding) => fs.readFileSync(arg.slice(1), encoding);
// az 2.85 expands @file twice and no further: azure.cli.core decodes utf-8-sig (dropping exactly one leading BOM), then knack
// re-expands a result that starts with @, in text mode (the ANSI code page on a launcher without -X utf8), keeping any BOM.
const corePass = arg => { if (!arg.startsWith('@')) return arg; const text = load(arg, 'utf8'); return text.startsWith(BOM) ? text.slice(BOM.length) : text; };
const knackPass = arg => arg.startsWith('@') ? load(arg, process.env.${KNACK_ENCODING_ENV} || 'utf8') : arg;
const args = process.argv.slice(2).map(arg => knackPass(corePass(arg)));
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
    if (args[0] === 'fail-auth') {
        process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\\n');
        process.exitCode = ${AUTH_EXIT};
        return;
    }
    process.stdout.write(JSON.stringify({ args, stdin }));
});
`;

interface Echoed { args: string[]; stdin: string }

describe('runCli', () => {
    let dir: string;
    let echo: string;
    const originalCwd = process.cwd();
    const saved = new Map<string, string | undefined>();

    const override = (command: string, file: string): void => {
        process.env[COMMAND_OVERRIDE_ENV[command]!] = file;
    };
    const echoed = async (command: string, args: Parameters<typeof runCli>[1], input?: string): Promise<Echoed> =>
        JSON.parse(await runCli(command, args, { input })) as Echoed;
    /** az's first pass drops one leading BOM: a user's own must survive, and `BOM@<file>` must never become a file read. */
    const expectLeadingBomIntact = async (): Promise<void> => {
        const secret = path.join(dir, 'secret-bom.txt');
        fs.writeFileSync(secret, 'SECRET CONTENT');
        for (const text of [`${BOM}@${secret}`, `${BOM}${NON_ASCII}`]) {
            expect((await echoed('az', ['--title', freeText(text)])).args).toEqual(['--title', text]);
        }
    };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-cli-'));
        echo = path.join(dir, 'echo.js');
        fs.writeFileSync(echo, ECHO_SOURCE);
        saved.set(KNACK_ENCODING_ENV, process.env[KNACK_ENCODING_ENV]);
        for (const command of Object.keys(COMMAND_OVERRIDE_ENV)) {
            const name = COMMAND_OVERRIDE_ENV[command]!;
            saved.set(name, process.env[name]);
        }
    });

    afterEach(() => {
        saved.forEach((value, name) => {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        });
        process.chdir(originalCwd);
        jest.restoreAllMocks();
        removeTempDir(dir);
    });

    it('hands free text to an executable as one argv entry, untouched', async () => {
        override('gh', echo);
        expect((await echoed('gh', ['issue', freeText(HOSTILE)])).args).toEqual(['issue', HOSTILE]);
    });

    it('writes input to stdin and closes it', async () => {
        override('gh', echo);
        expect((await echoed('gh', ['issue', 'comment', '--body-file', '-'], HOSTILE)).stdin).toBe(HOSTILE);
    });

    it('carries the exit code and stderr of a failing command', async () => {
        override('gh', echo);
        const error = await runCli('gh', ['fail-auth']).catch((e: unknown) => e) as CliError;
        expect(error).toBeInstanceOf(CliError);
        expect(error.exitCode).toBe(AUTH_EXIT);
        expect(error.stderr).toContain('gh auth login');
        expect(error.timedOut).toBe(false);
    });

    it('kills a command that outlives its timeout and says it timed out', async () => {
        const hang = path.join(dir, 'hang.js');
        fs.writeFileSync(hang, `setTimeout(() => process.stdout.write('late'), ${HANG_MS});`);
        override('gh', hang);
        const started = Date.now();
        const error = await runCli('gh', ['issue', 'list'], { timeoutMs: TIMEOUT_MS }).catch((e: unknown) => e) as CliError;
        expect(error).toBeInstanceOf(CliError);
        expect(error.timedOut).toBe(true);
        expect(error.message).toContain(`timed out after ${TIMEOUT_MS} ms`);
        expect(Date.now() - started).toBeLessThan(HANG_MS);
    });

    it('ends the call at its timeout even when the child exited and a descendant still holds its output', async () => {
        const pidFile = path.join(dir, 'grandchild-pid.txt');
        const grandchild = path.join(dir, 'grandchild.js');
        fs.writeFileSync(grandchild, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, ${HANG_MS});`);
        const parent = path.join(dir, 'exits-early.js');
        fs.writeFileSync(parent, `require('child_process').spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'inherit', detached: true }).unref();`
            + ` setTimeout(() => process.exit(0), ${PARENT_EXIT_MS});`);
        override('gh', parent);
        const started = Date.now();
        try {
            const error = await runCli('gh', ['issue', 'list'], { timeoutMs: DESCENDANT_TIMEOUT_MS }).catch((e: unknown) => e) as CliError;
            expect(error).toBeInstanceOf(CliError);
            expect(error.timedOut).toBe(true);
            expect(Date.now() - started).toBeLessThan(DESCENDANT_TIMEOUT_MS + TIMEOUT_SLACK_MS);
        } finally {
            if (fs.existsSync(pidFile)) try { process.kill(Number(fs.readFileSync(pidFile, 'utf8'))); } catch { /* already gone */ }
        }
    }, LINGER_TEST_TIMEOUT_MS);

    it('reports a missing override as not found instead of falling back to PATH', async () => {
        override('gh', path.join(dir, 'missing', 'gh.exe'));
        const error = await runCli('gh', ['--version']).catch((e: unknown) => e) as CliError;
        expect(error).toBeInstanceOf(CliError);
        expect(error.notFound).toBe(true);
    });

    it('passes az free text through an argument file, so a leading @ is never expanded from the value', async () => {
        override('az', echo);
        const secret = path.join(dir, 'secret.txt');
        fs.writeFileSync(secret, 'SECRET CONTENT');
        const result = await echoed('az', ['--title', freeText(`@${secret}`)]);
        expect(result.args).toEqual(['--title', `@${secret}`]);
    });

    it('round-trips non-ASCII free text and a literal @file text for az on an executable-style launcher (UTF-8 knack pass)', async () => {
        override('az', echo);
        expect((await echoed('az', ['--title', freeText(NON_ASCII)])).args).toEqual(['--title', NON_ASCII]);
        const secret = path.join(dir, 'secret-utf8.txt');
        fs.writeFileSync(secret, 'SECRET CONTENT');
        expect((await echoed('az', [freeText(`@${secret} ${NON_ASCII}`)])).args).toEqual([`@${secret} ${NON_ASCII}`]);
    });

    it('keeps a leading BOM and never loads BOM@<file> for az on an executable-style launcher (UTF-8 knack pass)', async () => {
        override('az', echo);
        await expectLeadingBomIntact();
    });

    it('refuses to run az free text when the temporary folder path contains "="', async () => {
        override('az', echo);
        const oddTemp = path.join(dir, 'tmp=eq');
        fs.mkdirSync(oddTemp);
        jest.spyOn(osModule, 'tmpdir').mockReturnValue(oddTemp);
        const error = await runCli('az', ['--title', freeText('x')]).catch((e: unknown) => e) as CliError;
        expect(error.refused).toBe(true);
    });

    it('refuses a plain az value that az would read as a file, on every path', async () => {
        override('az', echo);
        for (const plain of ['@notes.txt', 'System.History=@.env']) {
            const error = await runCli('az', ['--fields', plain]).catch((e: unknown) => e) as CliError;
            expect(error.refused).toBe(true);
        }
    });

    it('resolves a relative override once, against the working folder', async () => {
        process.chdir(dir);
        override('gh', 'echo.js');
        expect((await echoed('gh', ['x'])).args).toEqual(['x']);
        override('gh', 'nothing-here.js');
        const error = await runCli('gh', ['x']).catch((e: unknown) => e) as CliError;
        expect(error.notFound).toBe(true);
    });

    itOnWindows('looks commands up with System32 where.exe, never something planted in the working folder', async () => {
        const planted = 'ghostpm-planted-cmd';
        const marker = path.join(dir, 'ran.txt');
        fs.writeFileSync(path.join(dir, `${planted}.cmd`), `@echo x> "${marker}"\r\n`);
        process.chdir(dir);
        const looked = jest.spyOn(child_process, 'execFileSync');
        const error = await runCli(planted, []).catch((e: unknown) => e) as CliError;
        expect(error.notFound).toBe(true);
        expect(fs.existsSync(marker)).toBe(false);
        const systemDir = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
        expect(looked.mock.calls[0][0]).toBe(path.join(systemDir, 'where.exe'));
        expect((looked.mock.calls[0][2] as { cwd?: string }).cwd).toBe(systemDir);
    });

    itOnWindows('prints nothing of its own when a command cannot be found', () => {
        const script = "require('./dist/cli').runCli('ghostpm-surely-missing-cmd', []).then(() => process.exit(2), e => process.exit(e.notFound ? 0 : 3))";
        const result = child_process.spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
        expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    });

    describe('a batch file on Windows (az.cmd)', () => {
        beforeEach(() => {
            const fakeAz = path.join(dir, 'az.cmd');
            fs.writeFileSync(fakeAz, `@"${process.execPath}" "${echo}" %*\r\n`);
            override('az', fakeAz);
        });

        itOnWindows('never puts free text on the cmd.exe command line, yet az receives it intact', async () => {
            const spawned = jest.spyOn(child_process, 'execFile');
            const result = await echoed('az', ['boards', 'work-item', 'update', '--id', '42', '--title', freeText(HOSTILE)]);
            expect(result.args).toEqual(['boards', 'work-item', 'update', '--id', '42', '--title', HOSTILE]);
            const commandLine = (spawned.mock.calls[0][1] as string[]).join(' ');
            for (const fragment of HOSTILE_FRAGMENTS) expect(commandLine).not.toContain(fragment);
        });

        itOnWindows('round-trips non-ASCII text and literal @file text although the launcher reads the second pass as ANSI', async () => {
            process.env[KNACK_ENCODING_ENV] = ANSI_ENCODING;
            expect((await echoed('az', ['--title', freeText(NON_ASCII)])).args).toEqual(['--title', NON_ASCII]);
            const secret = path.join(dir, 'secret-ansi.txt');
            fs.writeFileSync(secret, 'SECRET CONTENT');
            expect((await echoed('az', [freeText(`@${secret}`)])).args).toEqual([`@${secret}`]);
        });

        itOnWindows('keeps a leading BOM and never loads BOM@<file> although the launcher reads the second pass as ANSI', async () => {
            process.env[KNACK_ENCODING_ENV] = ANSI_ENCODING;
            await expectLeadingBomIntact();
        });

        itOnWindows('refuses text that starts with @ and holds non-ASCII characters, which that launcher would garble', async () => {
            const spawned = jest.spyOn(child_process, 'execFile');
            const error = await runCli('az', [freeText(`@${NON_ASCII}`)]).catch((e: unknown) => e) as CliError;
            expect(error.refused).toBe(true);
            expect(spawned).not.toHaveBeenCalled();
        });

        itOnWindows('passes non-ASCII text through the argument file as UTF-8', async () => {
            expect((await echoed('az', ['--title', freeText(NON_ASCII)])).args).toEqual(['--title', NON_ASCII]);
        });

        itOnWindows('removes the argument files once the command has finished', async () => {
            const spawned = jest.spyOn(child_process, 'execFile');
            await runCli('az', ['--title', freeText(HOSTILE)]);
            const cwd = (spawned.mock.calls[0][2] as { cwd?: string }).cwd;
            expect(cwd).toBeDefined();
            expect(fs.existsSync(cwd!)).toBe(false);
        });

        itOnWindows('settles when a child that outlives the command keeps the argument folder busy', async () => {
            const lingerMs = 1500;
            const spawner = path.join(dir, 'spawner.js');
            fs.writeFileSync(spawner, `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${lingerMs})'], { detached: true, stdio: 'ignore' }).unref();`);
            const busyAz = path.join(dir, 'busy-az.cmd');
            fs.writeFileSync(busyAz, `@"${process.execPath}" "${spawner}" %*\r\n`);
            override('az', busyAz);
            const spawned = jest.spyOn(child_process, 'execFile');
            await expect(runCli('az', ['--title', freeText('x')])).resolves.toBe('');
            const argDir = (spawned.mock.calls[0][2] as { cwd: string }).cwd;
            await new Promise(resolve => setTimeout(resolve, lingerMs * 2));
            removeTempDir(argDir);
            expect(fs.existsSync(argDir)).toBe(false);
        }, LINGER_TEST_TIMEOUT_MS);

        itOnWindows("kills the whole tree on a timeout, so az.cmd's child cannot finish its work later", async () => {
            const pidFile = path.join(dir, 'child-pid.txt');
            const child = path.join(dir, 'hang-child.js');
            fs.writeFileSync(child, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, ${HANG_MS});`);
            const hangAz = path.join(dir, 'hang-az.cmd');
            fs.writeFileSync(hangAz, `@"${process.execPath}" "${child}" %*\r\n`);
            override('az', hangAz);
            const error = await runCli('az', ['version'], { timeoutMs: BATCH_TIMEOUT_MS }).catch((e: unknown) => e) as CliError;
            expect(error.timedOut).toBe(true);
            expect(await diesWithin(Number(fs.readFileSync(pidFile, 'utf8')), BATCH_TIMEOUT_MS)).toBe(true);
        }, LINGER_TEST_TIMEOUT_MS);

        itOnWindows('runs an override given as a relative path by its absolute path', async () => {
            process.chdir(dir);
            override('az', 'az.cmd');
            const spawned = jest.spyOn(child_process, 'execFile');
            await runCli('az', ['version']);
            expect(spawned.mock.calls[0][1]).toEqual(expect.arrayContaining([expect.stringContaining(`"${path.join(dir, 'az.cmd')}"`)]));
        });

        itOnWindows('refuses a plain argument cmd.exe would parse, without running anything', async () => {
            const spawned = jest.spyOn(child_process, 'execFile');
            const error = await runCli('az', ['--title', 'a&b']).catch((e: unknown) => e) as CliError;
            expect(error).toBeInstanceOf(CliError);
            expect(error.refused).toBe(true);
            expect(spawned).not.toHaveBeenCalled();
        });

        itOnWindows('runs an MSI layout through its own python.exe, without cmd.exe', async () => {
            const wbin = path.join(dir, 'msi', 'wbin');
            fs.mkdirSync(wbin, { recursive: true });
            const msiAz = path.join(wbin, 'az.cmd');
            const python = path.join(dir, 'msi', 'python.exe');
            fs.writeFileSync(msiAz, MSI_AZ_SCRIPT);
            fs.writeFileSync(python, '');
            override('az', msiAz);
            let atFileContent = '';
            const spawned = jest.spyOn(child_process, 'execFile').mockImplementation(((...call: any[]) => {
                atFileContent = fs.readFileSync(call[1].find((a: string) => a.startsWith('@')).slice(1), 'utf8');
                call[call.length - 1](null, 'ok', '');
                return { stdin: { on: () => undefined, end: () => undefined } };
            }) as any);
            expect(await runCli('az', ['boards', '--title', freeText(HOSTILE)])).toBe('ok');
            const [file, args, options] = spawned.mock.calls[0] as any[];
            expect(file).toBe(python);
            expect(args.slice(0, 5)).toEqual(['-X', 'utf8', '-IBm', 'azure.cli', 'boards']);
            expect(args[5]).toBe('--title');
            expect(path.isAbsolute(args[6].slice(1))).toBe(true);
            // az's first pass decodes utf-8-sig, so the file carries a BOM of its own for that pass to drop.
            expect(atFileContent).toBe(`${BOM}${HOSTILE}`);
            expect(options.env.AZ_INSTALLER).toBe('MSI');
            expect(options.windowsVerbatimArguments).toBe(false);
            expect(options.cwd).toBe(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'));
        });

        itOnWindows('does not treat a launcher that is not the MSI script as MSI, even next to a python.exe', async () => {
            const bin = path.join(dir, 'pip', 'Scripts');
            fs.mkdirSync(bin, { recursive: true });
            fs.writeFileSync(path.join(dir, 'pip', 'python.exe'), '');
            const pipAz = path.join(bin, 'az.bat');
            fs.writeFileSync(pipAz, '@"%~dp0..\\python.exe" -m azure.cli %*\r\n');
            override('az', pipAz);
            const spawned = jest.spyOn(child_process, 'execFile').mockImplementation(((...call: any[]) => {
                call[call.length - 1](null, '', '');
                return { stdin: { on: () => undefined, end: () => undefined } };
            }) as any);
            await runCli('az', ['version']);
            expect(path.basename(spawned.mock.calls[0][0]).toLowerCase()).toBe('cmd.exe');
        });

        itOnWindows('reports an unreadable az.cmd as a refusal, not a raw fs error', async () => {
            const wbin = path.join(dir, 'odd', 'wbin');
            fs.mkdirSync(path.join(wbin, 'az.cmd'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'odd', 'python.exe'), '');
            override('az', path.join(wbin, 'az.cmd'));
            const error = await runCli('az', ['version']).catch((e: unknown) => e) as CliError;
            expect(error).toBeInstanceOf(CliError);
            expect(error.refused).toBe(true);
        });

        itOnWindows('falls back to cmd.exe when there is no python.exe next to the batch file', async () => {
            const spawned = jest.spyOn(child_process, 'execFile');
            await runCli('az', ['version']);
            expect(path.basename(spawned.mock.calls[0][0]).toLowerCase()).toBe('cmd.exe');
        });

        itOnWindows('refuses free text for a batch file that cannot read it from a file', async () => {
            const fakeGh = path.join(dir, 'gh.cmd');
            fs.writeFileSync(fakeGh, `@"${process.execPath}" "${echo}" %*\r\n`);
            override('gh', fakeGh);
            const error = await runCli('gh', ['issue', 'create', '--title', freeText('x')]).catch((e: unknown) => e) as CliError;
            expect(error.refused).toBe(true);
        });
    });
});
