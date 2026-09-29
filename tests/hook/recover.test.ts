import { recoverFromMissingBinding, BOOTSTRAP_NOTICE } from '../../src/hook/recover';
import { MISSING_BINDING_HELP } from '../../src/ledger/db';

/**
 * A hook that cannot open the ledger must not leave the user guessing. It says so in the
 * session and starts the build itself, rather than waiting for someone to read hook.log.
 */
describe('recovering from a missing addon', () => {
    const missing = new Error(MISSING_BINDING_HELP);

    it('starts the build and says so when a session begins', () => {
        let started = 0;

        const notice = recoverFromMissingBinding('SessionStart', missing, () => { started += 1; });

        expect(started).toBe(1);
        expect(notice).toBe(BOOTSTRAP_NOTICE);
    });

    it('leaves the build to SessionStart rather than starting one per prompt', () => {
        // UserPromptSubmit and PostToolBatch fire repeatedly; each starting its own npm
        // install would run several compiles against the same directory at once.
        let started = 0;

        expect(recoverFromMissingBinding('UserPromptSubmit', missing, () => { started += 1; })).toBeNull();
        expect(recoverFromMissingBinding('PostToolBatch', missing, () => { started += 1; })).toBeNull();

        expect(started).toBe(0);
    });

    it('ignores a failure that has nothing to do with the addon', () => {
        let started = 0;
        const unrelated = new Error('database disk image is malformed');

        expect(recoverFromMissingBinding('SessionStart', unrelated, () => { started += 1; })).toBeNull();
        expect(started).toBe(0);
    });
});
