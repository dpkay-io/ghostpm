// tests/surfaces/dashboard.test.ts
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import {
    tempLedger, TempLedger, seedOutboxRow, seedLease,
} from '../ledger/helpers';
import { STATUS_FAILED } from '../../src/ledger/projection';
import { LEDGER_FILE, MS_PER_DAY, MS_PER_MINUTE, openLedgerReadOnly } from '../../src/ledger/db';
import { ensureWorkspace, setWorkspaceVendor } from '../../src/ledger/workspaces';
import { createTask } from '../../src/ledger/tasks';
import { recordEvent } from '../../src/ledger/events';
import { endSession, setSessionTask, startSession } from '../../src/ledger/sessions';
import { SETTING_SYNC_POLICY, SYNC_POLICY_AUTO, setSyncPause, setWorkspaceSetting } from '../../src/ledger/settings';
import { Phase, formatTaskId } from '../../src/ledger/types';
import {
    CROSS_MARKER, DashboardLine, buildSnapshot, dashboardText, fitToScreen, paint, renderDashboard,
} from '../../src/surfaces/dashboard';
import { visibleLength } from '../../src/surfaces/text';

const ESCAPE = '\u001b[';
const TWO_DAYS_MS = 2 * MS_PER_DAY;

describe('dashboard snapshot', () => {
    let ledger: TempLedger;
    let alpha: number;
    let beta: number;
    let alphaDir: string;
    let betaDir: string;

    const task = (title: string, workspaceId: number, phase: Phase = 'planned') =>
        createTask(ledger.db, { title, phase, workspaceId, origin: 'local', source: 'test' });

    beforeEach(() => {
        ledger = tempLedger();
        alphaDir = path.join(ledger.dir, 'alpha');
        betaDir = path.join(ledger.dir, 'beta');
        fs.mkdirSync(alphaDir);
        fs.mkdirSync(betaDir);
        alpha = ensureWorkspace(ledger.db, alphaDir).id;
        beta = ensureWorkspace(ledger.db, betaDir).id;
    });

    afterEach(() => ledger.cleanup());

    it('lists live sessions with their workspace and task, and drops ended ones', () => {
        const active = task('Login fix', alpha, 'in_progress');
        startSession(ledger.db, { id: 'live', client: 'claude-code', cwd: alphaDir, workspaceId: alpha });
        setSessionTask(ledger.db, 'live', active.id);
        startSession(ledger.db, { id: 'gone', client: 'mcp', cwd: betaDir, workspaceId: beta });
        endSession(ledger.db, 'gone');

        const { sessions } = buildSnapshot(ledger.db);

        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
            client: 'claude-code', workspace: 'alpha', task: `${formatTaskId(active.id)} Login fix · in_progress`,
        });
    });

    it('counts tasks per workspace and phase, and hides workspaces with nothing to show', () => {
        task('One', alpha, 'planned');
        task('Two', alpha, 'in_progress');
        task('Three', alpha, 'in_progress');

        const snapshot = buildSnapshot(ledger.db);

        expect(snapshot.workspaces.map(workspace => workspace.label)).toEqual(['alpha']);
        expect(snapshot.workspaces[0].counts).toMatchObject({ planned: 1, in_progress: 2, done: 0 });
        expect(snapshot.hiddenWorkspaces).toBe(1);
        expect(dashboardText(ledger.db)).toContain('+1 workspace(s) with no tasks and no live session');
    });

    it('shows sync health, the pause reason and the runner from Phase 3', () => {
        setWorkspaceVendor(ledger.db, alpha, 'github');
        setWorkspaceSetting(ledger.db, alpha, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);
        seedOutboxRow(ledger.db, task('Failing', alpha).id, STATUS_FAILED);
        setSyncPause(ledger.db, alpha, 'gh is not logged in');
        task('Local only', beta);
        seedLease(ledger.db, 'mcp:4242', new Date(Date.now() + MS_PER_MINUTE).toISOString());

        const lines = renderDashboard(buildSnapshot(ledger.db));
        const alphaRow = lines.find(line => line.text.indexOf('alpha') >= 0 && line.text.indexOf('failed') >= 0)!;
        const betaRow = lines.find(line => line.text.indexOf('beta') >= 0)!;

        expect(alphaRow.text).toContain('1 failed · paused: gh is not logged in');
        expect(alphaRow.tone).toBe('warn');
        expect(betaRow.text).toContain('off (no GitHub or Azure DevOps remote)');
        expect(lines[0].text).toContain('runner mcp:4242');
    });

    it('reads off, not ok, for a vendor workspace left at the default sync_policy', () => {
        setWorkspaceVendor(ledger.db, alpha, 'github');
        task('Linked', alpha);

        const alphaRow = renderDashboard(buildSnapshot(ledger.db)).find(line => line.text.indexOf('alpha') >= 0 && line.text.indexOf(' off') >= 0)!;

        expect(alphaRow.text).toContain('off (sync_policy off;');
        expect(alphaRow.text).not.toContain(' ok');
    });

    it('flags a task touched from another workspace (spec §9.3)', () => {
        const owned = task('Shared work', alpha);
        startSession(ledger.db, { id: 'from-beta', client: 'claude-code', cwd: betaDir, workspaceId: beta });
        startSession(ledger.db, { id: 'from-alpha', client: 'claude-code', cwd: alphaDir, workspaceId: alpha });
        recordEvent(ledger.db, { taskId: owned.id, kind: 'progress', source: 'test', sessionId: 'from-beta', payload: { intent: 'fix', note: 'from beta' } });
        recordEvent(ledger.db, { taskId: owned.id, kind: 'progress', source: 'test', sessionId: 'from-alpha', payload: { intent: 'fix', note: 'from alpha' } });

        const snapshot = buildSnapshot(ledger.db);
        const text = renderDashboard(snapshot).map(line => line.text).join('\n');

        expect(snapshot.crossWorkspace).toEqual([{ taskId: owned.id, title: 'Shared work', owner: 'alpha', from: ['beta'] }]);
        expect(text).toContain(`${CROSS_MARKER} ${formatTaskId(owned.id)} Shared work (alpha) ← beta`);
        expect(text).toContain(`${CROSS_MARKER} ${formatTaskId(owned.id)} Shared work · fix: from beta`);
        expect(text).not.toContain(`${CROSS_MARKER} ${formatTaskId(owned.id)} Shared work · fix: from alpha`);
    });

    it('prints hook evidence through the shared renderer, newest first, last day only (gap N1)', () => {
        const worked = task('Login fix', alpha);
        recordEvent(ledger.db, { taskId: worked.id, kind: 'comment', source: 'test', payload: { text: 'too old' } }, new Date(Date.now() - TWO_DAYS_MS).toISOString());
        recordEvent(ledger.db, { taskId: worked.id, kind: 'progress', source: 'hook:claude-code', payload: { files: ['src/a.ts'] } });
        recordEvent(ledger.db, { taskId: worked.id, kind: 'pr', source: 'hook:claude-code', payload: { url: 'https://github.com/acme/app/pull/7' } });

        const recent = buildSnapshot(ledger.db).recent.map(entry => entry.kind);
        const text = dashboardText(ledger.db);

        expect(recent).toEqual(['pr', 'progress', 'created']);
        expect(text).toContain('edited 1 file: a.ts');
        expect(text).toContain('PR https://github.com/acme/app/pull/7');
        expect(text).not.toContain('too old');
        expect(text).not.toContain('undefined');
    });
});

