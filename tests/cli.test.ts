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

        itOnWindows('refuses a plain argument cmd.exe would parse, without running anything', async () => {
            const spawned = jest.spyOn(child_process, 'execFile');
            const error = await runCli('az', ['--title', 'a&b']).catch((e: unknown) => e) as CliError;
            expect(error).toBeInstanceOf(CliError);
            expect(error.refused).toBe(true);
            expect(spawned).not.toHaveBeenCalled();
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
