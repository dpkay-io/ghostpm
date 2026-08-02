import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setup } from '../src/setup';

jest.mock('child_process', () => ({
    execFileSync: jest.fn(() => { throw new Error('not found'); })
}));

jest.mock('../src/init', () => ({
    findGitRoot: jest.fn()
}));

import { findGitRoot } from '../src/init';
import { execFileSync } from 'child_process';

describe('setup', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-setup-'));
        jest.clearAllMocks();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should create .claude/settings.local.json with MCP config', async () => {
        (findGitRoot as jest.Mock).mockReturnValue(tmpDir);

        await setup({ silent: true });

        const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
        expect(fs.existsSync(settingsPath)).toBe(true);

        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        expect(settings.mcpServers.ghostpm).toBeDefined();
        expect(settings.mcpServers.ghostpm.command).toBe('node');
        expect(settings.mcpServers.ghostpm.args).toContain('serve');
    });

    it('should preserve existing settings when patching', async () => {
        (findGitRoot as jest.Mock).mockReturnValue(tmpDir);

        const settingsDir = path.join(tmpDir, '.claude');
        fs.mkdirSync(settingsDir, { recursive: true });
        fs.writeFileSync(
            path.join(settingsDir, 'settings.local.json'),
            JSON.stringify({ permissions: { allow: ["read"] }, mcpServers: { other: { command: "other" } } }),
            'utf8'
        );

        await setup({ silent: true });

        const settings = JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.local.json'), 'utf8'));
        expect(settings.permissions.allow).toEqual(["read"]);
        expect(settings.mcpServers.other.command).toBe('other');
        expect(settings.mcpServers.ghostpm).toBeDefined();
    });

    it('should use ghostpm command when globally installed', async () => {
        (findGitRoot as jest.Mock).mockReturnValue(tmpDir);
        (execFileSync as jest.Mock).mockReturnValue('C:\\ghostpm.cmd');

        await setup({ silent: true });

        const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        expect(settings.mcpServers.ghostpm.command).toBe('ghostpm');
        expect(settings.mcpServers.ghostpm.args).toEqual(['serve']);
    });

    it('should handle no git root gracefully', async () => {
        (findGitRoot as jest.Mock).mockReturnValue(null);

        await expect(setup({ silent: true })).resolves.not.toThrow();
    });
});
