import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getGhostpmHome, getWorkspaces, REGISTRY_FILE } from '../src/registry';
import { removeTempDir } from './temp-dir';

describe('registry (read-only since 2.0)', () => {
    let originalHome: string | undefined;
    let tmpHome: string;

    beforeEach(() => {
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-reg-'));
        originalHome = process.env.GHOSTPM_HOME;
        process.env.GHOSTPM_HOME = tmpHome;
    });

    afterEach(() => {
        if (originalHome !== undefined) process.env.GHOSTPM_HOME = originalHome;
        else delete process.env.GHOSTPM_HOME;
        removeTempDir(tmpHome);
    });

    it('resolves the home from GHOSTPM_HOME', () => {
        expect(getGhostpmHome()).toBe(tmpHome);
    });

    it('returns nothing when there is no registry', () => {
        expect(getWorkspaces()).toEqual([]);
    });

    it('reads the 1.4.0 registry', () => {
        fs.writeFileSync(path.join(tmpHome, REGISTRY_FILE), JSON.stringify([{ path: '/projects/app', vendor: 'github', addedAt: '2026-08-01T00:00:00.000Z' }]));
        expect(getWorkspaces().map(workspace => workspace.path)).toEqual(['/projects/app']);
    });

    it('treats an unreadable registry as empty', () => {
        fs.writeFileSync(path.join(tmpHome, REGISTRY_FILE), '{ nope');
        expect(getWorkspaces()).toEqual([]);
    });
});
