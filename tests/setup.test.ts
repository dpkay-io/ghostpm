import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setupStatusline } from '../src/setup';
import { statuslineCommand } from '../src/plugin-setup';
import { removeTempDir } from './temp-dir';
import { isolateHomes } from './ledger/helpers';

const PREVIOUS_STATUSLINE = 'claude-ticker';

/**
 * What setup is for now: only what a plugin cannot do. The plugin declares the MCP server,
 * the hooks and the skill, so setup chains the statusline and writes nothing else.
 */
describe('setupStatusline', () => {
    let tmpDir: string;
    let userSettingsPath: string;
    let restoreHomes: () => void;
    const origGhostpmHome = process.env.GHOSTPM_HOME;

    const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));

    const writeUserSettings = (settings: unknown): void => {
        fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true });
        fs.writeFileSync(userSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
    };

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-setup-'));
        userSettingsPath = path.join(tmpDir, '.claude', 'settings.json');
        restoreHomes = isolateHomes(tmpDir);
        process.env.GHOSTPM_HOME = path.join(tmpDir, '.ghostpm');
    });

    afterEach(() => {
        restoreHomes();
        if (origGhostpmHome === undefined) delete process.env.GHOSTPM_HOME;
        else process.env.GHOSTPM_HOME = origGhostpmHome;
        removeTempDir(tmpDir);
    });

    it('chains the statusline', () => {
        writeUserSettings({ statusLine: { type: 'command', command: PREVIOUS_STATUSLINE } });

        setupStatusline({ silent: true });

        expect(readJson(userSettingsPath).statusLine.command).toBe(statuslineCommand());
    });

    it('is safe to run twice', () => {
        writeUserSettings({ statusLine: { type: 'command', command: PREVIOUS_STATUSLINE } });

        setupStatusline({ silent: true });
        setupStatusline({ silent: true });

        expect(readJson(userSettingsPath).statusLine.command).toBe(statuslineCommand());
    });

    it('leaves the rest of the user settings alone', () => {
        writeUserSettings({ model: 'opus', permissions: { allow: ['read'] }, statusLine: { type: 'command', command: PREVIOUS_STATUSLINE } });

        setupStatusline({ silent: true });

        const settings = readJson(userSettingsPath);
        expect(settings.model).toBe('opus');
        expect(settings.permissions.allow).toEqual(['read']);
    });

    // Regression guards: the new code has no path to either, so they cannot be red first.
    it('registers no MCP server: the plugin declares it', () => {
        writeUserSettings({});

        setupStatusline({ silent: true });

        expect(readJson(userSettingsPath).mcpServers).toBeUndefined();
    });

    it('writes no skill: the plugin ships it, and a second copy conflicts with it by name', () => {
        setupStatusline({ silent: true });

        expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills'))).toBe(false);
    });
});
