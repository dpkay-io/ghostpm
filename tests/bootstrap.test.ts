import * as fs from 'fs';
import nodeFs = require('fs');
import * as os from 'os';
import * as path from 'path';
import { execFileSync, execSync, spawnSync } from 'child_process';
import {
    BUILD_DIR, NpmRunner, SAFE_NPM_ARG, assertSafeNpmArgs, bootstrapBinding, installedAddonVersion, npmInstallArgs, runNpm,
} from '../src/bootstrap';
import { IS_WINDOWS, resolveCommand } from '../src/cli';
import { BINDING_FILE, bootstrappedBindingPath } from '../src/ledger/binding';
import { minimumNodeMajor } from '../src/package-info';
import { removeTempDir } from './temp-dir';

// Never run the real npm: the default runner's call is recorded instead, and npm is never looked up on PATH.
jest.mock('child_process');
jest.mock('../src/cli', () => ({ ...jest.requireActual('../src/cli'), resolveCommand: jest.fn() }));

/** Where.exe's answer on a typical install: a space the command line must quote. */
const NPM_PATH = 'C:\\Program Files\\nodejs\\npm.cmd';
const itOnWindows = IS_WINDOWS ? it : it.skip;

const INSTALLED = (JSON.parse(fs.readFileSync(require.resolve('better-sqlite3/package.json'), 'utf8')) as { version: string }).version;
/** Every character that has bitten a Windows home path through cmd.exe. */
const HOSTILE_FOLDER = 'John Smith & Co (100%) ^x';

interface NpmCall {
    args: string[];
    cwd: string;
}

/** Stands in for npm: records the call and leaves an addon where a real install would. */
function fakeNpm(calls: NpmCall[]): NpmRunner {
    return (args, cwd) => {
        calls.push({ args, cwd });
        const built = path.join(cwd, 'node_modules', 'better-sqlite3', 'build', 'Release', BINDING_FILE);
        fs.mkdirSync(path.dirname(built), { recursive: true });
        fs.writeFileSync(built, 'addon');
    };
}

