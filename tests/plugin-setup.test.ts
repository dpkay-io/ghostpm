import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tempLedger, TempLedger } from './ledger/helpers';
import { getSetting, SETTING_PREVIOUS_STATUSLINE } from '../src/ledger/settings';
import { chainStatusline, restoreStatusline, STATUSLINE_COMMAND } from '../src/plugin-setup';

const PREVIOUS = 'claude-ticker';

describe('statusline chaining', () => {
    let ledger: TempLedger;
    let settingsPath: string;

    const writeSettings = (settings: unknown): void => {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    };

    const readSettings = (): any => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

    const remembered = (): string | undefined => getSetting<string>(ledger.db, SETTING_PREVIOUS_STATUSLINE);

    beforeEach(() => {
        ledger = tempLedger();
        settingsPath = path.join(ledger.dir, 'settings.json');
    });

    afterEach(() => {
        ledger.cleanup();
    });

    it('takes over the statusline and remembers what was there', () => {
        writeSettings({ statusLine: { type: 'command', command: PREVIOUS } });

        chainStatusline(ledger.db, settingsPath);

        expect(readSettings().statusLine.command).toContain(STATUSLINE_COMMAND);
        expect(remembered()).toBe(PREVIOUS);
    });

    it('never chains itself in front of itself', () => {
        // Running setup twice must not record ghostpm as the previous command, or it
        // would invoke itself for every repaint, forever.
        writeSettings({ statusLine: { type: 'command', command: PREVIOUS } });

        chainStatusline(ledger.db, settingsPath);
        chainStatusline(ledger.db, settingsPath);

        expect(remembered()).toBe(PREVIOUS);
        expect(readSettings().statusLine.command).toContain(STATUSLINE_COMMAND);
    });

    it('still shows the task when no statusline was configured before', () => {
        writeSettings({});

        chainStatusline(ledger.db, settingsPath);

        expect(readSettings().statusLine.command).toContain(STATUSLINE_COMMAND);
        expect(remembered()).toBeUndefined();
    });

    it('gives the user back exactly the statusline they had', () => {
        writeSettings({ statusLine: { type: 'command', command: PREVIOUS } });
        chainStatusline(ledger.db, settingsPath);

        restoreStatusline(ledger.db, settingsPath);

        expect(readSettings().statusLine.command).toBe(PREVIOUS);
    });

    it('leaves no statusline behind when there was none to restore', () => {
        writeSettings({});
        chainStatusline(ledger.db, settingsPath);

        restoreStatusline(ledger.db, settingsPath);

        expect(readSettings().statusLine).toBeUndefined();
    });

    it('keeps the rest of the settings file intact', () => {
        writeSettings({
            model: 'opus',
            permissions: { allow: ['read'] },
            statusLine: { type: 'command', command: PREVIOUS },
        });

        chainStatusline(ledger.db, settingsPath);

        const settings = readSettings();
        expect(settings.model).toBe('opus');
        expect(settings.permissions.allow).toEqual(['read']);
        expect(settings.statusLine.type).toBe('command');
    });

    it('works when the settings file does not exist yet', () => {
        expect(() => chainStatusline(ledger.db, settingsPath)).not.toThrow();
        expect(readSettings().statusLine.command).toContain(STATUSLINE_COMMAND);
    });

    it('does not damage a settings file it cannot parse', () => {
        // Better to leave a broken file alone than to overwrite the user's config.
        fs.writeFileSync(settingsPath, '{ not valid json', 'utf8');

        expect(() => chainStatusline(ledger.db, settingsPath)).not.toThrow();
        expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ not valid json');
    });
});
