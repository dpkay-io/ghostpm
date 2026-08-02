import * as fs from 'fs';
import * as path from 'path';
import { findGitRoot, detectVendor, sniffWorkflowStates, initMcpPm } from '../src/init';
import { runCli } from '../src/cli';
import * as os from 'os';

jest.mock('../src/cli');

describe('init', () => {
    let tmpDir: string;
    let gitDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-init-test-'));
        jest.clearAllMocks();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('findGitRoot', () => {
        it('should return null if no git root found', () => {
            expect(findGitRoot(tmpDir)).toBeNull();
        });

        it('should return dir if .git exists', () => {
            gitDir = path.join(tmpDir, '.git');
            fs.mkdirSync(gitDir);
            expect(findGitRoot(tmpDir)).toBe(tmpDir);
        });

        it('should traverse up to find .git', () => {
            gitDir = path.join(tmpDir, '.git');
            fs.mkdirSync(gitDir);
            const subDir = path.join(tmpDir, 'sub', 'dir');
            fs.mkdirSync(subDir, { recursive: true });
            expect(findGitRoot(subDir)).toBe(tmpDir);
        });
    });

    describe('detectVendor', () => {
        beforeEach(() => {
            gitDir = path.join(tmpDir, '.git');
            fs.mkdirSync(gitDir);
        });

        it('should return null if no git config', () => {
            expect(detectVendor(tmpDir)).toBeNull();
        });

        it('should detect github', () => {
            const configPath = path.join(gitDir, 'config');
            fs.writeFileSync(configPath, 'url = https://github.com/user/repo.git');
            expect(detectVendor(tmpDir)).toBe('github');
        });

        it('should detect azure_devops', () => {
            const configPath = path.join(gitDir, 'config');
            fs.writeFileSync(configPath, 'url = https://dev.azure.com/user/repo');
            expect(detectVendor(tmpDir)).toBe('azure_devops');
        });

        it('should detect azure_devops from visualstudio', () => {
            const configPath = path.join(gitDir, 'config');
            fs.writeFileSync(configPath, 'url = https://user.visualstudio.com/repo');
            expect(detectVendor(tmpDir)).toBe('azure_devops');
        });

        it('should return null if unknown url', () => {
            const configPath = path.join(gitDir, 'config');
            fs.writeFileSync(configPath, 'url = https://gitlab.com/user/repo.git');
            expect(detectVendor(tmpDir)).toBeNull();
        });

        it('should handle worktrees (.git as file)', () => {
            fs.rmSync(gitDir, { recursive: true });
            
            const realGitDir = path.join(tmpDir, 'realgit');
            fs.mkdirSync(realGitDir);
            fs.writeFileSync(path.join(realGitDir, 'config'), 'url = https://github.com/user/repo.git');
            
            fs.writeFileSync(gitDir, `gitdir: ${realGitDir}`);
            expect(detectVendor(tmpDir)).toBe('github');
        });
        
        it('should return null if worktree config not found', () => {
            fs.rmSync(gitDir, { recursive: true });
            
            const realGitDir = path.join(tmpDir, 'realgit');
            fs.writeFileSync(gitDir, `gitdir: ${realGitDir}`); // no config inside realGitDir
            expect(detectVendor(tmpDir)).toBeNull();
        });
    });

    describe('sniffWorkflowStates', () => {
        it('should sniff github states', async () => {
            (runCli as jest.Mock).mockResolvedValue(JSON.stringify([
                { state: 'OPEN', labels: [{ name: 'in_progress' }, { name: 'bug' }] },
                { state: 'CLOSED' }
            ]));
            const states = await sniffWorkflowStates('github');
            expect(states).toContain('open');
            expect(states).toContain('in_progress');
            expect(states).toContain('closed');
        });

        it('should return default github states on error', async () => {
            (runCli as jest.Mock).mockRejectedValue(new Error('error'));
            const states = await sniffWorkflowStates('github');
            expect(states).toEqual(['open', 'in_progress', 'in_review', 'closed']);
        });

        it('should sniff azure states', async () => {
            (runCli as jest.Mock).mockResolvedValue(JSON.stringify([
                { fields: { 'System.State': 'Active' } },
                { fields: { 'System.State': 'Resolved' } }
            ]));
            const states = await sniffWorkflowStates('azure_devops');
            expect(states).toContain('active');
            expect(states).toContain('resolved');
        });

        it('should return default azure states on empty output or error', async () => {
            (runCli as jest.Mock).mockResolvedValue(JSON.stringify([]));
            const states = await sniffWorkflowStates('azure_devops');
            expect(states).toEqual(['new', 'active', 'resolved', 'closed']);
        });
    });

    describe('initMcpPm', () => {
        beforeEach(() => {
            gitDir = path.join(tmpDir, '.git');
        });

        it('should throw if not a git root', async () => {
            await expect(initMcpPm(tmpDir)).rejects.toThrow('Not a git repository. Cannot initialize MCP PM.');
        });

        it('should return early if .mcp-pm.yml exists', async () => {
            fs.mkdirSync(gitDir);
            fs.writeFileSync(path.join(tmpDir, '.mcp-pm.yml'), '');
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
            await initMcpPm(tmpDir);
            expect(consoleSpy).toHaveBeenCalledWith('.mcp-pm.yml already exists.');
            consoleSpy.mockRestore();
        });

        it('should throw if vendor cannot be detected', async () => {
            fs.mkdirSync(gitDir);
            fs.writeFileSync(path.join(gitDir, 'config'), 'url = https://gitlab.com/user/repo.git');
            await expect(initMcpPm(tmpDir)).rejects.toThrow('Could not detect vendor (GitHub or Azure DevOps) from .git/config.');
        });

        it('should write .mcp-pm.yml successfully', async () => {
            fs.mkdirSync(gitDir);
            fs.writeFileSync(path.join(gitDir, 'config'), 'url = https://github.com/user/repo.git');
            
            (runCli as jest.Mock).mockResolvedValue(JSON.stringify([
                { state: 'OPEN', labels: [{ name: 'in_progress' }] }
            ]));

            await initMcpPm(tmpDir);

            const configContent = fs.readFileSync(path.join(tmpDir, '.mcp-pm.yml'), 'utf8');
            expect(configContent).toContain('vendor: "github"');
            expect(configContent).toContain('"open"');
            expect(configContent).toContain('"in_progress"');
        });
        
        it('should use active/resolved for azure if present', async () => {
            fs.mkdirSync(gitDir);
            fs.writeFileSync(path.join(gitDir, 'config'), 'url = https://dev.azure.com/user/repo');
            
            (runCli as jest.Mock).mockResolvedValue(JSON.stringify([
                { fields: { 'System.State': 'Active' } },
                { fields: { 'System.State': 'Resolved' } }
            ]));

            await initMcpPm(tmpDir);

            const configContent = fs.readFileSync(path.join(tmpDir, '.mcp-pm.yml'), 'utf8');
            expect(configContent).toContain('start_task: "active"');
            expect(configContent).toContain('code_push: "resolved"');
        });
        
        it('should fallback to defaults if active/resolved not present', async () => {
            fs.mkdirSync(gitDir);
            fs.writeFileSync(path.join(gitDir, 'config'), 'url = https://dev.azure.com/user/repo');
            
            (runCli as jest.Mock).mockResolvedValue(JSON.stringify([
                { fields: { 'System.State': 'State1' } },
                { fields: { 'System.State': 'State2' } },
                { fields: { 'System.State': 'State3' } }
            ]));

            await initMcpPm(tmpDir);

            const configContent = fs.readFileSync(path.join(tmpDir, '.mcp-pm.yml'), 'utf8');
            expect(configContent).toContain('start_task: "state2"');
            expect(configContent).toContain('code_push: "state3"');
        });
    });
});
