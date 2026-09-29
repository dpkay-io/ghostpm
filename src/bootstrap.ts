import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getGhostpmHome } from './registry';
import { bootstrappedBindingPath } from './ledger/binding';

const PACKAGE = 'better-sqlite3';
const BUILD_DIR = 'native-build';

/**
 * The version this code was written against. Building a different one risks an addon
 * whose API has moved on from what the ledger calls.
 */
function requiredVersion(): string {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return manifest.dependencies[PACKAGE];
}

/**
 * Builds the native addon into the ghostpm home and returns where it landed.
 *
 * Runs npm with lifecycle scripts *enabled*, which is the whole point: prebuild-install
 * downloads a matching binary, or node-gyp compiles one, and that is exactly the step
 * Claude Code's `npm ci --ignore-scripts` skips.
 */
export function bootstrapBinding(): string {
    const home = getGhostpmHome();
    const buildDir = path.join(home, BUILD_DIR);
    fs.mkdirSync(buildDir, { recursive: true });

    execFileSync(
        'npm',
        ['install', `${PACKAGE}@${requiredVersion()}`, '--prefix', buildDir, '--no-audit', '--no-fund'],
        // shell: npm is a .cmd shim on Windows, which execFile cannot launch directly.
        { stdio: 'inherit', shell: true },
    );

    const built = path.join(buildDir, 'node_modules', PACKAGE, 'build', 'Release', 'better_sqlite3.node');
    if (!fs.existsSync(built)) {
        throw new Error(`npm completed but produced no addon at ${built}`);
    }

    const target = bootstrappedBindingPath(home);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(built, target);
    return target;
}
