import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync, SpawnSyncReturns } from 'child_process';
import { COMMAND_OVERRIDE_ENV } from '../src/cli';
import { removeTempDir } from './temp-dir';

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CLI = path.join(DIST, 'cli-main.js');
// The built CLI is what this test drives; `npm run build` must run first.
const describeBuilt = fs.existsSync(CLI) ? describe : describe.skip;

const REPO = 'acme/widgets';
const TITLE = 'Fix login & "quotes" %PATH% ^ <x> (p) — ✓';
const THROWAWAY_TITLE = 'Tracked before anyone opted in';
const HUMAN_TITLE = 'Login fix, renamed on GitHub';
const TIMEOUT_MS = 60000;
/** Each spawned process is killed past this, well inside the test's own timeout. */
const SPAWN_TIMEOUT_MS = 20000;
const HUMAN_EDIT_MS = 60 * 1000;
const NONCE = /^[0-9a-f]{16}$/;

/**
 * A stand-in for gh. Issues live in FAKE_GH_STATE; every call is appended to FAKE_GH_LOG as
 * { args, stdin }. Answers in gh's shapes for the calls GhostPM makes. No network.
 */
const FAKE_GH = [
    "const fs = require('fs');",
    'const statePath = process.env.FAKE_GH_STATE;',
    'const args = process.argv.slice(2);',
    "let stdin = '';",
    "process.stdin.setEncoding('utf8');",
    'process.stdin.on(\'data\', chunk => { stdin += chunk; });',
    "process.stdin.on('end', () => {",
    "    fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, stdin }) + '\\n');",
    "    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { next: 1, clock: Date.now(), issues: {} };",
    '    const flag = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };',
    '    const all = name => args.reduce((found, arg, at) => (arg === name ? found.concat([args[at + 1]]) : found), []);',
    '    const touch = issue => { state.clock += 1000; issue.updatedAt = new Date(state.clock).toISOString(); };',
    '    const save = () => fs.writeFileSync(statePath, JSON.stringify(state));',
    "    const url = issue => 'https://github.com/' + flag('--repo') + '/issues/' + issue.number;",
    '    const view = issue => ({ number: issue.number, title: issue.title, body: issue.body, state: issue.state,',
    '        stateReason: issue.stateReason, labels: issue.labels.map(name => ({ name })), assignees: [], milestone: null,',
    '        updatedAt: issue.updatedAt, url: url(issue) });',
    '    const out = text => process.stdout.write(text);',
    '    const group = args[0];',
    '    const verb = args[1];',
    "    if (group === 'label') return out('');",
    "    if (group === 'api') return out('octocat\\n');",
    "    if (group === 'pr') return out(JSON.stringify({ state: 'OPEN', mergedAt: null }));",
    "    if (verb === 'create') {",
    "        const issue = { number: state.next++, title: flag('--title'), body: stdin, state: 'OPEN', stateReason: null, labels: all('--label') };",
    '        touch(issue);',
    '        state.issues[issue.number] = issue;',
    '        save();',
    "        return out(url(issue) + '\\n');",
    '    }',
    "    if (verb === 'list') return out(JSON.stringify(Object.keys(state.issues).map(number => view(state.issues[number]))));",
    '    const issue = state.issues[args[2]];',
    '    if (!issue) {',
    "        process.stderr.write('GraphQL: Could not resolve to an issue or pull request with the number of ' + args[2] + '.\\n');",
    '        process.exitCode = 1;',
    '        return;',
    '    }',
    "    if (verb === 'view') return out(JSON.stringify(view(issue)));",
    "    if (verb === 'edit') {",
    "        if (flag('--title') !== undefined) issue.title = flag('--title');",
    "        const removed = all('--remove-label');",
    "        issue.labels = issue.labels.filter(label => removed.indexOf(label) < 0).concat(all('--add-label'));",
    "    } else if (verb === 'close') {",
    "        issue.state = 'CLOSED';",
    "        issue.stateReason = flag('--reason') === 'not planned' ? 'NOT_PLANNED' : 'COMPLETED';",
    "    } else if (verb === 'reopen') {",
    "        issue.state = 'OPEN';",
    "        issue.stateReason = 'REOPENED';",
    '    }',
    '    touch(issue);',
    '    save();',
    "    out('');",
    '});',
].join('\n');

interface GhCall { args: string[]; stdin: string }

