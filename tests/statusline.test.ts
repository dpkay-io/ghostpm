import * as fs from 'fs';
import * as path from 'path';
import { clonedRepo, seedOutboxRow, tempLedger, TempLedger } from './ledger/helpers';
import { LEDGER_FILE, SCHEMA_VERSION } from '../src/ledger/db';
import { STATUS_FAILED } from '../src/ledger/projection';
import { ensureWorkspace } from '../src/ledger/workspaces';
import { createTask } from '../src/ledger/tasks';
import { startSession, setSessionTask } from '../src/ledger/sessions';
import {
    SETTING_PREVIOUS_STATUSLINE, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO, setSetting, setSyncPause, setWorkspaceSetting,
} from '../src/ledger/settings';
import { Phase, TaskRow } from '../src/ledger/types';
import { ELLIPSIS } from '../src/surfaces/text';
import {
    buildStatusline, runStatusline, RunPrevious, SEPARATOR, TASK_MARKER, UPDATE_HINT, WARNING_MARKER,
} from '../src/statusline';

const SESSION_ID = 'claude-statusline';
const HOOK_CLIENT = 'claude-code';
const STDIN = JSON.stringify({ session_id: SESSION_ID });

describe('buildStatusline', () => {
    let ledger: TempLedger;
    let repo: string;
    let workspaceId: number;

    const task = (title: string, phase: Phase = 'in_progress'): TaskRow =>
        createTask(ledger.db, { title, phase, workspaceId, origin: 'local', source: 'test' });

    const attach = (row: TaskRow): void => {
        startSession(ledger.db, { id: SESSION_ID, client: HOOK_CLIENT, cwd: repo, workspaceId });
        setSessionTask(ledger.db, SESSION_ID, row.id);
    };

    const build = (opts: { previousCommand?: string | null; run?: RunPrevious; stdin?: string } = {}): string =>
        buildStatusline(ledger.db, {
            stdin: opts.stdin ?? STDIN,
            previousCommand: opts.previousCommand === undefined ? 'claude-ticker' : opts.previousCommand,
            run: opts.run ?? (() => 'PREV'),
        });

    /** The default policy is off; a repo opts in. */
    const syncOn = (): void => setWorkspaceSetting(ledger.db, workspaceId, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);

    beforeEach(() => {
        ledger = tempLedger();
        repo = clonedRepo(ledger.dir, 'repo');
        workspaceId = ensureWorkspace(ledger.db, repo).id;
    });

    afterEach(() => {
        ledger.cleanup();
    });

    it('appends the active task after the previous statusline output', () => {
        const active = task('Login fix');
        attach(active);

        const line = build();

        expect(line).toBe(`PREV${SEPARATOR}${TASK_MARKER} T${active.id} Login fix · in_progress`);
    });

    it('passes the same stdin through to the previous command', () => {
        attach(task('Login fix'));
        let received: string | null = null;

        build({ run: (_command, input) => { received = input; return 'PREV'; } });

        expect(received).toBe(STDIN);
    });

    it('runs the command that was configured before ghostpm', () => {
        attach(task('Login fix'));
        let ran: string | null = null;

        build({ previousCommand: 'claude-ticker', run: command => { ran = command; return 'PREV'; } });

        expect(ran).toBe('claude-ticker');
    });

    it('returns the previous output unchanged when no task is active', () => {
        startSession(ledger.db, { id: SESSION_ID, client: HOOK_CLIENT, cwd: repo, workspaceId });

        expect(build()).toBe('PREV');
    });

    it.each(['done', 'dropped'] as Phase[])('shows no active task once it is %s', phase => {
        attach(task('Login fix', phase));

        expect(build()).toBe('PREV');
    });

    it('returns the previous output unchanged when the session is unknown', () => {
        task('Login fix');

        expect(build()).toBe('PREV');
    });

    it('prints just its own segment when nothing was configured before', () => {
        const active = task('Login fix');
        attach(active);

        const line = build({ previousCommand: null });

        expect(line).toBe(`${TASK_MARKER} T${active.id} Login fix · in_progress`);
    });

    it('still shows the task when the previous command fails', () => {
        // A broken previous command must not cost the user their statusline.
        const active = task('Login fix');
        attach(active);

        const line = build({ run: () => { throw new Error('claude-ticker exploded'); } });

        expect(line).toBe(`${TASK_MARKER} T${active.id} Login fix · in_progress`);
    });

    it('survives stdin that is not the JSON it expected', () => {
        attach(task('Login fix'));

        expect(() => build({ stdin: 'not json' })).not.toThrow();
        expect(build({ stdin: 'not json' })).toBe('PREV');
    });

    it('does not leave a dangling separator when the previous command prints nothing', () => {
        const active = task('Login fix');
        attach(active);

        const line = build({ run: () => '   ' });

        expect(line).toBe(`${TASK_MARKER} T${active.id} Login fix · in_progress`);
    });

    it('neutralises newlines and escape codes in a task title (I2)', () => {
        const bad = task('Bad\ntitle\u001b[31m red');
        attach(bad);

        const line = build();

        expect(line).toBe(`PREV${SEPARATOR}${TASK_MARKER} T${bad.id} Bad title [31m red · in_progress`);
        expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    });

    it('warns about failed pushes in the session workspace (spec §9.2)', () => {
        syncOn();
        const active = task('Login fix');
        attach(active);
        seedOutboxRow(ledger.db, active.id, STATUS_FAILED);

        expect(build()).toBe(`PREV${SEPARATOR}${TASK_MARKER} T${active.id} Login fix · in_progress ${WARNING_MARKER}1`);
    });

    it('says why sync is paused (spec §12)', () => {
        syncOn();
        attach(task('Login fix'));
        setSyncPause(ledger.db, workspaceId, 'gh is not logged in');

        expect(build()).toContain(`${WARNING_MARKER} sync paused: gh is not logged in`);
    });

    it('cuts a long pause reason short', () => {
        syncOn();
        attach(task('Login fix'));
        const reason = 'GitHub CLI is not logged in. Run `gh auth login`, then `ghostpm sync`.';
        setSyncPause(ledger.db, workspaceId, reason);

        const line = build();

        expect(line).not.toContain(reason);
        expect(line).toContain(`${WARNING_MARKER} sync paused: ${reason.slice(0, 20)}`);
        expect(line.endsWith(ELLIPSIS)).toBe(true);
    });

    it('warns even when no task is active', () => {
        syncOn();
        startSession(ledger.db, { id: SESSION_ID, client: HOOK_CLIENT, cwd: repo, workspaceId });
        seedOutboxRow(ledger.db, task('Other').id, STATUS_FAILED);

        expect(build()).toBe(`PREV${SEPARATOR}${WARNING_MARKER}1`);
    });

    it("leaves other workspaces' failures to the dashboard", () => {
        syncOn();
        startSession(ledger.db, { id: SESSION_ID, client: HOOK_CLIENT, cwd: repo, workspaceId });
        const elsewhere = ensureWorkspace(ledger.db, clonedRepo(ledger.dir, 'elsewhere')).id;
        const theirs = createTask(ledger.db, { title: 'x', phase: 'planned', workspaceId: elsewhere, origin: 'local', source: 'test' });
        seedOutboxRow(ledger.db, theirs.id, STATUS_FAILED);

        expect(build()).toBe('PREV');
    });

    it('says sync is off beside failures nothing retries there, and no pause (C61)', () => {
        startSession(ledger.db, { id: SESSION_ID, client: HOOK_CLIENT, cwd: repo, workspaceId });
        seedOutboxRow(ledger.db, task('Other').id, STATUS_FAILED);
        setSyncPause(ledger.db, workspaceId, 'gh is not logged in');

        expect(build()).toBe(`PREV${SEPARATOR}${WARNING_MARKER}1 sync off`);
    });
});

