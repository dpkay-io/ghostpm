import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// The module object itself, not an import wrapper: the release script takes spawnSync from it as it loads.
import child_process = require('child_process');
import { systemTool } from '../src/cli';

import { removeTempDir } from './temp-dir';

/** The release script loads the built bootstrap; `npm run build` must run first. */
const BUILT = fs.existsSync(path.join(__dirname, '..', 'dist', 'bootstrap.js'));
const describeBuilt = BUILT ? describe : describe.skip;
const describeWindowsBuilt = process.platform === 'win32' && BUILT ? describe : describe.skip;
const LEFTOVER_PID = 4242;
const SHRINKWRAP = 'npm-shrinkwrap.json';
/** What the macOS run's npm printed for `npm -v`. Faked: no npm 12 runs here. */
const NPM_12 = '12.2.0';

interface VerifyRelease {
    stopLeftovers(folder: string): number;
    shrinkwrapRefusal(shipped: string[]): string | null;
    main(): Promise<void>;
}

const loadScript = (): VerifyRelease => {
    let script!: VerifyRelease;
    jest.isolateModules(() => { script = require('../scripts/verify-release'); });
    return script;
};

describeBuilt('the release check on an npm that drops the shrinkwrap', () => {
    it('refuses a tarball without npm-shrinkwrap.json, and passes one with it', () => {
        const { shrinkwrapRefusal } = loadScript();

        const refusal = shrinkwrapRefusal(['package.json', 'dist/cli-main.js']);
        expect(refusal).toContain(SHRINKWRAP);
        expect(refusal).toContain('npm 10 or 11');
        expect(shrinkwrapRefusal(['package.json', SHRINKWRAP])).toBeNull();
    });

    it('prints npm -v, then stops with that one failure: no ENOENT, no stack trace, no per-file failures', async () => {
        const env = { ...process.env };
        const lines: string[] = [];
        const log = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        // A fake npm 12: it prints its version, and packs the staged folder without the shrinkwrap, as npm-packlist 11.3 does.
        const npm = jest.spyOn(child_process, 'execSync').mockImplementation(((command: string, options: { cwd: string }) => {
            if (/ -v$/.test(command)) {
                lines.push(NPM_12);
            } else if (/ pack /.test(command)) {
                const fake = path.join(options.cwd, '..', 'fake-npm');
                fs.cpSync(options.cwd, path.join(fake, 'package'), { recursive: true });
                fs.rmSync(path.join(fake, 'package', SHRINKWRAP));
                child_process.execFileSync('tar', ['-czf', path.join('..', 'ghostpm-0.0.0.tgz'), 'package'], { cwd: fake });
            } else {
                throw new Error(`the fake npm did not expect ${command}`);
            }
            return '';
        }) as never);
        // No real process listing: stopLeftovers has its own test above.
        const spawn = jest.spyOn(child_process, 'spawnSync')
            .mockImplementation((() => ({ pid: 0, output: [], stdout: '', stderr: '', status: 0, signal: null })) as never);
        const exitCode = process.exitCode;
        let work: string | undefined;
        try {
            await loadScript().main();

            work = /Left (.+) for inspection\./.exec(lines.join('\n'))?.[1];
            expect(process.exitCode).toBe(1);
            expect(error).not.toHaveBeenCalled();
            expect(lines).toContain(NPM_12);
            const failures = lines.filter(line => line.startsWith('FAIL'));
            expect(failures).toHaveLength(1);
            expect(failures[0]).toContain('npm 10 or 11');
            expect(lines.join('\n')).not.toMatch(/ENOENT|\n\s+at /);
        } finally {
            process.exitCode = exitCode;
            [npm, spawn, log, error].forEach(spy => spy.mockRestore());
            Object.keys(process.env).filter(key => !(key in env)).forEach(key => { delete process.env[key]; });
            Object.assign(process.env, env);
            if (work !== undefined) removeTempDir(work);
        }
    });
});

describeWindowsBuilt('the release check stopping what its run left behind', () => {
    it('lists and stops processes with the System32 PowerShell and taskkill, never a copy found first on PATH or in the folder', () => {
        // Only the folder's name is matched; it is never created, and the spawns are stubs: nothing real is listed or stopped.
        const work = path.join(os.tmpdir(), 'ghostpm-verify-stub');
        const listing = `${LEFTOVER_PID} node ${path.join(work, 'x.js')}\r\n${process.pid} node ${work}\r\n`;
        const spawn = jest.spyOn(child_process, 'spawnSync')
            .mockImplementation((() => ({ pid: 0, output: [], stdout: listing, stderr: '', status: 0, signal: null })) as never);
        try {
            const { stopLeftovers } = loadScript();

            expect(stopLeftovers(work)).toBe(1);

            expect(spawn.mock.calls.map(call => call[0]))
                .toEqual([systemTool(path.join('WindowsPowerShell', 'v1.0', 'powershell.exe')), systemTool('taskkill.exe')]);
            expect(spawn.mock.calls[1][1]).toContain(String(LEFTOVER_PID));
        } finally {
            spawn.mockRestore();
        }
    });
});
