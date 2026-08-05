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
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-setup-'));
        process.env.HOME = tmpDir;
        process.env.USERPROFILE = tmpDir;
        jest.clearAllMocks();
    });

    afterEach(() => {
        process.env.HOME = origHome;
        process.env.USERPROFILE = origUserProfile;
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
        (execFileSync as jest.Mock).mockImplementation((cmd: string, args: string[]) => {
            if (args && args[0] === 'ghostpm') return 'C:\\ghostpm.cmd';
            throw new Error('not found');
        });

        await setup({ silent: true });

        const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        expect(settings.mcpServers.ghostpm.command).toBe('ghostpm');
        expect(settings.mcpServers.ghostpm.args).toEqual(['serve']);
    });

    it('should install skill plugin to project .claude/skills/ghostpm on local setup', async () => {
        (findGitRoot as jest.Mock).mockReturnValue(tmpDir);

        await setup({ silent: true });

        const skillDir = path.join(tmpDir, '.claude', 'skills', 'ghostpm');
        expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
        expect(fs.existsSync(path.join(skillDir, '.claude-plugin', 'plugin.json'))).toBe(true);

        const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
        expect(skill).toContain('name: ghostpm');

        const plugin = JSON.parse(fs.readFileSync(path.join(skillDir, '.claude-plugin', 'plugin.json'), 'utf8'));
        expect(plugin.name).toBe('ghostpm');
        expect(plugin.skills).toEqual(['./']);
    });

    it('should install skill plugin to global ~/.claude/skills/ghostpm on global setup', async () => {
        (findGitRoot as jest.Mock).mockReturnValue(null);

        await setup({ global: true, silent: true });

        const skillDir = path.join(tmpDir, '.claude', 'skills', 'ghostpm');
        expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
        expect(fs.existsSync(path.join(skillDir, '.claude-plugin', 'plugin.json'))).toBe(true);
    });

    it('should clean up legacy flat skill file', async () => {
        (findGitRoot as jest.Mock).mockReturnValue(tmpDir);

        // Create legacy flat file
        const legacyDir = path.join(tmpDir, '.claude', 'skills');
        fs.mkdirSync(legacyDir, { recursive: true });
        fs.writeFileSync(path.join(legacyDir, 'ghostpm.md'), 'old', 'utf8');

        await setup({ silent: true });

        expect(fs.existsSync(path.join(legacyDir, 'ghostpm.md'))).toBe(false);
        expect(fs.existsSync(path.join(legacyDir, 'ghostpm', 'SKILL.md'))).toBe(true);
    });

    it('should handle no git root gracefully', async () => {
        (findGitRoot as jest.Mock).mockReturnValue(null);

        await expect(setup({ silent: true })).resolves.not.toThrow();
    });
});
