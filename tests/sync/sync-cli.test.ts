import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { openLedger, LEDGER_FILE } from '../../src/ledger/db';
import { ensureWorkspace } from '../../src/ledger/workspaces';
import { setSetting, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO } from '../../src/ledger/settings';
import { COMMAND_OVERRIDE_ENV } from '../../src/cli';
import { VENDOR_CALL_TIMEOUT_MS } from '../../src/sync/vendor';
import { clonedRepo } from '../ledger/helpers';
import { removeTempDir } from '../temp-dir';

const CLI = path.join(__dirname, '..', '..', 'dist', 'cli-main.js');
// The exit code is set by the built entry point; `npm run build` must run first.
const describeBuilt = fs.existsSync(CLI) ? describe : describe.skip;
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const OFFLINE = 'error connecting to api.github.com';
const MINUTE_MS = 60 * 1000;

describeBuilt('ghostpm sync from the command line (I2)', () => {
    let home: string;

    /** Every home, and the temporary folder, is the test folder; gh is a script that only fails, az is nothing: no real CLI can run. */
    const sync = () => spawnSync(process.execPath, [CLI, 'sync'], {
        cwd: home,
        encoding: 'utf8',
        env: {
            ...process.env, GHOSTPM_HOME: home, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home,
            [COMMAND_OVERRIDE_ENV.gh!]: path.join(home, 'offline-gh.js'), [COMMAND_OVERRIDE_ENV.az!]: path.join(home, 'no-such-az.js'),
        },
    });
    const argFolder = (name: string, ageMs: number): string => {
        const folder = path.join(home, name);
        fs.mkdirSync(folder);
        const when = new Date(Date.now() - ageMs);
        fs.utimesSync(folder, when, when);
        return folder;
    };

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-sync-cli-'));
        fs.writeFileSync(path.join(home, 'offline-gh.js'), `process.stderr.write(${JSON.stringify(OFFLINE)}); process.exit(1);\n`);
    });

    afterEach(() => {
        removeTempDir(home);
    });

    it('exits 0 when there is nothing to sync, saying how to turn sync on (F2)', () => {
        const result = sync();
        expect(result.stdout).toContain('Pushed 0');
        expect(result.stdout).toContain('`ghostpm config set sync_policy auto --workspace "');
        expect(result.status).toBe(EXIT_OK);
    });

    it('sweeps argument folders older than twice a vendor call timeout, and only those (F11)', () => {
        const stale = argFolder('ghostpm-args-left', 2 * VENDOR_CALL_TIMEOUT_MS + MINUTE_MS);
        const recent = argFolder('ghostpm-args-recent', MINUTE_MS);

        expect(sync().status).toBe(EXIT_OK);

        expect(fs.existsSync(stale)).toBe(false);
        expect(fs.existsSync(recent)).toBe(true);
    });

    it('exits 1 and names the workspace whose pull failed', () => {
        const db = openLedger(path.join(home, LEDGER_FILE));
        let workspacePath: string;
        try {
            setSetting(db, SETTING_SYNC_POLICY, SYNC_POLICY_AUTO);
            workspacePath = ensureWorkspace(db, clonedRepo(home, 'widgets')).path;
        } finally {
            db.close();
        }

        const result = sync();

        expect(result.stdout).toContain(`${workspacePath}: pull failed:`);
        expect(result.stdout).toContain(OFFLINE);
        expect(result.status).toBe(EXIT_FAILURE);
    });
});
