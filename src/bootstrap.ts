import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getGhostpmHome } from './registry';
import { BINDING_FILE, bootstrappedBindingPath } from './ledger/binding';

const PACKAGE = 'better-sqlite3';
export const BUILD_DIR = 'native-build';
const BUILT_ADDON = path.join('node_modules', PACKAGE, 'build', 'Release', BINDING_FILE);
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
/**
 * `shell: true` is unavoidable (npm is a .cmd shim on Windows, which execFile cannot start),
 * so every argument must be inert to cmd.exe and sh: no spaces, & | < > ^ % ( ) or quotes.
 */
export const SAFE_NPM_ARG = /^[A-Za-z0-9@._\/=-]+$/;

export type NpmRunner = (args: string[], cwd: string) => void;

/** The exact version installed beside this code: an addon built for another version may not match the JS that loads it. */
export function installedAddonVersion(): string {
    const manifest = JSON.parse(fs.readFileSync(require.resolve(`${PACKAGE}/package.json`), 'utf8')) as { version?: unknown };
    const version = String(manifest.version);
    if (!EXACT_VERSION.test(version)) throw new Error(`Unexpected ${PACKAGE} version "${version}".`);
    return version;
}

/**
 * `--prefix .` with the build directory as cwd: the home path is never an argument, so
 * spaces, & or % in it cannot split or inject anything, and npm cannot climb to an
 * enclosing project's package.json.
 */
export function npmInstallArgs(version: string): string[] {
    return ['install', `${PACKAGE}@${version}`, '--prefix', '.', '--no-audit', '--no-fund'];
}

export function assertSafeNpmArgs(args: string[]): void {
    const unsafe = args.filter(arg => !SAFE_NPM_ARG.test(arg));
    if (unsafe.length > 0) throw new Error(`Refusing to pass ${JSON.stringify(unsafe)} to npm through a shell.`);
}

const runNpm: NpmRunner = (args, cwd) => {
    assertSafeNpmArgs(args);
    execFileSync('npm', args, { cwd, stdio: 'inherit', shell: true });
};

/**
 * Builds the native addon into the ghostpm home and returns where it landed. npm runs with
 * lifecycle scripts enabled, which is the point: prebuild-install downloads a matching
 * binary, or node-gyp compiles one, which is exactly the step Claude Code's
 * `npm ci --ignore-scripts` skips.
 */
export function bootstrapBinding(run: NpmRunner = runNpm, home: string = getGhostpmHome()): string {
    const buildDir = path.join(home, BUILD_DIR);
    fs.mkdirSync(buildDir, { recursive: true });
    run(npmInstallArgs(installedAddonVersion()), buildDir);

    const built = path.join(buildDir, BUILT_ADDON);
    if (!fs.existsSync(built)) throw new Error(`npm completed but produced no addon at ${built}`);

    const target = bootstrappedBindingPath(home);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(built, target);
    return target;
}
