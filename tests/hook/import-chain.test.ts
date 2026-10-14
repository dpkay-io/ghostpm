import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { removeTempDir } from '../temp-dir';

const DIST = path.join(__dirname, '..', '..', 'dist');
// What the hook loads is only observable on the built files; `npm run build` must run first.
const describeBuilt = fs.existsSync(path.join(DIST, 'hook', 'handlers.js')) ? describe : describe.skip;

/** Runs one event through the built handlers, as dist/hook.js does, and prints every module that was loaded. */
const PROBE = `
const path = require('path');
const [dist, event, cwd] = process.argv.slice(1);
const load = entry => require(path.join(dist, entry));
for (const entry of ['hook/payload.js', 'hook/output.js', 'hook/log.js', 'hook/handlers.js', 'hook/recover.js', 'plugin-setup.js']) load(entry);
const db = load('ledger/db.js').openLedger();
const payload = load('hook/payload.js').readPayload(JSON.stringify({ hook_event_name: event, session_id: 'chain', cwd, prompt: 'hi' }), event);
load('hook/handlers.js').handleWith(db, payload, { startSync: () => undefined });
db.close();
process.stdout.write(JSON.stringify(Object.keys(require.cache)));`;
/**
 * Spec §7.2, §15: the MCP SDK and zod cost 250 ms+; vendor adapters, the runner and the Phase 4 surfaces (dashboard,
 * standup, statusline) have no place in a hook. RELEASING.md names this suite as the release check for it.
 */
const FORBIDDEN = [
    /@modelcontextprotocol/, /[\\/]zod[\\/]/, /[\\/]js-yaml[\\/]/,
    /[\\/]dist[\\/]mcp-server\.js$/, /[\\/]dist[\\/]config\.js$/,
    /[\\/]dist[\\/]surfaces[\\/]/, /[\\/]dist[\\/]statusline\.js$/,
    /[\\/]dist[\\/]sync[\\/](github|azure|runner|push|pull|reconcile|redact|identity)\.js$/,
];
/** Ruling M5: only SessionStart decides whether to start a sync; the prompt hook, which runs on every prompt, never loads it. */
const SESSION_START_ONLY = /[\\/]dist[\\/](sync[\\/](schedule|lease|outbox)|hook[\\/]spawn)\.js$/;
const SCHEDULE = /[\\/]dist[\\/]sync[\\/]schedule\.js$/;

describeBuilt('the hook import chain', () => {
    let home: string;

    /** Loaded modules after one event, in a child whose homes are all a temp folder. */
    const loadedBy = (event: string): string[] => {
        const env = { ...process.env, GHOSTPM_HOME: home, HOME: home, USERPROFILE: home };
        return JSON.parse(execFileSync(process.execPath, ['-e', PROBE, DIST, event, home], { encoding: 'utf8', env })) as string[];
    };
    const forbiddenIn = (loaded: string[]): string[] => loaded.filter(file => FORBIDDEN.some(pattern => pattern.test(file)));

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-import-chain-'));
    });

    afterEach(() => {
        removeTempDir(home);
    });

    it('keeps the sync schedule, the lease, the outbox and the spawner out of the prompt hook', () => {
        const loaded = loadedBy('UserPromptSubmit');
        expect(loaded.filter(file => SESSION_START_ONLY.test(file))).toEqual([]);
        expect(forbiddenIn(loaded)).toEqual([]);
    });

    it('loads the sync schedule on SessionStart, and still no MCP SDK, zod or vendor adapter', () => {
        const loaded = loadedBy('SessionStart');
        expect(loaded.some(file => SCHEDULE.test(file))).toBe(true);
        expect(forbiddenIn(loaded)).toEqual([]);
    });
});
