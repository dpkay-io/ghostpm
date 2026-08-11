import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { registerWorkspace, unregisterWorkspace, getWorkspaces, WorkspaceEntry } from '../src/registry';

describe('registry', () => {
    let originalHome: string | undefined;
    let tmpHome: string;

    beforeEach(() => {
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-reg-'));
        originalHome = process.env.GHOSTPM_HOME;
        process.env.GHOSTPM_HOME = tmpHome;
    });

    afterEach(() => {
        if (originalHome !== undefined) {
            process.env.GHOSTPM_HOME = originalHome;
        } else {
            delete process.env.GHOSTPM_HOME;
        }
        fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it('should return empty array when no registry exists', () => {
        expect(getWorkspaces()).toEqual([]);
    });

    it('should register a workspace and retrieve it', () => {
        registerWorkspace('/projects/app', 'github');
        const workspaces = getWorkspaces();
        expect(workspaces).toHaveLength(1);
        expect(workspaces[0].path).toBe('/projects/app');
        expect(workspaces[0].vendor).toBe('github');
        expect(workspaces[0].addedAt).toBeDefined();
    });

    it('should deduplicate by path on re-register', () => {
        registerWorkspace('/projects/app', 'github');
        registerWorkspace('/projects/app', 'github');
        expect(getWorkspaces()).toHaveLength(1);
    });

    it('should update vendor on re-register', () => {
        registerWorkspace('/projects/app', 'github');
        registerWorkspace('/projects/app', 'azure_devops');
        const workspaces = getWorkspaces();
        expect(workspaces).toHaveLength(1);
        expect(workspaces[0].vendor).toBe('azure_devops');
    });

    it('should register multiple workspaces', () => {
        registerWorkspace('/projects/app1', 'github');
        registerWorkspace('/projects/app2', 'azure_devops');
        expect(getWorkspaces()).toHaveLength(2);
    });

    it('should unregister a workspace by path', () => {
        registerWorkspace('/projects/app1', 'github');
        registerWorkspace('/projects/app2', 'azure_devops');
        expect(unregisterWorkspace('/projects/app1')).toBe(true);
        const workspaces = getWorkspaces();
        expect(workspaces).toHaveLength(1);
        expect(workspaces[0].path).toBe('/projects/app2');
    });

    it('should return false when unregistering non-existent workspace', () => {
        expect(unregisterWorkspace('/projects/nonexistent')).toBe(false);
    });

    it('should create directory if it does not exist', () => {
        const deepHome = path.join(tmpHome, 'nested', 'dir');
        process.env.GHOSTPM_HOME = deepHome;
        registerWorkspace('/projects/app', 'github');
        expect(fs.existsSync(path.join(deepHome, 'workspaces.json'))).toBe(true);
    });
});
