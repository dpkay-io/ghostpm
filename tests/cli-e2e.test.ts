import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync, SpawnSyncReturns } from 'child_process';
import { openLedger, LEDGER_FILE } from '../src/ledger/db';
import { ensureWorkspace } from '../src/ledger/workspaces';
import { createTask } from '../src/ledger/tasks';
import { startSession, setSessionTask } from '../src/ledger/sessions';
import { TaskRow, formatTaskId } from '../src/ledger/types';
import { SINCE_HELP } from '../src/surfaces/since';
import { removeTempDir } from './temp-dir';

const CLI = path.join(__dirname, '..', 'dist', 'cli-main.js');
// The built CLI is what users run; `npm run build` must run first.
const describeBuilt = fs.existsSync(CLI) ? describe : describe.skip;
const TASK_TITLE = 'Seeded task';
const SESSION_ID = 'cli-e2e';
const HOOK_CLIENT = 'claude-code';
const ESCAPE = '\u001b[';
const EXIT_OK = 0;
const EXIT_FAILURE = 1;

describeBuilt('ghostpm CLI on the ledger', () => {
    let root: string;
    let ghostpmHome: string;
    let workspace: string;
    let env: NodeJS.ProcessEnv;

    const cli = (cliArgs: string[], cwd: string = workspace): SpawnSyncReturns<string> =>
        spawnSync(process.execPath, [CLI, ...cliArgs], { env, cwd, input: '', encoding: 'utf8' });

    /** Writes through the source ledger code, as a hook or the MCP server would. */
    const seed = (): TaskRow => {
        const db = openLedger(path.join(ghostpmHome, LEDGER_FILE));
        try {
            const workspaceId = ensureWorkspace(db, workspace).id;
            const task = createTask(db, { title: TASK_TITLE, phase: 'in_progress', workspaceId, origin: 'local', source: 'test' });
            startSession(db, { id: SESSION_ID, client: HOOK_CLIENT, cwd: workspace, workspaceId });
            setSessionTask(db, SESSION_ID, task.id);
            return task;
        } finally {
            db.close();
        }
    };

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-cli-'));
        const home = path.join(root, 'home');
        ghostpmHome = path.join(home, '.ghostpm');
        workspace = path.join(root, 'project');
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(workspace);
        env = { ...process.env, HOME: home, USERPROFILE: home, GHOSTPM_HOME: ghostpmHome, TEMP: root, TMP: root, TMPDIR: root };
    });

    afterEach(() => {
        removeTempDir(root);
    });

    it('prints one plain dashboard snapshot when stdout is not a terminal (Review Focus 1)', () => {
        const task = seed();

        const result = cli(['dashboard']);

        expect(result.status).toBe(EXIT_OK);
        expect(result.stdout).toContain('LIVE SESSIONS (1)');
        expect(result.stdout).toContain(`${formatTaskId(task.id)} ${TASK_TITLE}`);
        expect(result.stdout).not.toContain(ESCAPE);
    });

    it('explains a missing ledger instead of creating one', () => {
        const result = cli(['dashboard']);

        expect(result.status).toBe(EXIT_FAILURE);
        expect(result.stderr).toContain('No GhostPM ledger');
        expect(fs.existsSync(ghostpmHome)).toBe(false);
    });

    it('reports what happened since a duration and rejects a --since it cannot read (Review Focus 3)', () => {
        const task = seed();

        const report = cli(['standup', '--since', '1h']);
        expect(report.status).toBe(EXIT_OK);
        expect(report.stdout).toContain(`${formatTaskId(task.id)} ${TASK_TITLE} · in_progress`);

        expect(cli(['standup', '--since=yesterday']).status).toBe(EXIT_OK);

        const refused = cli(['standup', '--since', 'last', 'tuesday']);
        expect(refused.status).toBe(EXIT_FAILURE);
        expect(refused.stderr).toContain(SINCE_HELP);

        const missing = cli(['standup', '--since']);
        expect(missing.status).toBe(EXIT_FAILURE);
        expect(missing.stderr).toContain('--since needs a value.');
    });
});
