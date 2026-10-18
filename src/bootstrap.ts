import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getGhostpmHome } from './registry';
import { BINDING_FILE, abiFolder, bootstrappedBindingPath } from './ledger/binding';
import { IS_WINDOWS, UNSAFE_IN_QUOTES, resolveCommand } from './cli';
import { minimumNodeMajor } from './package-info';

const PACKAGE = 'better-sqlite3';
const NPM = 'npm';
export const BUILD_DIR = 'native-build';
const BUILT_ADDON = path.join('node_modules', PACKAGE, 'build', 'Release', BINDING_FILE);
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const MANIFEST = 'package.json';
/** cmd.exe cannot start in a UNC folder: it falls back to the Windows folder, where `--prefix .` would then point. */
const UNC_PREFIX = '\\\\';
/**
 * A shell is unavoidable (npm is a .cmd shim on Windows, which execFile cannot start),
 * so every argument must be inert to cmd.exe and sh: no spaces, & | < > ^ % ( ) or quotes.
 */
export const SAFE_NPM_ARG = /^[A-Za-z0-9@._\/=-]+$/;

/** `timeoutMs`, when given, ends npm's command shell after that long (execSync's `timeout`). */
export type NpmRunner = (args: string[], cwd: string, timeoutMs?: number) => void;

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

/**
 * The build folder's own package.json. npm 12 blocks dependency install scripts unless `allowScripts` approves them, and
 * rejects `--allow-scripts` in a project install (EALLOWSCRIPTS); this pinned entry approves exactly the version being
 * built and nothing else. npm 10 and 11 ignore the field. Rewritten on every build, so a stale pin never lingers.
 */
function buildManifest(version: string): object {
    return { private: true, allowScripts: { [`${PACKAGE}@${version}`]: true } };
}

export function assertSafeNpmArgs(args: string[]): void {
    const unsafe = args.filter(arg => !SAFE_NPM_ARG.test(arg));
    if (unsafe.length > 0) throw new Error(`Refusing to pass ${JSON.stringify(unsafe)} to npm through a shell.`);
}

/**
 * One command line, never an args array beside a shell (Node 24 deprecates that, DEP0190). On Windows npm goes by the
 * absolute path where.exe finds on PATH, quoted, so cmd.exe never runs an npm planted in the working folder; elsewhere
 * resolveCommand answers the bare name, which sh looks up on PATH only.
 */
export const runNpm: NpmRunner = (args, cwd, timeoutMs) => {
    assertSafeNpmArgs(args);
    const npm = resolveCommand(NPM);
    if (UNSAFE_IN_QUOTES.test(npm)) throw new Error(`Refusing to run npm from ${npm}: cmd.exe would reinterpret that path.`);
    execSync([`"${npm}"`, ...args].join(' '), { cwd, stdio: 'inherit', timeout: timeoutMs });
};

/** Node.js LTS majors are even, two apart. The odd release between (23) got no Windows prebuilt of better-sqlite3. */
const NEXT_LTS_STEP = 2;

/**
 * The usual reason a build fails: no prebuilt addon for this Node.js. Both numbers come from engines: its minimum, an
 * LTS major, and the next LTS major after it.
 */
export function prebuiltNote(): string {
    const minimum = minimumNodeMajor();
    return `Node.js ${minimum} or ${minimum + NEXT_LTS_STEP}+ downloads a prebuilt SQLite addon; any other Node.js has to compile it, which needs Python and a C++ toolchain.`;
}

/**
 * Builds the native addon into the ghostpm home and returns where it landed. npm runs with
 * lifecycle scripts enabled, which is the point: prebuild-install downloads a matching
 * binary, or node-gyp compiles one, which is exactly the step Claude Code's
 * `npm ci --ignore-scripts` skips.
 */
export function bootstrapBinding(run: NpmRunner = runNpm, home: string = getGhostpmHome()): string {
    // Per ABI like the addon: in a folder another Node.js built, npm finds better-sqlite3 "up to date" and skips the
    // install script, leaving that Node.js's addon to be copied.
    const buildDir = path.join(home, BUILD_DIR, abiFolder());
    if (IS_WINDOWS && buildDir.startsWith(UNC_PREFIX)) {
        throw new Error(`The GhostPM home ${home} is on a network share, where cmd.exe cannot run npm. Set GHOSTPM_HOME to a local folder and run \`ghostpm bootstrap\` again.`);
    }
    const version = installedAddonVersion();
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, MANIFEST), JSON.stringify(buildManifest(version)));
    try {
        run(npmInstallArgs(version), buildDir);
    } catch (error) {
        throw new Error(`${(error as Error).message}\n${prebuiltNote()}`);
    }

    const built = path.join(buildDir, BUILT_ADDON);
    if (!fs.existsSync(built)) throw new Error(`npm completed but produced no addon at ${built}\n${prebuiltNote()}`);

    const target = bootstrappedBindingPath(home);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(built, target);
    return target;
}
