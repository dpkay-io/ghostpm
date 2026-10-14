import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// The module object itself, not an import wrapper: the release script takes spawnSync from it as it loads.
import child_process = require('child_process');
import { systemTool } from '../src/cli';

/** The release script loads the built bootstrap; `npm run build` must run first. */
const BUILT = fs.existsSync(path.join(__dirname, '..', 'dist', 'bootstrap.js'));
const describeWindowsBuilt = process.platform === 'win32' && BUILT ? describe : describe.skip;
const LEFTOVER_PID = 4242;

describeWindowsBuilt('the release check stopping what its run left behind', () => {
    it('lists and stops processes with the System32 PowerShell and taskkill, never a copy found first on PATH or in the folder', () => {
        // Only the folder's name is matched; it is never created, and the spawns are stubs: nothing real is listed or stopped.
        const work = path.join(os.tmpdir(), 'ghostpm-verify-stub');
        const listing = `${LEFTOVER_PID} node ${path.join(work, 'x.js')}\r\n${process.pid} node ${work}\r\n`;
        const spawn = jest.spyOn(child_process, 'spawnSync')
            .mockImplementation((() => ({ pid: 0, output: [], stdout: listing, stderr: '', status: 0, signal: null })) as never);
        try {
            let stopLeftovers!: (folder: string) => number;
            jest.isolateModules(() => { ({ stopLeftovers } = require('../scripts/verify-release')); });

            expect(stopLeftovers(work)).toBe(1);

            expect(spawn.mock.calls.map(call => call[0]))
                .toEqual([systemTool(path.join('WindowsPowerShell', 'v1.0', 'powershell.exe')), systemTool('taskkill.exe')]);
            expect(spawn.mock.calls[1][1]).toContain(String(LEFTOVER_PID));
        } finally {
            spawn.mockRestore();
        }
    });
});
