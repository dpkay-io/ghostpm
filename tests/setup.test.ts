import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setup } from '../src/setup';
import { statuslineCommand } from '../src/plugin-setup';
import { removeTempDir } from './temp-dir';

// Mocking init also keeps cli.ts — and with it child_process — out of the test graph:
// setup imports findGitRoot from init, and init imports runCli from cli. setup never
// calls anything that shells out, but the import path exists, so this mock is what
// makes that irrelevant here.
jest.mock('../src/init', () => ({
    findGitRoot: jest.fn(),
}));

import { findGitRoot } from '../src/init';

const PREVIOUS_STATUSLINE = 'claude-ticker';

/**
 * These test what setup is for, not how it works: the plugin declares the MCP server
 * and the hooks, so setup exists only to do what a plugin cannot — chain the statusline
 * and install the skill.
 */
describe('setup', () => {
    let tmpDir: string;
    let userSettingsPath: string;
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    const origGhostpmHome = process.env.GHOSTPM_HOME;

    const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));

    const writeUserSettings = (settings: unknown): void => {
        fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true });
        fs.writeFileSync(userSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
    };

    /** Every settings file setup could plausibly have written to. */
    const allSettingsFiles = (): string[] => [
        userSettingsPath,
        path.join(tmpDir, '.claude', 'settings.local.json'),
    ].filter(file => fs.existsSync(file));

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-setup-'));
        userSettingsPath = path.join(tmpDir, '.claude', 'settings.json');
        process.env.HOME = tmpDir;
        process.env.USERPROFILE = tmpDir;
        process.env.GHOSTPM_HOME = path.join(tmpDir, '.ghostpm');
        jest.clearAllMocks();
        (findGitRoot as jest.Mock).mockReturnValue(tmpDir);
    });

    afterEach(() => {
        process.env.HOME = origHome;
        process.env.USERPROFILE = origUserProfile;
        if (origGhostpmHome === undefined) delete process.env.GHOSTPM_HOME;
        else process.env.GHOSTPM_HOME = origGhostpmHome;
        removeTempDir(tmpDir);
    });

    it('registers no MCP server: the plugin declares it', async () => {
        // Registering it here is what left this machine pointed at a global install
        // predating the ledger. .mcp.json in the plugin is the single declaration now.
        await setup({ silent: true });

        for (const file of allSettingsFiles()) {
            expect(readJson(file).mcpServers).toBeUndefined();
        }
    });

    it('leaves the statusline alone by default', async () => {
        // Chaining rewrites a statusline the user picked themselves, so it is opt-in.
        writeUserSettings({ statusLine: { type: 'command', command: PREVIOUS_STATUSLINE } });

        await setup({ silent: true });

        expect(readJson(userSettingsPath).statusLine.command).toBe(PREVIOUS_STATUSLINE);
    });

    it('creates no settings file when it has nothing to write', async () => {
        await setup({ silent: true });

        expect(fs.existsSync(userSettingsPath)).toBe(false);
    });

    it('chains the statusline only when asked for it', async () => {
        writeUserSettings({ statusLine: { type: 'command', command: PREVIOUS_STATUSLINE } });

        await setup({ silent: true, statusline: true });

        expect(readJson(userSettingsPath).statusLine.command).toBe(statuslineCommand());
    });

    it('installs the skill so the model knows the workflow', async () => {
        await setup({ silent: true });

        const skillPath = path.join(tmpDir, '.claude', 'skills', 'ghostpm', 'SKILL.md');
        expect(fs.readFileSync(skillPath, 'utf8')).toContain('name: ghostpm');
    });

    it('leaves the rest of the user settings alone', async () => {
        writeUserSettings({
            model: 'opus',
            permissions: { allow: ['read'] },
            statusLine: { type: 'command', command: PREVIOUS_STATUSLINE },
        });

        await setup({ silent: true });

        const settings = readJson(userSettingsPath);
        expect(settings.model).toBe('opus');
        expect(settings.permissions.allow).toEqual(['read']);
    });

    it('is safe to run twice', async () => {
        writeUserSettings({ statusLine: { type: 'command', command: PREVIOUS_STATUSLINE } });

        await setup({ silent: true, statusline: true });
        await setup({ silent: true, statusline: true });

        // Still chained once, and the original is still recoverable rather than lost
        // behind a second layer of ghostpm.
        expect(readJson(userSettingsPath).statusLine.command).toBe(statuslineCommand());
    });

    it('works outside a git repository', async () => {
        (findGitRoot as jest.Mock).mockReturnValue(null);

        await expect(setup({ silent: true })).resolves.not.toThrow();
    });
});