describe('runStatusline', () => {
    let ledger: TempLedger;

    beforeEach(() => {
        ledger = tempLedger();
    });

    afterEach(() => {
        ledger.cleanup();
    });

    const run = (ledgerFile: string): string =>
        runStatusline({ stdin: STDIN, ledgerFile, run: () => 'PREV' });

    it('keeps the previous statusline when the ledger is newer than this copy (gap N2, Review Focus 4)', () => {
        setSetting(ledger.db, SETTING_PREVIOUS_STATUSLINE, 'claude-ticker');
        ledger.db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);

        expect(run(path.join(ledger.dir, LEDGER_FILE))).toBe(`PREV${SEPARATOR}${UPDATE_HINT}`);
    });

    it('prints the previous output alone on a current ledger with nothing active', () => {
        setSetting(ledger.db, SETTING_PREVIOUS_STATUSLINE, 'claude-ticker');

        expect(run(path.join(ledger.dir, LEDGER_FILE))).toBe('PREV');
    });

    it('prints nothing when there is no ledger at all', () => {
        expect(run(path.join(ledger.dir, 'missing', LEDGER_FILE))).toBe('');
    });

    it('prints nothing, and does not throw, when the ledger file is not a database', () => {
        const file = path.join(ledger.dir, 'garbage', LEDGER_FILE);
        fs.mkdirSync(path.dirname(file));
        fs.writeFileSync(file, 'not a database');

        expect(run(file)).toBe('');
    });
});
