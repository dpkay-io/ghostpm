import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync, SpawnSyncReturns } from 'child_process';
import Database from 'better-sqlite3';
import { openLedger, LEDGER_FILE } from '../src/ledger/db';
import { ensureWorkspace, normalizePath } from '../src/ledger/workspaces';
import { createTask } from '../src/ledger/tasks';
import { startSession, setSessionTask } from '../src/ledger/sessions';
import { TaskRow, formatTaskId } from '../src/ledger/types';
import { NOT_A_WORKSPACE } from '../src/surfaces/task-views';
import { SINCE_HELP } from '../src/surfaces/since';
import { LEGACY_CONFIG_FILE } from '../src/ledger/legacy-import';
import { FLAG_YES } from '../src/cli-args';
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
/** SQLite's rollback-journal mode, as `PRAGMA journal_mode` names it. */
const DELETE_JOURNAL = 'delete';

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

    it('lists this workspace tasks and status from the ledger', () => {
        const task = seed();

        const tasks = cli(['tasks']);
        expect(tasks.status).toBe(EXIT_OK);
        expect(tasks.stdout).toContain(`${formatTaskId(task.id)}`);
        expect(tasks.stdout).toContain(TASK_TITLE);

        const status = cli(['status']);
        expect(status.status).toBe(EXIT_OK);
        expect(status.stdout).toContain('Tasks:     1 total (1 in_progress)');
    });

    it('says a folder is not a workspace instead of registering it', () => {
        seed();
        const elsewhere = path.join(root, 'elsewhere');
        fs.mkdirSync(elsewhere);

        const result = cli(['status'], elsewhere);

        expect(result.status).toBe(EXIT_OK);
        expect(result.stdout).toContain(NOT_A_WORKSPACE);
        const db = openLedger(path.join(ghostpmHome, LEDGER_FILE));
        try {
            expect(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 1 });
        } finally {
            db.close();
        }
    });

    it('registers a GitHub workspace on init without writing .mcp-pm.yml', () => {
        fs.mkdirSync(path.join(workspace, '.git'));
        fs.writeFileSync(path.join(workspace, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/app.git\n');

        const result = cli(['init']);

        expect(result.status).toBe(EXIT_OK);
        expect(result.stdout).toContain('Vendor:    github');
        expect(fs.existsSync(path.join(workspace, LEGACY_CONFIG_FILE))).toBe(false);
        expect(cli(['status']).stdout).toContain('github (https://github.com/acme/app.git)');
    });

    it('forgets a workspace only after --yes', () => {
        seed();

        const dryRun = cli(['unregister']);
        expect(dryRun.status).toBe(EXIT_OK);
        expect(dryRun.stdout).toContain(FLAG_YES);
        expect(cli(['tasks']).stdout).toContain(TASK_TITLE);

        const confirmed = cli(['unregister', FLAG_YES]);
        expect(confirmed.status).toBe(EXIT_OK);
        expect(cli(['status']).stdout).toContain(NOT_A_WORKSPACE);
    });

    it('previews an unregister without creating a ledger that does not exist', () => {
        const result = cli(['unregister']);

        expect(result.status).toBe(EXIT_FAILURE);
        expect(result.stderr).toContain('No GhostPM ledger');
        expect(fs.existsSync(ghostpmHome)).toBe(false);
    });

    it('previews an unregister through a read-only connection', () => {
        seed();
        const ledgerFile = path.join(ghostpmHome, LEDGER_FILE);
        // A write connection switches the ledger to WAL as it opens; a reader leaves the journal mode alone.
        const plain = new Database(ledgerFile);
        plain.pragma(`journal_mode = ${DELETE_JOURNAL}`);
        plain.close();

        const preview = cli(['unregister']);

        expect(preview.status).toBe(EXIT_OK);
        expect(preview.stdout).toContain(FLAG_YES);
        const after = new Database(ledgerFile, { readonly: true });
        try {
            expect(after.pragma('journal_mode', { simple: true })).toBe(DELETE_JOURNAL);
        } finally {
            after.close();
        }
        expect(cli(['tasks']).stdout).toContain(TASK_TITLE);
    });

    it('unregisters a nested repo whose folder is gone, and never the repo around it (preview too)', () => {
        fs.mkdirSync(path.join(workspace, '.git'));
        seed();
        const nested = path.join(workspace, 'nested');
        fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
        expect(cli(['init'], nested).status).toBe(EXIT_OK);
        fs.rmSync(nested, { recursive: true, force: true });

        const preview = cli(['unregister', nested]);
        expect(preview.status).toBe(EXIT_OK);
        expect(preview.stdout).toContain(`ghostpm unregister "${normalizePath(nested)}" ${FLAG_YES}`);

        const confirmed = cli(['unregister', nested, FLAG_YES]);
        expect(confirmed.status).toBe(EXIT_OK);
        expect(confirmed.stdout).toContain(`Forgot ${normalizePath(nested)}:`);
        const db = openLedger(path.join(ghostpmHome, LEDGER_FILE));
        try {
            expect((db.prepare('SELECT path FROM workspaces').all() as { path: string }[]).map(row => row.path)).toEqual([normalizePath(workspace)]);
        } finally {
            db.close();
        }
        expect(cli(['tasks']).stdout).toContain(TASK_TITLE);
    });

    it('refuses to unregister a folder that is not a workspace', () => {
        seed();
        const elsewhere = path.join(root, 'elsewhere');
        fs.mkdirSync(elsewhere);

        const result = cli(['unregister', elsewhere, FLAG_YES]);

        expect(result.status).toBe(EXIT_FAILURE);
        expect(result.stderr).toContain('No GhostPM workspace at');
        expect(cli(['tasks']).stdout).toContain(TASK_TITLE);
    });
});