describeBuilt('sync against a fake gh, end to end on the built CLI', () => {
    let home: string;
    let ghostpmHome: string;
    let repo: string;
    let stateFile: string;
    let logFile: string;
    let env: NodeJS.ProcessEnv;

    /** The built ledger modules: the same code `ghostpm sync` and the MCP server run. */
    const dist = (module: string): any => require(path.join(DIST, module));
    const withLedger = <T>(fn: (db: any) => T): T => {
        const db = dist('ledger/db.js').openLedger(path.join(ghostpmHome, 'ledger.db'));
        try {
            return fn(db);
        } finally {
            db.close();
        }
    };
    const track = (db: any, workspaceId: number, title: string): number =>
        dist('ledger/work.js').trackWork(db, { sessionId: 'e2e', source: 'mcp:e2e', workspaceId, title, intent: 'implement' }).task.id;
    const calls = (): GhCall[] => fs.readFileSync(logFile, 'utf8').split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as GhCall);
    const cli = (...args: string[]): SpawnSyncReturns<string> =>
        spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
    const sync = (): SpawnSyncReturns<string> => cli('sync');

    beforeAll(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-sync-e2e-'));
        ghostpmHome = path.join(home, '.ghostpm');
        repo = path.join(home, 'widgets');
        fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
        fs.writeFileSync(path.join(repo, '.git', 'config'), `[remote "origin"]\n\turl = https://github.com/${REPO}.git\n`);
        const fakeGh = path.join(home, 'fake-gh.js');
        fs.writeFileSync(fakeGh, FAKE_GH);
        stateFile = path.join(home, 'gh-state.json');
        logFile = path.join(home, 'gh-calls.jsonl');
        fs.writeFileSync(logFile, '');
        // HOME/USERPROFILE keep everything (settings, legacy discovery) away from the real profile;
        // TEMP/TMP/TMPDIR keep `ghostpm sync`'s argument-folder sweep away from the real temp folder.
        env = {
            ...process.env,
            GHOSTPM_HOME: ghostpmHome, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home,
            [COMMAND_OVERRIDE_ENV.gh!]: fakeGh, FAKE_GH_STATE: stateFile, FAKE_GH_LOG: logFile,
        };
    });

    afterAll(() => removeTempDir(home));

    it('pushes track_work to gh with the exact argv and stdin, then lets a GitHub edit win on pull', () => {
        // 0. the default (off) queues nothing; a person opts the workspace in through the CLI
        const throwawayId = withLedger(db => {
            const workspace = dist('ledger/workspaces.js').ensureWorkspace(db, repo);
            expect(workspace.vendor).toBe('github');
            expect(dist('ledger/settings.js').readSetting(db, workspace.id, 'sync_policy')).toBe('off');
            const id = track(db, workspace.id, THROWAWAY_TITLE);
            expect(db.prepare('SELECT op FROM outbox WHERE task_id = ?').all(id)).toEqual([]);
            return id;
        });
        expect(cli('config', 'set', 'sync_policy', 'auto', '--workspace', repo).status).toBe(0);

        // 1. track_work → outbox
        const taskId = withLedger(db => {
            const id = track(db, dist('ledger/workspaces.js').ensureWorkspace(db, repo).id, TITLE);
            expect(db.prepare('SELECT op, status FROM outbox WHERE task_id = ?').all(id)).toEqual([{ op: 'create', status: 'pending' }]);
            return id;
        });

        // 2. ghostpm sync → gh receives exactly this
        const first = sync();
        expect(first.stderr).toBe('');
        expect(first.status).toBe(0);
        expect(first.stdout).toContain('Pushed 1');
        const nonce = withLedger(db => {
            expect(db.prepare('SELECT remote_id, remote_title FROM vendor_links WHERE task_id = ?').get(taskId)).toEqual({ remote_id: '1', remote_title: TITLE });
            expect(db.prepare('SELECT status FROM outbox WHERE task_id = ?').all(taskId)).toEqual([{ status: 'done' }]);
            expect(db.prepare('SELECT COUNT(*) AS n FROM leases').get()).toEqual({ n: 0 });
            // The retry marker the create was sent with: a retried create adopts the issue carrying it instead of filing another.
            return JSON.parse(db.prepare('SELECT payload FROM outbox WHERE task_id = ?').get(taskId).payload).nonce as string;
        });
        expect(nonce).toMatch(NONCE);
        const pushed = calls();
        expect(pushed[0]).toEqual({ args: ['label', 'create', 'ghostpm:planned', '--repo', REPO], stdin: '' });
        expect(pushed[1]).toEqual({
            args: ['issue', 'create', '--repo', REPO, '--title', TITLE, '--label', 'ghostpm:planned', '--body-file', '-'],
            stdin: `Tracked by GhostPM as T${taskId}.\n\n<!-- ghostpm:${nonce} -->`,
        });

        // 3. a person renames the issue on GitHub; the next pull applies it here as a human change
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        state.clock += HUMAN_EDIT_MS;
        state.issues['1'].title = HUMAN_TITLE;
        state.issues['1'].updatedAt = new Date(state.clock).toISOString();
        fs.writeFileSync(stateFile, JSON.stringify(state));
        const before = calls().length;

        const second = sync();
        expect(second.status).toBe(0);
        withLedger(db => {
            expect(db.prepare('SELECT title FROM tasks WHERE id = ?').get(taskId)).toEqual({ title: HUMAN_TITLE });
            expect(db.prepare("SELECT source, payload FROM events WHERE task_id = ? AND kind = 'renamed'").all(taskId))
                .toEqual([{ source: 'vendor', payload: JSON.stringify({ from: TITLE, to: HUMAN_TITLE }) }]);
            expect(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'").get()).toEqual({ n: 0 });
            // Tracked under off, so never queued and never pushed, even once the workspace syncs.
            expect(db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE task_id = ?').get(throwawayId)).toEqual({ n: 0 });
            expect(db.prepare('SELECT COUNT(*) AS n FROM vendor_links WHERE task_id = ?').get(throwawayId)).toEqual({ n: 0 });
        });
        // Nothing was pushed back over the person's edit, and only one issue was ever created.
        expect(calls().slice(before).some(call => call.args[1] === 'edit')).toBe(false);
        expect(calls().filter(call => call.args[0] === 'issue' && call.args[1] === 'create')).toHaveLength(1);
    }, TIMEOUT_MS);
});
