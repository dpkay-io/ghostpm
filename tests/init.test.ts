import * as fs from 'fs';
import * as path from 'path';
import { findGitRoot, detectVendor, detectRemote } from '../src/init';
import * as os from 'os';

describe('init', () => {
    let tmpDir: string;
    let gitDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-init-test-'));
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

    describe('detectRemote', () => {
        beforeEach(() => {
            gitDir = path.join(tmpDir, '.git');
            fs.mkdirSync(gitDir);
        });

        it('returns vendor and the full url, including urls that contain "="', () => {
            const url = 'https://dev.azure.com/org/proj/_git/repo?version=GBmain';
            fs.writeFileSync(path.join(gitDir, 'config'), `[remote "origin"]\n\turl = ${url}\n`);
            expect(detectRemote(tmpDir)).toEqual({ vendor: 'azure_devops', url });
        });

        it('returns null for unknown hosts', () => {
            fs.writeFileSync(path.join(gitDir, 'config'), 'url = https://gitlab.com/user/repo.git');
            expect(detectRemote(tmpDir)).toBeNull();
        });

        it('handles .git file without space after gitdir colon', () => {
            fs.rmSync(gitDir, { recursive: true });
            const realGitDir = path.join(tmpDir, 'realgit');
            fs.mkdirSync(realGitDir);
            fs.writeFileSync(path.join(realGitDir, 'config'), 'url = https://github.com/user/repo.git');
            fs.writeFileSync(gitDir, `gitdir:${realGitDir}\n`);
            expect(detectRemote(tmpDir)).toEqual({ vendor: 'github', url: 'https://github.com/user/repo.git' });
        });
    });
});
