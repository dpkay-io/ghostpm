import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    bootstrappedBindingPath, isMissingBinding, isWrongNodeBinding, BINDING_DIR, BINDING_FILE,
} from '../../src/ledger/binding';
import { BOOTSTRAP_FIX, MISSING_BINDING_HELP } from '../../src/ledger/db';
import { recoverFromMissingBinding } from '../../src/hook/recover';
import { removeTempDir } from '../temp-dir';

const DLOPEN_FAILED = 'ERR_DLOPEN_FAILED';

/** What Node 24 throws for an addon `ghostpm bootstrap` built under Node 20, word for word. */
function builtForAnotherNode(file: string): Error {
    return Object.assign(new Error(`The module '\\\\?\\${file}'\nwas compiled against a different Node.js version using\n`
        + 'NODE_MODULE_VERSION 115. This version of Node.js requires\nNODE_MODULE_VERSION 137. Please try re-compiling or re-installing\n'
        + 'the module (for instance, using `npm rebuild` or `npm install`).'), { code: DLOPEN_FAILED });
}

/** What `bindings` throws when this copy has no addon at all (a plugin install). */
const NOT_COMPILED = (): Error => new Error('Could not locate the bindings file. Tried:\n → /x/build/Release/better_sqlite3.node');

type Db = typeof import('../../src/ledger/db');

/** openDatabase over a better-sqlite3 whose load fails as `fail` says; a load it lets through opens a real database. */
function dbWithAddon(fail: (nativeBinding: string | undefined) => Error | null): Db {
    let db!: Db;
    jest.isolateModules(() => {
        jest.doMock('better-sqlite3', () => {
            const Real = jest.requireActual('better-sqlite3');
            return function Addon(file: string, options: { nativeBinding?: string } = {}) {
                const error = fail(options.nativeBinding);
                if (error !== null) throw error;
                const { nativeBinding: _loaded, ...rest } = options;
                return new Real(file, rest);
            };
        });
        db = require('../../src/ledger/db') as Db;
    });
    return db;
}

function failureOf(open: () => unknown): Error {
    try {
        open();
    } catch (error) {
        return error as Error;
    }
    throw new Error('openDatabase did not fail');
}

/**
 * The native addon is the one dependency a plugin install cannot provide: Claude Code
 * runs `npm ci --ignore-scripts`, so better-sqlite3's install script never compiles it.
 * These cover locating a bootstrapped copy and recognising the failure that calls for one.
 */
describe('native binding', () => {
    const origHome = process.env.GHOSTPM_HOME;

    afterEach(() => {
        if (origHome === undefined) delete process.env.GHOSTPM_HOME;
        else process.env.GHOSTPM_HOME = origHome;
    });

    it('keeps the binding in the ghostpm home, not the plugin directory', () => {
        // ${CLAUDE_PLUGIN_ROOT} is version-scoped and replaced on every update, so a
        // binding stored there would have to be rebuilt each time.
        process.env.GHOSTPM_HOME = path.join('C:', 'tmp', 'gp-home');

        expect(bootstrappedBindingPath().startsWith(path.join('C:', 'tmp', 'gp-home', BINDING_DIR) + path.sep)).toBe(true);
    });

    it('keeps one addon per platform, CPU and Node.js ABI, so switching Node.js never loads or overwrites another one\'s', () => {
        // process.versions is read-only, so this names the running Node.js's ABI; NODE_MODULE_VERSION is what dlopen checks.
        const home = path.join('C:', 'tmp', 'gp-home');
        const thisNode = `${process.platform}-${process.arch}-${process.versions.modules}`;

        expect(bootstrappedBindingPath(home)).toBe(path.join(home, BINDING_DIR, thisNode, BINDING_FILE));
    });

    it('recognises an addon built for another Node.js, and only that dlopen failure', () => {
        expect(isWrongNodeBinding(builtForAnotherNode('/x/better_sqlite3.node'))).toBe(true);
        // A missing DLL fails dlopen too, but rebuilding the addon would not fix it.
        expect(isWrongNodeBinding(Object.assign(new Error('The specified module could not be found.'), { code: DLOPEN_FAILED }))).toBe(false);
        expect(isWrongNodeBinding(new Error('NODE_MODULE_VERSION 115'))).toBe(false);
        expect(isWrongNodeBinding(NOT_COMPILED())).toBe(false);
    });

    it('recognises the error that means the addon was never compiled', () => {
        const real = new Error('Could not locate the bindings file. Tried:\n → /x/better_sqlite3.node');

        expect(isMissingBinding(real)).toBe(true);
    });

    it('names both ways an install ends up without the addon, and the one fix', () => {
        // npm 12 blocks dependency install scripts by default, with no --ignore-scripts involved:
        // a message that blamed only the plugin install would send those users the wrong way.
        expect(MISSING_BINDING_HELP).toMatch(/--ignore-scripts/);
        expect(MISSING_BINDING_HELP).toMatch(/npm 12|blocks? .*install scripts/i);
        expect(MISSING_BINDING_HELP).toContain(`\`${BOOTSTRAP_FIX}\``);
    });

    it('does not mistake an unrelated failure for a missing addon', () => {
        // Misreading these would send a corrupt-database or permissions problem down
        // the bootstrap path and report the wrong cause to the user.
        expect(isMissingBinding(new Error('database disk image is malformed'))).toBe(false);
        expect(isMissingBinding(new Error('SQLITE_CANTOPEN: unable to open database file'))).toBe(false);
    });

    describe('an addon built for another Node.js (Node.js switched or upgraded after a bootstrap)', () => {
        let home: string;

        beforeEach(() => {
            home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-abi-'));
            process.env.GHOSTPM_HOME = home;
            fs.mkdirSync(path.dirname(bootstrappedBindingPath()), { recursive: true });
            fs.writeFileSync(bootstrappedBindingPath(), 'stands in for the bootstrapped addon');
        });

        afterEach(() => {
            jest.dontMock('better-sqlite3');
            removeTempDir(home);
        });

        it('counts as missing, so the MCP server still connects and SessionStart starts a rebuild', () => {
            const db = dbWithAddon(nativeBinding => nativeBinding === undefined ? NOT_COMPILED() : builtForAnotherNode(nativeBinding));
            const started = jest.fn();

            const error = failureOf(() => db.openDatabase(':memory:'));

            expect(error.message).toBe(MISSING_BINDING_HELP);
            expect(db.isMissingAddon(error)).toBe(true);
            expect(recoverFromMissingBinding('SessionStart', error, started)).not.toBeNull();
            expect(started).toHaveBeenCalledTimes(1);
        });

        it('in this copy itself (a CLI installed under another Node.js) falls back to the bootstrapped addon', () => {
            const db = dbWithAddon(nativeBinding => nativeBinding === undefined ? builtForAnotherNode('/cli/better_sqlite3.node') : null);

            db.openDatabase(':memory:').close();
        });

        it('in this copy, with nothing bootstrapped for this Node.js, says how to build it', () => {
            fs.rmSync(bootstrappedBindingPath());
            const db = dbWithAddon(() => builtForAnotherNode('/cli/better_sqlite3.node'));

            expect(failureOf(() => db.openDatabase(':memory:')).message).toBe(MISSING_BINDING_HELP);
        });

        it('leaves any other failure of the bootstrapped addon as it is', () => {
            const missingDll = Object.assign(new Error('The specified module could not be found.'), { code: DLOPEN_FAILED });
            const db = dbWithAddon(nativeBinding => nativeBinding === undefined ? NOT_COMPILED() : missingDll);

            expect(failureOf(() => db.openDatabase(':memory:'))).toBe(missingDll);
        });
    });
});