describe('fitting the dashboard to a terminal (Review Focus 1)', () => {
    const tall: DashboardLine[] = Array.from({ length: 30 }, (_, index) => ({ text: `line ${index} ${'x'.repeat(100)}`, tone: 'normal' as const }));

    it('keeps every line within the width and the frame within the height of a tiny terminal', () => {
        const fitted = fitToScreen(tall, { columns: 20, rows: 6 });

        expect(fitted).toHaveLength(6);
        fitted.forEach(line => expect(visibleLength(line.text)).toBeLessThanOrEqual(20));
        expect(fitted[5].text).toContain('25 more lines');
    });

    it('leaves a frame that already fits untouched', () => {
        const short: DashboardLine[] = [{ text: 'a', tone: 'title' }, { text: 'b', tone: 'normal' }];
        expect(fitToScreen(short, { columns: 80, rows: 24 })).toEqual(short);
    });

    it('survives a terminal reporting zero size', () => {
        expect(fitToScreen(tall, { columns: 0, rows: 0 })).toHaveLength(1);
    });
});

describe('paint', () => {
    it('adds escape codes only when asked for colour', () => {
        const warn: DashboardLine = { text: '1 failed', tone: 'warn' };
        expect(paint(warn, false)).toBe('1 failed');
        expect(paint(warn, true).indexOf(ESCAPE)).toBe(0);
        expect(paint({ text: '', tone: 'warn' }, true)).toBe('');
        expect(paint({ text: 'plain', tone: 'normal' }, true)).toBe('plain');
    });
});

/** Takes the write lock, writes without committing, and holds it for argv[3] ms. */
const HOLD_WRITE_LOCK = `
const Database = require(process.argv[1]);
const db = new Database(process.argv[2]);
db.pragma('busy_timeout = 5000');
db.exec('BEGIN IMMEDIATE');
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('held', '1')").run();
process.stdout.write('locked\\n');
setTimeout(() => { db.exec('COMMIT'); db.close(); }, Number(process.argv[3]));
`;
const HOLD_MS = 3000;
/** Far below busy_timeout (5000 ms): a reader that waited on the lock could not finish this fast. */
const READ_BUDGET_MS = 1000;
const LOCK_TEST_TIMEOUT_MS = 20000;

describe('reading while a writer holds the lock (Review Focus 2, spec §15)', () => {
    it('builds a snapshot at once, from committed data only', async () => {
        const ledger = tempLedger();
        try {
            const dir = path.join(ledger.dir, 'alpha');
            fs.mkdirSync(dir);
            createTask(ledger.db, { title: 'Committed', phase: 'planned', workspaceId: ensureWorkspace(ledger.db, dir).id, origin: 'local', source: 'test' });
            const file = path.join(ledger.dir, LEDGER_FILE);

            const holder = spawn(process.execPath, ['-e', HOLD_WRITE_LOCK, require.resolve('better-sqlite3'), file, String(HOLD_MS)], { stdio: ['ignore', 'pipe', 'inherit'] });
            const exited = new Promise(resolve => holder.once('exit', resolve));
            await new Promise<void>(resolve => holder.stdout!.once('data', () => resolve()));

            const reader = openLedgerReadOnly(file);
            try {
                const started = Date.now();
                const snapshot = buildSnapshot(reader);
                expect(Date.now() - started).toBeLessThan(READ_BUDGET_MS);
                expect(snapshot.workspaces.map(workspace => workspace.label)).toEqual(['alpha']);
            } finally {
                reader.close();
            }
            await exited;
        } finally {
            ledger.cleanup();
        }
    }, LOCK_TEST_TIMEOUT_MS);
});
