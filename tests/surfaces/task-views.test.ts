import * as fs from 'fs';
import * as path from 'path';
import { tempLedger, TempLedger, clonedRepo, seedOutboxRow } from '../ledger/helpers';
import { LEDGER_FILE, SCHEMA_VERSION } from '../../src/ledger/db';
import { ensureWorkspace, getWorkspace } from '../../src/ledger/workspaces';
import { createTask, insertVendorLink } from '../../src/ledger/tasks';
import { STATUS_FAILED } from '../../src/ledger/projection';
import {
    SETTING_ACTIVE_SPRINT, SETTING_CURRENT_USER, SETTING_LAST_SYNC, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO, setSyncPause,
    setWorkspaceSetting,
} from '../../src/ledger/settings';
import { Phase, formatTaskId } from '../../src/ledger/types';
import { ELLIPSIS, cleanText, formatDateTime } from '../../src/surfaces/text';
import { MAX_CELL_WIDTH, phaseSummary, renderStatus, renderTaskList, taskCell } from '../../src/surfaces/task-views';
import { HOSTILE, NOT_ONE_LINE, TERMINAL_CONTROL } from '../hostile-text';

describe('task views', () => {
    let ledger: TempLedger;
    let here: number;
    let there: number;

    const task = (title: string, workspaceId: number, phase: Phase = 'planned') =>
        createTask(ledger.db, { title, phase, workspaceId, origin: 'local', source: 'test' });

    beforeEach(() => {
        ledger = tempLedger();
        const otherDir = path.join(ledger.dir, 'other');
        fs.mkdirSync(otherDir);
        here = ensureWorkspace(ledger.db, ledger.dir).id;
        there = ensureWorkspace(ledger.db, otherDir).id;
    });

    afterEach(() => ledger.cleanup());

    it('lists open tasks with a header and says how many closed ones it left out', () => {
        const open = task('Login fix', here, 'in_progress');
        task('Shipped', here, 'done');
        task('Abandoned', here, 'dropped');
        insertVendorLink(ledger.db, { taskId: open.id, vendor: 'github', remoteId: '42' });

        const lines = renderTaskList(ledger.db, here).split('\n');

        expect(lines[0]).toMatch(/^ID\s+PHASE\s+TITLE\s+ASSIGNEE\s+REMOTE$/);
        expect(lines[1]).toContain(`${formatTaskId(open.id)}`);
        expect(lines[1]).toContain('#42');
        expect(lines[1].indexOf('in_progress')).toBe(lines[0].indexOf('PHASE'));
        expect(lines[lines.length - 1]).toBe('2 done or dropped not shown.');
    });

    it('truncates long titles', () => {
        task('x'.repeat(MAX_CELL_WIDTH + 20), here);
        expect(renderTaskList(ledger.db, here)).toContain(`${'x'.repeat(MAX_CELL_WIDTH - 1)}${ELLIPSIS}`);
    });

    it('prints a title with a newline or escape code on one clean line', () => {
        task('line one\nline two \u001b[31mred', here);
        const lines = renderTaskList(ledger.db, here).split('\n');
        expect(lines).toHaveLength(2);
        expect(lines[1]).toContain('line one line two');
        expect(lines[1]).not.toContain('\u001b');
    });

    it('gives every table the cleaned cell: no escape, bidi control or line break from the vendor', () => {
        const hostile = createTask(ledger.db, { title: HOSTILE, phase: 'planned', workspaceId: here, origin: 'vendor', source: 'test', assignee: HOSTILE });
        insertVendorLink(ledger.db, { taskId: hostile.id, vendor: 'github', remoteId: HOSTILE });

        (['title', 'assignee', 'remote'] as const).forEach(column => expect(taskCell(ledger.db, hostile, column)).not.toMatch(NOT_ONE_LINE));
        expect(taskCell(ledger.db, hostile, 'title')).toBe(cleanText(HOSTILE));
    });

    it('adds the workspace column when listing every workspace', () => {
        task('Here', here);
        task('There', there);
        const list = renderTaskList(ledger.db, undefined);
        expect(list.split('\n')[0]).toMatch(/WORKSPACE$/);
        expect(list).toContain('other');
    });

    it('says so when there is nothing open', () => {
        expect(renderTaskList(ledger.db, here)).toBe('No open tasks.');
    });

    it('summarises phases in phase order', () => {
        const tasks = [task('a', here, 'in_progress'), task('b', here, 'planned'), task('c', here, 'in_progress')];
        expect(phaseSummary(tasks)).toBe('1 planned, 2 in_progress');
    });

    it('reports status for a workspace from the ledger alone', () => {
        task('a', here, 'planned');
        task('b', here, 'in_progress');
        const file = path.join(ledger.dir, LEDGER_FILE);

        const status = renderStatus(ledger.db, getWorkspace(ledger.db, here)!, file);

        expect(status).toContain(`Workspace: ${getWorkspace(ledger.db, here)!.path}`);
        expect(status).toContain('Vendor:    none');
        expect(status).toContain('Tasks:     2 total (1 planned, 1 in_progress)');
        expect(status).toContain('Sync:      off (no GitHub or Azure DevOps remote)');
        expect(status).toContain('Last pull: never');
        expect(status).toContain('Runner:    none');
        expect(status).toContain(`Ledger:    ${file} (schema ${SCHEMA_VERSION})`);
    });

    it('prints what the vendor named (user, sprint, pause reason) on one clean line each', () => {
        const repo = ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'gh'));
        setWorkspaceSetting(ledger.db, repo.id, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);
        setWorkspaceSetting(ledger.db, repo.id, SETTING_CURRENT_USER, HOSTILE);
        setWorkspaceSetting(ledger.db, repo.id, SETTING_ACTIVE_SPRINT, HOSTILE);
        setSyncPause(ledger.db, repo.id, HOSTILE);

        const status = renderStatus(ledger.db, repo, path.join(ledger.dir, LEDGER_FILE));

        expect(status).not.toMatch(TERMINAL_CONTROL);
        expect(status).toContain(`User:      ${cleanText(HOSTILE)}\n`);
        expect(status).toContain(`Sprint:    ${cleanText(HOSTILE)}\n`);
        expect(status).toContain(`Sync:      paused: ${cleanText(HOSTILE)}\n`);
    });

    it('shows the sync policy with its source, the shared sync wording and the last pull', () => {
        const repo = ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'gh'));
        const file = path.join(ledger.dir, LEDGER_FILE);
        const atDefault = renderStatus(ledger.db, repo, file);
        expect(atDefault).toContain('Policy:    off (default)');
        expect(atDefault).toContain('Sync:      off (');
        expect(atDefault).not.toContain('Sync:      ok');

        setWorkspaceSetting(ledger.db, repo.id, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);
        const pulled = new Date(2026, 8, 30, 9, 5);
        setWorkspaceSetting(ledger.db, repo.id, SETTING_LAST_SYNC, pulled.toISOString());
        seedOutboxRow(ledger.db, task('Stuck', repo.id).id, STATUS_FAILED);
        setSyncPause(ledger.db, repo.id, 'gh is not logged in');

        const status = renderStatus(ledger.db, repo, file);

        expect(status).toContain('Policy:    auto (workspace)');
        expect(status).toContain('Sync:      1 failed · paused: gh is not logged in');
        expect(status).toContain(`Last pull: ${formatDateTime(pulled)}`);
    });
});
