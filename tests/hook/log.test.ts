import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logHookError, HOOK_LOG_FILE } from '../../src/hook/log';
import { removeTempDir } from '../temp-dir';

describe('logHookError', () => {
    let home: string;
    let originalHome: string | undefined;

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-hooklog-'));
        originalHome = process.env.GHOSTPM_HOME;
    });

    afterEach(() => {
        if (originalHome !== undefined) process.env.GHOSTPM_HOME = originalHome;
        else delete process.env.GHOSTPM_HOME;
        removeTempDir(home);
    });

    it('creates the ghostpm home when it does not exist yet', () => {
        // The first hook can fire before anything has created ~/.ghostpm; without the
        // directory, appending would throw ENOENT and the error would vanish silently.
        const missing = path.join(home, 'not-created-yet');
        process.env.GHOSTPM_HOME = missing;

        logHookError(new Error('boom'));

        const logged = fs.readFileSync(path.join(missing, HOOK_LOG_FILE), 'utf8');
        expect(logged).toContain('boom');
    });

    it('appends rather than replacing, and timestamps each line', () => {
        process.env.GHOSTPM_HOME = home;

        logHookError(new Error('first'));
        logHookError('second');

        const lines = fs.readFileSync(path.join(home, HOOK_LOG_FILE), 'utf8').trim().split('\n');
        expect(lines.length).toBeGreaterThanOrEqual(2);
        expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /);
        expect(lines.join('\n')).toContain('first');
        expect(lines.join('\n')).toContain('second');
    });

    it('never throws, even when the home cannot be written', () => {
        // A path whose parent is a file, not a directory: mkdir and append both fail.
        const blocker = path.join(home, 'blocker');
        fs.writeFileSync(blocker, 'not a directory');
        process.env.GHOSTPM_HOME = path.join(blocker, 'nested');

        expect(() => logHookError(new Error('ignored'))).not.toThrow();
    });
});
