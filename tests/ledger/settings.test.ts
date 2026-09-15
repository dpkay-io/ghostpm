import { tempLedger, TempLedger } from './helpers';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import {
    getSetting, setSetting, getWorkspaceSetting, setWorkspaceSetting, resolveSetting,
    SETTING_CREATE_BRANCH, SETTING_ACTIVE_SPRINT,
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
});
