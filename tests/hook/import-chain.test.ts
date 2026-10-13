import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { removeTempDir } from '../temp-dir';

const DIST = path.join(__dirname, '..', '..', 'dist');
// What the hook loads is only observable on the built files; `npm run build` must run first.
const describeBuilt = fs.existsSync(path.join(DIST, 'hook', 'handlers.js')) ? describe : describe.skip;

/** Everything dist/hook.js requires, apart from its own small payload/output/log modules. */
const HOOK_ENTRIES = ['hook/handlers.js', 'hook/recover.js', 'plugin-setup.js'].map(entry => path.join(DIST, entry));
const PROBE = 'for (const entry of process.argv.slice(1)) require(entry); process.stdout.write(JSON.stringify(Object.keys(require.cache)));';
/** Spec §7.2, §15: the MCP SDK and zod cost 250 ms+; vendor adapters and the runner have no place in a hook. */
const FORBIDDEN = [
    /@modelcontextprotocol/, /[\\/]zod[\\/]/, /[\\/]js-yaml[\\/]/,
    /[\\/]dist[\\/]mcp-server\.js$/, /[\\/]dist[\\/]config\.js$/,
    /[\\/]dist[\\/]sync[\\/](github|azure|runner|push|pull|reconcile|redact|identity)\.js$/,
];

describeBuilt('the hook import chain', () => {
    let home: string;

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-import-chain-'));
    });

    afterEach(() => {
        removeTempDir(home);
    });

    it('keeps the MCP SDK, zod and the vendor adapters out of the hook', () => {
        // Loading only, but never against the real home.
        const env = { ...process.env, GHOSTPM_HOME: home, HOME: home, USERPROFILE: home };
        const loaded = JSON.parse(execFileSync(process.execPath, ['-e', PROBE, ...HOOK_ENTRIES], { encoding: 'utf8', env })) as string[];
        expect(loaded.some(file => /[\\/]dist[\\/]sync[\\/]schedule\.js$/.test(file))).toBe(true);
        for (const pattern of FORBIDDEN) {
            expect(loaded.filter(file => pattern.test(file))).toEqual([]);
        }
    });
});
