import * as fs from 'fs';
import * as path from 'path';
import { tempLedger, TempLedger } from './ledger/helpers';
import { normalizePath } from '../src/ledger/workspaces';
import { runConfigCommand, CONFIG_USAGE } from '../src/config-cli';

describe('ghostpm config', () => {
    let ledger: TempLedger;
    let repo: string;
    let elsewhere: string;

    const config = (...argv: string[]): string => runConfigCommand(ledger.db, argv, repo);

    beforeEach(() => {
        ledger = tempLedger();
        repo = path.join(ledger.dir, 'repo');
        elsewhere = path.join(ledger.dir, 'elsewhere');
        fs.mkdirSync(repo);
        fs.mkdirSync(elsewhere);
    });

    afterEach(() => ledger.cleanup());

    it('shows the default and says so', () => {
        expect(config('get', 'sync_policy')).toBe('sync_policy = "off" (default)');
    });

    it('sets and unsets a global value', () => {
        expect(config('set', 'sync_policy', 'promote')).toBe('sync_policy = "promote" (global)');
        expect(config('get', 'sync_policy')).toBe('sync_policy = "promote" (global)');
        expect(config('unset', 'sync_policy')).toBe('sync_policy unset (global)');
        expect(config('get', 'sync_policy')).toBe('sync_policy = "off" (default)');
    });

    it('overrides a setting for one workspace only', () => {
        const label = `workspace ${normalizePath(repo)}`;
        expect(config('set', 'sync_policy', 'linked-only', '--workspace', repo)).toBe(`sync_policy = "linked-only" (${label})`);
        expect(config('get', 'sync_policy')).toBe(`sync_policy = "linked-only" (${label})`);
        expect(runConfigCommand(ledger.db, ['get', 'sync_policy'], elsewhere)).toBe('sync_policy = "off" (default)');
        expect(config('unset', 'sync_policy', '--workspace', repo)).toBe(`sync_policy unset (${label})`);
    });

    it('keeps workspace-only settings on the folder it is run in', () => {
        expect(config('set', 'ado_work_item_type', 'Product Backlog Item'))
            .toBe(`ado_work_item_type = "Product Backlog Item" (workspace ${normalizePath(repo)})`);
        expect(runConfigCommand(ledger.db, ['get', 'ado_work_item_type'], elsewhere)).toBe('ado_work_item_type = "Task" (default)');
    });

    it('takes several values for a list, and phase=State pairs for the phase map', () => {
        expect(config('set', 'plan_globs', 'docs/**/*.md', 'notes/*.md')).toBe('plan_globs = ["docs/**/*.md","notes/*.md"] (global)');
        expect(config('set', 'phase_state_map', 'planned=To Do', 'in_progress=Doing', 'done=Done'))
            .toBe(`phase_state_map = {"planned":"To Do","in_progress":"Doing","done":"Done"} (workspace ${normalizePath(repo)})`);
    });

    it('refuses --workspace on a global-only setting', () => {
        expect(() => config('set', 'sync_pull_minutes', '2', '--workspace', repo))
            .toThrow('sync_pull_minutes is a global setting; drop --workspace.');
    });

    it('rejects unknown settings and bad values, naming what is allowed', () => {
        expect(() => config('get', 'nope')).toThrow(/Unknown setting "nope"\. Settings: sync_policy, /);
        expect(() => config('set', 'sync_policy', 'sometimes'))
            .toThrow('Invalid value for sync_policy: must be one of: auto, promote, linked-only, off');
    });

    it('refuses a --workspace folder that does not exist', () => {
        const missing = path.join(ledger.dir, 'missing');
        expect(() => config('set', 'sync_policy', 'auto', '--workspace', missing)).toThrow(`No such folder: ${missing}`);
    });

    it('prints usage for an unknown action or a missing key', () => {
        expect(() => config('list', 'sync_policy')).toThrow(CONFIG_USAGE);
        expect(() => config('get')).toThrow(CONFIG_USAGE);
        expect(() => config('get', 'sync_policy', '--workspace')).toThrow(CONFIG_USAGE);
    });
});
