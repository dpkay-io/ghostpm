import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync, SpawnSyncReturns } from 'child_process';
import { openLedger, LEDGER_FILE, SCHEMA_VERSION } from '../src/ledger/db';
import { ensureWorkspace } from '../src/ledger/workspaces';
import { createTask } from '../src/ledger/tasks';
import { startSession, setSessionTask } from '../src/ledger/sessions';
import { formatTaskId } from '../src/ledger/types';
import { UPDATE_HINT } from '../src/statusline';
import { removeTempDir } from './temp-dir';

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CLI_ENTRY = 'cli-main.js';
const HOOK_ENTRY = 'hook.js';
// The built CLI and hook are what Claude Code runs; `npm run build` must run first.
const describeBuilt = fs.existsSync(path.join(DIST, CLI_ENTRY)) ? describe : describe.skip;

/** Prints the same thing through cmd, PowerShell and sh. */
const PREVIOUS_STATUSLINE = 'echo PREV';
const PREVIOUS_OUTPUT = 'PREV';
const TASK_TITLE = 'Wire the statusline';
const SESSION_ID = 'statusline-e2e';
const NEXT_SESSION_ID = 'statusline-e2e-next';

describeBuilt('the chained statusline, run the way Claude Code runs it', () => {
    let home: string;
    let env: NodeJS.ProcessEnv;
    let taskLabel: string;

    const settingsPath = (): string => path.join(home, '.claude', 'settings.json');

    const node = (script: string, args: string[], input = ''): SpawnSyncReturns<string> =>
        spawnSync(process.execPath, [script, ...args], { env, cwd: home, input, encoding: 'utf8' });

    /** Whatever settings.json now holds, through a shell, as Claude Code runs it. */
    const statusline = (): SpawnSyncReturns<string> => {
        const command = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).statusLine.command;
        return spawnSync(command, {
            shell: true, env, cwd: home, input: JSON.stringify({ session_id: SESSION_ID }), encoding: 'utf8',
        });
    };

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-statusline-'));
        const ghostpmHome = path.join(home, '.ghostpm');
        env = {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            GHOSTPM_HOME: ghostpmHome,
            // Keeps anything the spawned CLI or hook sweeps away from the real temporary folder.
            TEMP: home,
            TMP: home,
            TMPDIR: home,
            // Lets a CLI copied out of this checkout still resolve its dependencies.
            NODE_PATH: path.join(ROOT, 'node_modules'),
        };
        fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
        fs.writeFileSync(settingsPath(), JSON.stringify({ statusLine: { type: 'command', command: PREVIOUS_STATUSLINE } }));

        const db = openLedger(path.join(ghostpmHome, LEDGER_FILE));
        try {
            const workspaceId = ensureWorkspace(db, home).id;
            const task = createTask(db, { title: TASK_TITLE, phase: 'in_progress', workspaceId, origin: 'local', source: 'test' });
            startSession(db, { id: SESSION_ID, client: 'claude-code', cwd: home, workspaceId });
            setSessionTask(db, SESSION_ID, task.id);
            taskLabel = `${formatTaskId(task.id)} ${TASK_TITLE}`;
        } finally {
            db.close();
        }
    });

    afterEach(() => {
        removeTempDir(home);
    });

    it('shows the active task after the previous statusline, with no global install', () => {
        expect(node(path.join(DIST, CLI_ENTRY), ['setup', '--statusline']).status).toBe(0);

        const shown = statusline();

        expect(shown.status).toBe(0);
        expect(shown.stdout).toContain(PREVIOUS_OUTPUT);
        expect(shown.stdout).toContain(taskLabel);
    });

    it('keeps working after a plugin update deletes the version it was set up from', () => {
        // Claude Code removes a replaced version's directory 14 days after an update.
        const oldVersion = path.join(home, 'old-version');
        fs.cpSync(DIST, path.join(oldVersion, 'dist'), { recursive: true });
        expect(node(path.join(oldVersion, 'dist', CLI_ENTRY), ['setup', '--statusline']).status).toBe(0);
        removeTempDir(oldVersion);
        expect(statusline().status).not.toBe(0);

        // The first session on the new version starts from its own hook.
        node(path.join(DIST, HOOK_ENTRY), ['SessionStart'], JSON.stringify({ session_id: NEXT_SESSION_ID, cwd: home }));
        const shown = statusline();

        expect(shown.status).toBe(0);
        expect(shown.stdout).toContain(taskLabel);
    });

    it('keeps the previous statusline when the ledger is newer than this copy (gap N2)', () => {
        expect(node(path.join(DIST, CLI_ENTRY), ['setup', '--statusline']).status).toBe(0);
        const db = openLedger(path.join(home, '.ghostpm', LEDGER_FILE));
        db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
        db.close();

        const shown = statusline();

        expect(shown.status).toBe(0);
        expect(shown.stdout).toContain(PREVIOUS_OUTPUT);
        expect(shown.stdout).toContain(UPDATE_HINT);
    });
});
