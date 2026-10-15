import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { removeTempDir } from '../temp-dir';

const DIST = path.join(__dirname, '..', '..', 'dist');
// What the hook loads is only observable on the built files; `npm run build` must run first.
const describeBuilt = fs.existsSync(path.join(DIST, 'hook', 'handlers.js')) ? describe : describe.skip;

/** Runs one event through the built handlers, as dist/hook.js does, and prints every module that was loaded. */
const PROBE = `
const path = require('path');
const [dist, event, cwd] = process.argv.slice(1);
const load = entry => require(path.join(dist, entry));
for (const entry of ['hook/payload.js', 'hook/output.js', 'hook/log.js', 'hook/handlers.js']) load(entry);
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
/** Spec §15: what only SessionStart (launcher refresh), a failed open (recovery) or PostToolBatch (evidence) needs. */
const NOT_FOR_PROMPTS = /[\\/]dist[\\/](plugin-setup|hook[\\/]recover|ledger[\\/](work|glob))\.js$/;
/** The built entry itself, fed a prompt on stdin, so a static import added to hook.ts shows up here. */
const ENTRY_PROBE = `
process.on('exit', () => require('fs').writeSync(2, JSON.stringify(Object.keys(require.cache))));
require(process.argv[1]);`;

describeBuilt('the hook import chain', () => {
    let home: string;

    /** Loaded modules after one event, in a child whose homes are all a temp folder. */
    const loadedBy = (event: string): string[] => {
        const env = { ...process.env, GHOSTPM_HOME: home, HOME: home, USERPROFILE: home };
        return JSON.parse(execFileSync(process.execPath, ['-e', PROBE, DIST, event, home], { encoding: 'utf8', env })) as string[];
    };
    const forbiddenIn = (loaded: string[]): string[] => loaded.filter(file => FORBIDDEN.some(pattern => pattern.test(file)));
    /** Loaded modules after dist/hook.js handled one prompt. */
    const loadedByPromptEntry = (): string[] => {
        const env = { ...process.env, GHOSTPM_HOME: home, HOME: home, USERPROFILE: home };
        const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'chain', cwd: home, prompt: 'hi' });
        const run = spawnSync(process.execPath, ['-e', ENTRY_PROBE, path.join(DIST, 'hook.js'), 'UserPromptSubmit'], { input, encoding: 'utf8', env });
        expect(run.stdout).toContain('track_work');   // the prompt was really handled, not refused
        return JSON.parse(run.stderr) as string[];
    };

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

    it('keeps the launcher refresh, the addon recovery and the evidence writer out of the prompt hook entry', () => {
        const loaded = loadedByPromptEntry();
        expect(loaded.filter(file => NOT_FOR_PROMPTS.test(file) || SESSION_START_ONLY.test(file))).toEqual([]);
        expect(forbiddenIn(loaded)).toEqual([]);
    });

    it('loads the sync schedule on SessionStart, and still no MCP SDK, zod or vendor adapter', () => {
        const loaded = loadedBy('SessionStart');
        expect(loaded.some(file => SCHEDULE.test(file))).toBe(true);
        expect(forbiddenIn(loaded)).toEqual([]);
    });
});