describe('bootstrap', () => {
    let root: string;
    let home: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-boot-'));
        home = path.join(root, HOSTILE_FOLDER, '.ghostpm');
        jest.mocked(resolveCommand).mockReturnValue(NPM_PATH);
    });

    afterEach(() => {
        removeTempDir(root);
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    it('builds the exact installed better-sqlite3 and copies the addon into the home', () => {
        const calls: NpmCall[] = [];

        const target = bootstrapBinding(fakeNpm(calls), home);

        expect(INSTALLED).toBe(installedAddonVersion());
        expect(calls[0].args).toContain(`better-sqlite3@${INSTALLED}`);
        expect(target).toBe(bootstrappedBindingPath(home));
        expect(fs.readFileSync(target, 'utf8')).toBe('addon');
    });

    it('passes the home only as the working directory, never as an argument (gap N4)', () => {
        const calls: NpmCall[] = [];

        bootstrapBinding(fakeNpm(calls), home);

        expect(calls[0].cwd).toBe(path.join(home, BUILD_DIR));
        expect(calls[0].args.join(' ')).not.toContain(HOSTILE_FOLDER);
        calls[0].args.forEach(arg => expect(arg).toMatch(SAFE_NPM_ARG));
    });

    it('lets npm 12 run better-sqlite3\'s install script, and only that exact version\'s: a pinned allowScripts entry in the build folder\'s own package.json', () => {
        const manifests: unknown[] = [];
        const record = fakeNpm([]);

        bootstrapBinding((args, cwd) => {
            manifests.push(JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')));
            record(args, cwd);
        }, home);

        expect(manifests).toEqual([{ private: true, allowScripts: { [`better-sqlite3@${INSTALLED}`]: true } }]);
    });

    it('replaces a package.json an earlier build left, so its approval always names the version being built', () => {
        const manifest = path.join(home, BUILD_DIR, 'package.json');
        fs.mkdirSync(path.dirname(manifest), { recursive: true });
        fs.writeFileSync(manifest, JSON.stringify({ dependencies: { 'better-sqlite3': '^12.0.0' }, allowScripts: { 'better-sqlite3@12.0.0': true } }));
        const seen: string[] = [];
        const record = fakeNpm([]);

        bootstrapBinding((args, cwd) => {
            seen.push(fs.readFileSync(manifest, 'utf8'));
            record(args, cwd);
        }, home);

        expect(JSON.parse(seen[0])).toEqual({ private: true, allowScripts: { [`better-sqlite3@${INSTALLED}`]: true } });
    });

    it('writes nothing outside the ghostpm home', () => {
        bootstrapBinding(fakeNpm([]), home);

        const written = (fs.readdirSync(root, { recursive: true }) as string[])
            .map(entry => path.join(root, entry))
            .filter(entry => fs.statSync(entry).isFile());
        expect(written.length).toBeGreaterThan(0);
        written.forEach(file => expect(file.startsWith(home + path.sep)).toBe(true));
    });

    it('refuses to hand a shell anything it would reinterpret', () => {
        expect(() => assertSafeNpmArgs(['install', 'x & calc'])).toThrow('Refusing');
        expect(() => assertSafeNpmArgs(['--prefix', 'C:\\Users\\A B'])).toThrow('Refusing');
        expect(() => assertSafeNpmArgs(['better-sqlite3@^12.11.1'])).toThrow('Refusing');
        expect(() => assertSafeNpmArgs(npmInstallArgs(INSTALLED))).not.toThrow();
    });

    it('reports an npm run that produced no addon', () => {
        expect(() => bootstrapBinding(() => undefined, home)).toThrow('produced no addon');
    });

    describe('says why a build fails: a prebuilt addon on the supported LTS lines, a compiler on any other Node.js', () => {
        const messageOf = (run: NpmRunner): string => {
            try {
                bootstrapBinding(run, home);
            } catch (error) {
                return (error as Error).message;
            }
            throw new Error('bootstrapBinding did not fail');
        };
        const explains = (message: string): void => {
            // Even (LTS) majors from the minimum get prebuilts; the odd one between (23) has no Windows prebuilt.
            expect(message).toContain(`Node.js ${minimumNodeMajor()} or ${minimumNodeMajor() + 2}+ downloads a prebuilt`);
            expect(message).toContain('Python');
            expect(message).toContain('C++ toolchain');
        };

        it('when npm fails, after npm\'s own message', () => {
            const message = messageOf(() => { throw new Error('Command failed: npm install'); });
            expect(message).toContain('Command failed: npm install');
            explains(message);
        });

        it('when npm leaves no addon', () => {
            const message = messageOf(() => undefined);
            expect(message).toContain('produced no addon');
            explains(message);
        });
    });

    it('the default runner hands npm one command line: its absolute path quoted, then the checked arguments, with the home only as cwd', () => {
        expect(() => bootstrapBinding(undefined, home)).toThrow('produced no addon');

        expect(resolveCommand).toHaveBeenCalledWith('npm');
        // One string and no args array: no DEP0190 on Node 24, and cmd.exe never looks for npm in the working folder.
        expect(jest.mocked(execSync).mock.calls).toEqual([[
            `"${NPM_PATH}" install better-sqlite3@${INSTALLED} --prefix . --no-audit --no-fund`,
            { cwd: path.join(home, BUILD_DIR), stdio: 'inherit' },
        ]]);
        expect(execFileSync).not.toHaveBeenCalled();
        expect(spawnSync).not.toHaveBeenCalled();
    });

    it('the default runner gives npm a time limit when asked for one, so a hung install fails instead of waiting forever', () => {
        const limitMs = 60 * 1000;
        jest.mocked(resolveCommand).mockReturnValue(NPM_PATH);

        runNpm(['ci', '--ignore-scripts'], root, limitMs);

        expect(jest.mocked(execSync).mock.calls).toEqual([[`"${NPM_PATH}" ci --ignore-scripts`, { cwd: root, stdio: 'inherit', timeout: limitMs }]]);
    });

    it('the default runner refuses an unsafe argument before npm runs', () => {
        expect(() => runNpm(['install', 'x & calc'], root)).toThrow('Refusing');
        expect(execSync).not.toHaveBeenCalled();
    });

    it('refuses an npm path that cmd.exe would reinterpret inside quotes', () => {
        jest.mocked(resolveCommand).mockReturnValue('C:\\Users\\100%PATH%\\npm.cmd');

        expect(() => bootstrapBinding(undefined, home)).toThrow('Refusing to run npm from C:\\Users\\100%PATH%\\npm.cmd');
        expect(execSync).not.toHaveBeenCalled();
    });

    itOnWindows('refuses a home on a network share before anything runs: cmd.exe cannot start there', () => {
        const calls: NpmCall[] = [];
        // A share that does not exist on this machine: nothing leaves it even if the refusal were missing.
        const shareHome = '\\\\localhost\\ghostpm-no-such-share\\.ghostpm';

        expect(() => bootstrapBinding(fakeNpm(calls), shareHome)).toThrow('network share');
        expect(calls).toEqual([]);
    });

    it('refuses an installed version that is not exact, before npm runs', () => {
        const manifest = require.resolve('better-sqlite3/package.json');
        const readFileSync = nodeFs.readFileSync;
        // The module object itself: the namespace import above has getters jest cannot redefine.
        jest.spyOn(nodeFs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: BufferEncoding) =>
            file === manifest ? JSON.stringify({ version: '^12.11.1' }) : readFileSync(file, options)) as typeof fs.readFileSync);

        expect(() => bootstrapBinding(undefined, home)).toThrow('Unexpected better-sqlite3 version "^12.11.1"');
        expect(execSync).not.toHaveBeenCalled();
    });
});
