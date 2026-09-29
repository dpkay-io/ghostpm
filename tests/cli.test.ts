import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import child_process = require('child_process');
import { runCli, freeText, CliError, COMMAND_OVERRIDE_ENV } from '../src/cli';
import { removeTempDir } from './temp-dir';

const HOSTILE = 'a&b | "q" %PATH% ^ <x> (p)\nsecond line';
const HOSTILE_FRAGMENTS = ['&b', '"q"', '%PATH%', '^', '<x>', '(p)', 'second line'];
const NON_ASCII = 'Déjà vu — ✓ 日本 😀';
const AUTH_EXIT = 4;
const itOnWindows = process.platform === 'win32' ? it : it.skip;

/** Prints what it received: argv (expanding @file the way az does) and stdin. */
const ECHO_SOURCE = `
const fs = require('fs');
const args = process.argv.slice(2).map(arg => arg.startsWith('@') ? fs.readFileSync(arg.slice(1), 'utf8') : arg);
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

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-cli-'));
        echo = path.join(dir, 'echo.js');
        fs.writeFileSync(echo, ECHO_SOURCE);
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
    });

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
        const systemDir = path.join(process.env.SystemRoot || 'C:\Windows', 'System32');
        expect(looked.mock.calls[0][0]).toBe(path.join(systemDir, 'where.exe'));
        expect((looked.mock.calls[0][2] as { cwd?: string }).cwd).toBe(systemDir);
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
            fs.writeFileSync(busyAz, `@"${process.execPath}" "${spawner}" %*
`);
            override('az', busyAz);
            const spawned = jest.spyOn(child_process, 'execFile');
            await expect(runCli('az', ['--title', freeText('x')])).resolves.toBe('');
            const argDir = (spawned.mock.calls[0][2] as { cwd: string }).cwd;
            await new Promise(resolve => setTimeout(resolve, lingerMs * 2));
            removeTempDir(argDir);
        });

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
            fs.writeFileSync(msiAz, '@rem msi\r\n');
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
            expect(atFileContent).toBe(HOSTILE);
            expect(options.env.AZ_INSTALLER).toBe('MSI');
            expect(options.windowsVerbatimArguments).toBe(false);
            expect(options.cwd).toBeUndefined();
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
