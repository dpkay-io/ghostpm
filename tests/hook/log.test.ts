import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendLog, logHookError, HOOK_LOG_FILE, LOG_MAX_BYTES, ROTATED_LOG_SUFFIX, SYNC_LOG_FILE } from '../../src/hook/log';
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

describe('appendLog caps each log at one rotated generation', () => {
    let home: string;
    let originalHome: string | undefined;
    const OLD_LINE = 'old line\n';
    const FILLER = 'x';
    const logPath = (file: string): string => path.join(home, file);
    const rotated = (file: string): string => `${file}${ROTATED_LOG_SUFFIX}`;
    const read = (file: string): string => fs.readFileSync(logPath(file), 'utf8');
    const sizeOf = (file: string): number => fs.statSync(logPath(file)).size;
    /** A log of exactly `bytes` bytes, as months of sync runs would leave it. Asserted by size, so a failure never prints a megabyte. */
    const seed = (file: string, bytes: number): void => fs.writeFileSync(logPath(file), OLD_LINE + FILLER.repeat(bytes - OLD_LINE.length));
    const isSeed = (file: string, bytes: number): boolean => sizeOf(file) === bytes && read(file).indexOf(OLD_LINE) === 0;

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-logcap-'));
        originalHome = process.env.GHOSTPM_HOME;
        process.env.GHOSTPM_HOME = home;
    });

    afterEach(() => {
        if (originalHome !== undefined) process.env.GHOSTPM_HOME = originalHome;
        else delete process.env.GHOSTPM_HOME;
        removeTempDir(home);
    });

    it('keeps appending while the log is at the cap or under it', () => {
        seed(SYNC_LOG_FILE, LOG_MAX_BYTES);

        appendLog(SYNC_LOG_FILE, 'still here');

        expect(read(SYNC_LOG_FILE).indexOf(OLD_LINE)).toBe(0);
        expect(read(SYNC_LOG_FILE).endsWith(' still here\n')).toBe(true);
        expect(fs.existsSync(logPath(rotated(SYNC_LOG_FILE)))).toBe(false);
    });

    it('moves a log above the cap to <name>.1 and starts a fresh one with the new line', () => {
        seed(SYNC_LOG_FILE, LOG_MAX_BYTES + 1);

        appendLog(SYNC_LOG_FILE, 'fresh start');

        expect(isSeed(rotated(SYNC_LOG_FILE), LOG_MAX_BYTES + 1)).toBe(true);
        expect(read(SYNC_LOG_FILE)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z fresh start\n$/);
    });

    it('keeps one generation: the next rotation replaces the old .1', () => {
        fs.writeFileSync(logPath(rotated(SYNC_LOG_FILE)), 'oldest generation');
        seed(SYNC_LOG_FILE, LOG_MAX_BYTES + 1);

        appendLog(SYNC_LOG_FILE, 'newest');

        expect(isSeed(rotated(SYNC_LOG_FILE), LOG_MAX_BYTES + 1)).toBe(true);
        expect(fs.readdirSync(home).sort()).toEqual([SYNC_LOG_FILE, rotated(SYNC_LOG_FILE)]);
    });

    it('applies the same cap to hook.log', () => {
        seed(HOOK_LOG_FILE, LOG_MAX_BYTES + 1);

        logHookError(new Error('after rotation'));

        expect(isSeed(rotated(HOOK_LOG_FILE), LOG_MAX_BYTES + 1)).toBe(true);
        expect(sizeOf(HOOK_LOG_FILE)).toBeLessThan(LOG_MAX_BYTES);
        expect(read(HOOK_LOG_FILE)).toContain('after rotation');
    });

    it('still logs the line when the rotation itself fails', () => {
        // A directory where <name>.1 should go: the rename fails, and the message must not be lost with it.
        fs.mkdirSync(logPath(rotated(SYNC_LOG_FILE)));
        seed(SYNC_LOG_FILE, LOG_MAX_BYTES + 1);

        expect(() => appendLog(SYNC_LOG_FILE, 'kept anyway')).not.toThrow();
        expect(fs.statSync(logPath(rotated(SYNC_LOG_FILE))).isDirectory()).toBe(true);
        expect(read(SYNC_LOG_FILE).indexOf(OLD_LINE)).toBe(0);
        expect(read(SYNC_LOG_FILE).endsWith(' kept anyway\n')).toBe(true);
    });
});
