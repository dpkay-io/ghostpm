import * as fs from 'fs';
import * as path from 'path';
import { findGitRoot, detectRemote } from '../src/init';
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

        it('returns null when the repository has no config', () => {
            expect(detectRemote(tmpDir)).toBeNull();
        });

        it('reads a *.visualstudio.com remote as Azure DevOps', () => {
            const url = 'https://user.visualstudio.com/repo';
            fs.writeFileSync(path.join(gitDir, 'config'), `url = ${url}`);
            expect(detectRemote(tmpDir)).toEqual({ vendor: 'azure_devops', url });
        });

        it('returns null for a worktree whose git folder has no config', () => {
            fs.rmSync(gitDir, { recursive: true });
            fs.writeFileSync(gitDir, `gitdir: ${path.join(tmpDir, 'realgit')}`);
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
