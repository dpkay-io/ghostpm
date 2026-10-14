import * as fs from 'fs';
import * as path from 'path';
import { clonedRepo, seedLease, seedOutboxRow, tempLedger, TempLedger } from '../ledger/helpers';
import { MS_PER_MINUTE } from '../../src/ledger/db';
import { STATUS_FAILED, STATUS_PENDING } from '../../src/ledger/projection';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { createTask } from '../../src/ledger/tasks';
import { SETTING_SYNC_POLICY, SYNC_POLICY_AUTO, setSyncPause, setWorkspaceSetting } from '../../src/ledger/settings';
import { WorkspaceRow } from '../../src/ledger/types';
import { syncOffHint } from '../../src/sync/schedule';
import { SYNC_OK, describeSync, machineSyncHealth, syncDescription, workspaceSyncHealth } from '../../src/surfaces/sync-health';
import { cleanText } from '../../src/surfaces/text';
import { TERMINAL_CONTROL, UNREADABLE_REMOTE } from '../hostile-text';

const RUNNER = 'mcp:4242';

describe('sync health', () => {
    let ledger: TempLedger;
    let here: number;
    let there: number;

    beforeEach(() => {
        ledger = tempLedger();
        const otherDir = path.join(ledger.dir, 'other');
        fs.mkdirSync(otherDir);
        here = ensureWorkspace(ledger.db, ledger.dir).id;
        there = ensureWorkspace(ledger.db, otherDir).id;
    });

    afterEach(() => ledger.cleanup());

    const taskIn = (workspaceId: number) =>
        createTask(ledger.db, { title: 'x', phase: 'planned', workspaceId, origin: 'local', source: 'test' });

    const githubWorkspace = (): WorkspaceRow => ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'widgets'));

    it('counts pending and failed pushes per workspace and machine-wide', () => {
        seedOutboxRow(ledger.db, taskIn(here).id, STATUS_FAILED);
        seedOutboxRow(ledger.db, taskIn(here).id, STATUS_PENDING);
        seedOutboxRow(ledger.db, taskIn(there).id, STATUS_FAILED);

        expect(workspaceSyncHealth(ledger.db, here)).toEqual({ pending: 1, failed: 1, paused: null });
        const machine = machineSyncHealth(ledger.db);
        expect(machine.pending).toBe(1);
        expect(machine.failed).toBe(2);
    });

    it('reports the pause reason Phase 3 recorded', () => {
        setSyncPause(ledger.db, here, 'gh is not logged in');
        expect(workspaceSyncHealth(ledger.db, here).paused).toBe('gh is not logged in');
    });

    it('names the runner only while its lease is current at the snapshot time', () => {
        const expiresAt = new Date(Date.now() + MS_PER_MINUTE).toISOString();
        seedLease(ledger.db, RUNNER, expiresAt);
        expect(machineSyncHealth(ledger.db).runner).toEqual({ holder: RUNNER, expiresAt });
        expect(machineSyncHealth(ledger.db, new Date(Date.parse(expiresAt) + MS_PER_MINUTE).toISOString()).runner).toBeNull();

        seedLease(ledger.db, RUNNER, new Date(Date.now() - MS_PER_MINUTE).toISOString());
        expect(machineSyncHealth(ledger.db).runner).toBeNull();
    });

    it('says sync is off, and why, before anything else (C21)', () => {
        const local = ensureWorkspace(ledger.db, ledger.dir);
        expect(describeSync(ledger.db, local)).toBe('off (no GitHub or Azure DevOps remote)');

        // A vendor workspace at the default policy reads off, not ok, even with failed rows and a pause on record.
        const github = githubWorkspace();
        seedOutboxRow(ledger.db, taskIn(github.id).id, STATUS_FAILED);
        setSyncPause(ledger.db, github.id, 'gh is not logged in');
        expect(describeSync(ledger.db, github)).toBe(`off (${syncOffHint(github.path)})`);
    });

    it('describes a syncing workspace in words', () => {
        const github = githubWorkspace();
        setWorkspaceSetting(ledger.db, github.id, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);
        expect(describeSync(ledger.db, github)).toBe(SYNC_OK);

        seedOutboxRow(ledger.db, taskIn(github.id).id, STATUS_PENDING);
        seedOutboxRow(ledger.db, taskIn(github.id).id, STATUS_PENDING);
        seedOutboxRow(ledger.db, taskIn(github.id).id, STATUS_FAILED);
        setSyncPause(ledger.db, github.id, 'az login');
        expect(describeSync(ledger.db, github)).toBe('2 pending · 1 failed · paused: az login');
    });

    it('says a remote sync cannot read is not recognised, naming it cleaned, instead of ok', () => {
        const odd = ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'odd', UNREADABLE_REMOTE));
        setWorkspaceSetting(ledger.db, odd.id, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);
        expect(odd.vendor).toBe('github');

        const said = describeSync(ledger.db, odd);

        expect(said).not.toBe(SYNC_OK);
        expect(said).toContain('not recognised');
        expect(said).toContain(cleanText(UNREADABLE_REMOTE));
        expect(said).not.toMatch(TERMINAL_CONTROL);
        expect(syncDescription(ledger.db, odd).state).not.toBe(SYNC_OK);
        // What is queued still shows.
        seedOutboxRow(ledger.db, taskIn(odd.id).id, STATUS_PENDING);
        expect(describeSync(ledger.db, odd)).toMatch(/^1 pending · .*not recognised/);
    });

    it('splits the wording into a short state and a detail that describeSync composes', () => {
        const github = githubWorkspace();
        expect(syncDescription(ledger.db, github)).toEqual({ state: 'off', detail: syncOffHint(github.path) });

        setWorkspaceSetting(ledger.db, github.id, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);
        expect(syncDescription(ledger.db, github)).toEqual({ state: SYNC_OK, detail: null });

        setSyncPause(ledger.db, github.id, 'az login');
        expect(syncDescription(ledger.db, github)).toEqual({ state: 'paused', detail: 'paused: az login' });
        expect(describeSync(ledger.db, github)).toBe('paused: az login');
    });
});
