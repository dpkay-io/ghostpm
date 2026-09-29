import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tempLedger, TempLedger } from './ledger/helpers';
import { getSetting, SETTING_PREVIOUS_STATUSLINE } from '../src/ledger/settings';
import {
    chainStatusline, restoreStatusline, refreshLauncher, statuslineCommand, launcherPath,
} from '../src/plugin-setup';

const PREVIOUS = 'claude-ticker';
const CLI_ENTRY = 'cli-main.js';

describe('statusline chaining', () => {
    let ledger: TempLedger;
    let settingsPath: string;

    const writeSettings = (settings: unknown): void => {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    };

    const readSettings = (): any => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

    const remembered = (): string | undefined => getSetting<string>(ledger.db, SETTING_PREVIOUS_STATUSLINE);

    /** The ledger's directory doubles as the ghostpm home, so nothing reaches the real one. */
    const chain = (): void => chainStatusline(ledger.db, settingsPath, ledger.dir, path.join(ledger.dir, CLI_ENTRY));
    const restore = (): boolean => restoreStatusline(ledger.db, settingsPath, ledger.dir);
    const ours = (): string => statuslineCommand(ledger.dir);

    beforeEach(() => {
        ledger = tempLedger();
        settingsPath = path.join(ledger.dir, 'settings.json');
    });

    afterEach(() => {
        ledger.cleanup();
    });

    it('takes over the statusline and remembers what was there', () => {
        writeSettings({ statusLine: { type: 'command', command: PREVIOUS } });

        chain();

        expect(readSettings().statusLine.command).toBe(ours());
        expect(remembered()).toBe(PREVIOUS);
    });

    it('never chains itself in front of itself', () => {
        // Running setup twice must not record ghostpm as the previous command, or it
        // would invoke itself for every repaint, forever.
        writeSettings({ statusLine: { type: 'command', command: PREVIOUS } });

        chain();
        chain();

        expect(remembered()).toBe(PREVIOUS);
        expect(readSettings().statusLine.command).toBe(ours());
    });

    it('still shows the task when no statusline was configured before', () => {
        writeSettings({});

        chain();

        expect(readSettings().statusLine.command).toBe(ours());
        expect(remembered()).toBeUndefined();
    });

    it('gives the user back exactly the statusline they had', () => {
        writeSettings({ statusLine: { type: 'command', command: PREVIOUS } });
        chain();

        restore();

        expect(readSettings().statusLine.command).toBe(PREVIOUS);
    });

    it('leaves no statusline behind when there was none to restore', () => {
        writeSettings({});
        chain();

        restore();

        expect(readSettings().statusLine).toBeUndefined();
    });

    it('restores nothing over a statusline it never chained', () => {
        // Covers both a user who never opted in and one who replaced ghostpm by hand.
        writeSettings({ statusLine: { type: 'command', command: PREVIOUS } });

        expect(restore()).toBe(false);
        expect(readSettings().statusLine.command).toBe(PREVIOUS);
    });

    it('keeps the rest of the settings file intact', () => {
        writeSettings({
            model: 'opus',
            permissions: { allow: ['read'] },
            statusLine: { type: 'command', command: PREVIOUS },
        });

        chain();

        const settings = readSettings();
        expect(settings.model).toBe('opus');
        expect(settings.permissions.allow).toEqual(['read']);
        expect(settings.statusLine.type).toBe('command');
    });

    it('works when the settings file does not exist yet', () => {
        expect(chain).not.toThrow();
        expect(readSettings().statusLine.command).toBe(ours());
    });

    it('does not damage a settings file it cannot parse', () => {
        // Better to leave a broken file alone than to overwrite the user's config.
        fs.writeFileSync(settingsPath, '{ not valid json', 'utf8');

        expect(chain).not.toThrow();
        expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ not valid json');
    });

    it('opts nobody in behind their back', () => {
        // Every session start refreshes the launcher, so it must only ever refresh one
        // that a user asked for.
        refreshLauncher(ledger.dir, path.join(ledger.dir, CLI_ENTRY));

        expect(fs.existsSync(launcherPath(ledger.dir))).toBe(false);
    });

    it('leaves nothing of its own behind once restored', () => {
        writeSettings({ statusLine: { type: 'command', command: PREVIOUS } });
        chain();

        restore();
        refreshLauncher(ledger.dir, path.join(ledger.dir, CLI_ENTRY));

        expect(fs.existsSync(launcherPath(ledger.dir))).toBe(false);
    });
});
