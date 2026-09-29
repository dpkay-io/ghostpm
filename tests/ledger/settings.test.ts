import { tempLedger, TempLedger } from './helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import {
    getSetting, setSetting, getWorkspaceSetting, setWorkspaceSetting, resolveSetting, readSetting, explainSetting,
    deleteSetting, getSyncPause, setSyncPause, SETTING_DEFS,
    SETTING_CREATE_BRANCH, SETTING_ACTIVE_SPRINT, SETTING_SYNC_POLICY, SETTING_PROGRESS_COMMENTS,
    SETTING_PHASE_STATE_MAP, SETTING_ADO_WORK_ITEM_TYPE, SETTING_PLAN_GLOBS, SETTING_SYNC_PULL_MINUTES,
    SETTING_STALE_SESSION_MINUTES, SETTING_MAX_PUSH_ATTEMPTS,
} from '../../src/ledger/settings';

const UNKNOWN_WORKSPACE_ID = 999;

describe('settings', () => {
    let ledger: TempLedger;
    let workspaceId: number;

    beforeEach(() => {
        ledger = tempLedger();
        workspaceId = ensureWorkspace(ledger.db, ledger.dir).id;
    });

    afterEach(() => ledger.cleanup());

    it('stores global settings as JSON values', () => {
        expect(getSetting(ledger.db, SETTING_CREATE_BRANCH)).toBeUndefined();
        setSetting(ledger.db, SETTING_CREATE_BRANCH, true);
        setSetting(ledger.db, SETTING_CREATE_BRANCH, false);
        expect(getSetting<boolean>(ledger.db, SETTING_CREATE_BRANCH)).toBe(false);
    });

    it('stores, overwrites and removes workspace settings', () => {
        setWorkspaceSetting(ledger.db, workspaceId, SETTING_ACTIVE_SPRINT, 'Sprint 1');
        setWorkspaceSetting(ledger.db, workspaceId, SETTING_ACTIVE_SPRINT, 'Sprint 2');
        expect(getWorkspaceSetting<string>(ledger.db, workspaceId, SETTING_ACTIVE_SPRINT)).toBe('Sprint 2');
        setWorkspaceSetting(ledger.db, workspaceId, SETTING_ACTIVE_SPRINT, undefined);
        expect(getWorkspaceSetting(ledger.db, workspaceId, SETTING_ACTIVE_SPRINT)).toBeUndefined();
    });

    it('throws for an unknown workspace', () => {
        expect(() => setWorkspaceSetting(ledger.db, UNKNOWN_WORKSPACE_ID, SETTING_ACTIVE_SPRINT, 'x'))
            .toThrow(`Workspace ${UNKNOWN_WORKSPACE_ID} not found`);
    });

    it('resolves workspace override, then global, then fallback', () => {
        expect(resolveSetting(ledger.db, workspaceId, SETTING_CREATE_BRANCH, false)).toBe(false);
        setSetting(ledger.db, SETTING_CREATE_BRANCH, true);
        expect(resolveSetting(ledger.db, workspaceId, SETTING_CREATE_BRANCH, false)).toBe(true);
        setWorkspaceSetting(ledger.db, workspaceId, SETTING_CREATE_BRANCH, false);
        expect(resolveSetting(ledger.db, workspaceId, SETTING_CREATE_BRANCH, true)).toBe(false);
        expect(resolveSetting(ledger.db, null, SETTING_CREATE_BRANCH, false)).toBe(true);
    });

    it('reads every spec §8.2 setting with its default when nothing is stored', () => {
        expect(readSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY)).toBe('off');
        expect(readSetting(ledger.db, workspaceId, SETTING_PROGRESS_COMMENTS)).toBe('phase');
        expect(readSetting(ledger.db, workspaceId, SETTING_CREATE_BRANCH)).toBe(false);
        expect(readSetting(ledger.db, workspaceId, SETTING_PHASE_STATE_MAP)).toEqual({});
        expect(readSetting(ledger.db, workspaceId, SETTING_ADO_WORK_ITEM_TYPE)).toBe('Task');
        expect(readSetting(ledger.db, workspaceId, SETTING_PLAN_GLOBS)).toEqual(['docs/**/{specs,plans}/**/*.md']);
        expect(readSetting(ledger.db, null, SETTING_SYNC_PULL_MINUTES)).toBe(5);
        expect(readSetting(ledger.db, null, SETTING_STALE_SESSION_MINUTES)).toBe(10);
        expect(readSetting(ledger.db, null, SETTING_MAX_PUSH_ATTEMPTS)).toBe(8);
    });

    it('respects each setting scope', () => {
        setWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_PULL_MINUTES, 1);
        setSetting(ledger.db, SETTING_ADO_WORK_ITEM_TYPE, 'Bug');
        expect(readSetting(ledger.db, workspaceId, SETTING_SYNC_PULL_MINUTES)).toBe(5);
        expect(readSetting(ledger.db, workspaceId, SETTING_ADO_WORK_ITEM_TYPE)).toBe('Task');
        setSetting(ledger.db, SETTING_SYNC_POLICY, 'promote');
        setWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY, 'linked-only');
        expect(readSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY)).toBe('linked-only');
        expect(readSetting(ledger.db, null, SETTING_SYNC_POLICY)).toBe('promote');
    });

    it('reads a stored value it cannot accept as the default', () => {
        setSetting(ledger.db, SETTING_SYNC_POLICY, 'sometimes');
        setSetting(ledger.db, SETTING_MAX_PUSH_ATTEMPTS, -1);
        setSetting(ledger.db, SETTING_PLAN_GLOBS, []);
        expect(readSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY)).toBe('off');
        expect(readSetting(ledger.db, null, SETTING_MAX_PUSH_ATTEMPTS)).toBe(8);
        expect(readSetting(ledger.db, workspaceId, SETTING_PLAN_GLOBS)).toEqual(['docs/**/{specs,plans}/**/*.md']);
    });

    it('says where the effective value comes from', () => {
        expect(explainSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY)).toEqual({ value: 'off', source: 'default' });
        setSetting(ledger.db, SETTING_SYNC_POLICY, 'promote');
        expect(explainSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY)).toEqual({ value: 'promote', source: 'global' });
        setWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY, 'linked-only');
        expect(explainSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY)).toEqual({ value: 'linked-only', source: 'workspace' });
        deleteSetting(ledger.db, SETTING_SYNC_POLICY);
        expect(getSetting(ledger.db, SETTING_SYNC_POLICY)).toBeUndefined();
    });

    it('parses command-line values and rejects bad ones with what is allowed', () => {
        expect(SETTING_DEFS[SETTING_SYNC_POLICY].parse(['promote'])).toBe('promote');
        expect(() => SETTING_DEFS[SETTING_SYNC_POLICY].parse(['sometimes'])).toThrow('must be one of: auto, promote, linked-only, off');
        expect(SETTING_DEFS[SETTING_SYNC_POLICY].parse(['off'])).toBe('off');
        expect(() => SETTING_DEFS[SETTING_SYNC_POLICY].parse(['auto', 'promote'])).toThrow('expects exactly one value');
        expect(SETTING_DEFS[SETTING_CREATE_BRANCH].parse(['true'])).toBe(true);
        expect(() => SETTING_DEFS[SETTING_CREATE_BRANCH].parse(['yes'])).toThrow('must be true or false');
        expect(SETTING_DEFS[SETTING_SYNC_PULL_MINUTES].parse(['15'])).toBe(15);
        expect(() => SETTING_DEFS[SETTING_SYNC_PULL_MINUTES].parse(['0'])).toThrow('whole number above 0');
        expect(SETTING_DEFS[SETTING_PLAN_GLOBS].parse(['docs/*.md', 'notes/**/*.md'])).toEqual(['docs/*.md', 'notes/**/*.md']);
        expect(SETTING_DEFS[SETTING_PHASE_STATE_MAP].parse(['planned=New', 'in_progress=In Progress']))
            .toEqual({ planned: 'New', in_progress: 'In Progress' });
        expect(() => SETTING_DEFS[SETTING_PHASE_STATE_MAP].parse(['later=Soon'])).toThrow('phases are brainstorming, planned');
        expect(() => SETTING_DEFS[SETTING_PHASE_STATE_MAP].parse(['planned'])).toThrow('is not phase=State');
    });

    it('pauses and resumes sync for a workspace', () => {
        expect(getSyncPause(ledger.db, workspaceId)).toBeUndefined();
        setSyncPause(ledger.db, workspaceId, 'GitHub CLI is not logged in.');
        expect(getSyncPause(ledger.db, workspaceId)).toBe('GitHub CLI is not logged in.');
        setSyncPause(ledger.db, workspaceId, undefined);
        expect(getSyncPause(ledger.db, workspaceId)).toBeUndefined();
    });
});
