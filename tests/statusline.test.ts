import * as fs from 'fs';
import * as path from 'path';
import { tempLedger, TempLedger } from './ledger/helpers';
import { ensureWorkspace } from '../src/ledger/workspaces';
import { createTask } from '../src/ledger/tasks';
import { startSession, setSessionTask } from '../src/ledger/sessions';
import { Phase, TaskRow } from '../src/ledger/types';
import { buildStatusline, RunPrevious, SEPARATOR, TASK_MARKER } from '../src/statusline';

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

    beforeEach(() => {
        ledger = tempLedger();
        repo = path.join(ledger.dir, 'repo');
        fs.mkdirSync(repo, { recursive: true });
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
});
