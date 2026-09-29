import * as path from 'path';
import { bootstrappedBindingPath, isMissingBinding, BINDING_DIR, BINDING_FILE } from '../../src/ledger/binding';

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

        expect(bootstrappedBindingPath()).toBe(path.join('C:', 'tmp', 'gp-home', BINDING_DIR, BINDING_FILE));
    });

    it('recognises the error that means the addon was never compiled', () => {
        const real = new Error('Could not locate the bindings file. Tried:\n → /x/better_sqlite3.node');

        expect(isMissingBinding(real)).toBe(true);
    });

    it('does not mistake an unrelated failure for a missing addon', () => {
        // Misreading these would send a corrupt-database or permissions problem down
        // the bootstrap path and report the wrong cause to the user.
        expect(isMissingBinding(new Error('database disk image is malformed'))).toBe(false);
        expect(isMissingBinding(new Error('SQLITE_CANTOPEN: unable to open database file'))).toBe(false);
    });
});
