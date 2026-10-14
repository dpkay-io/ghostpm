import * as fs from 'fs';
import nodeFs = require('fs');
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
    BUILD_DIR, NpmRunner, SAFE_NPM_ARG, assertSafeNpmArgs, bootstrapBinding, installedAddonVersion, npmInstallArgs,
} from '../src/bootstrap';
import { BINDING_FILE, bootstrappedBindingPath } from '../src/ledger/binding';
import { removeTempDir } from './temp-dir';

// Never run the real npm: the default runner's call is recorded instead.
jest.mock('child_process');

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

    it('refuses to hand a shell anything it would reinterpret', () => {
        expect(() => assertSafeNpmArgs(['install', 'x & calc'])).toThrow('Refusing');
        expect(() => assertSafeNpmArgs(['--prefix', 'C:\\Users\\A B'])).toThrow('Refusing');
        expect(() => assertSafeNpmArgs(['better-sqlite3@^12.11.1'])).toThrow('Refusing');
        expect(() => assertSafeNpmArgs(npmInstallArgs(INSTALLED))).not.toThrow();
    });

    it('reports an npm run that produced no addon', () => {
        expect(() => bootstrapBinding(() => undefined, home)).toThrow('produced no addon');
    });

    it('runs the real npm with the checked arguments and the home only as its working directory', () => {
        expect(() => bootstrapBinding(undefined, home)).toThrow('produced no addon');

        expect(execFileSync).toHaveBeenCalledTimes(1);
        expect(execFileSync).toHaveBeenCalledWith(
            'npm',
            ['install', `better-sqlite3@${INSTALLED}`, '--prefix', '.', '--no-audit', '--no-fund'],
            expect.objectContaining({ cwd: path.join(home, BUILD_DIR) }),
        );
    });

    it('refuses an installed version that is not exact, before npm runs', () => {
        const manifest = require.resolve('better-sqlite3/package.json');
        const readFileSync = nodeFs.readFileSync;
        // The module object itself: the namespace import above has getters jest cannot redefine.
        jest.spyOn(nodeFs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: BufferEncoding) =>
            file === manifest ? JSON.stringify({ version: '^12.11.1' }) : readFileSync(file, options)) as typeof fs.readFileSync);

        expect(() => bootstrapBinding(undefined, home)).toThrow('Unexpected better-sqlite3 version "^12.11.1"');
        expect(execFileSync).not.toHaveBeenCalled();
    });
});
