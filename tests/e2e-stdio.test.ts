import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { STDIO_BANNER } from '../src/mcp-server';
import { removeTempDir } from './temp-dir';

const CLI = path.join(__dirname, '..', 'dist', 'cli-main.js');
const STARTUP_TIMEOUT_MS = 30000;
/** Older than any vendor call can run (twice the 45 s call timeout), and then some. */
const STALE_ARGS_AGE_MS = 10 * 60 * 1000;
/** How long something the server does in the background may take to show. */
const WAIT_MS = 10000;
const POLL_MS = 50;

async function waitUntil(done: () => boolean): Promise<void> {
    for (const end = Date.now() + WAIT_MS; !done() && Date.now() < end;) {
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
}

// The built CLI is what this test drives; `npm run build` must run first.
const describeBuilt = fs.existsSync(CLI) ? describe : describe.skip;

function inheritedEnv(extra: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of Object.keys(process.env)) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
    }
    return { ...env, ...extra };
}

describeBuilt('ghostpm serve over stdio', () => {
    let home: string;
    let workspace: string;
    let staleArgs: string;
    let client: Client;
    let serverStderr = '';

    const callText = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
        const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[] };
        return result.content[0].text;
    };

    beforeAll(async () => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-e2e-home-'));
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-e2e-ws-'));
        staleArgs = path.join(home, 'ghostpm-args-left');
        fs.mkdirSync(staleArgs);
        const longAgo = new Date(Date.now() - STALE_ARGS_AGE_MS);
        fs.utimesSync(staleArgs, longAgo, longAgo);
        client = new Client({ name: 'e2e', version: '1.0.0' });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [CLI, 'serve'],
            cwd: workspace,
            // HOME/USERPROFILE keep the legacy import away from the real ~/.claude.json, and the temporary folder
            // keeps the start-up sweep of argument folders away from the real one.
            env: inheritedEnv({ GHOSTPM_HOME: home, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home }),
            // The SDK's default, inherit, would print the server's stderr into the test output.
            stderr: 'pipe',
        });
        transport.stderr?.on('data', (chunk: Buffer) => { serverStderr += chunk.toString(); });
        await client.connect(transport);
    }, STARTUP_TIMEOUT_MS);

    afterAll(async () => {
        await client.close();
        removeTempDir(home);
        removeTempDir(workspace);
    });

    it('starts outside a git repository and tracks work end to end', async () => {
        const created = await callText('track_work', { title: 'Smoke test task', intent: 'implement' });
        expect(created).toMatch(/^Created T\d+ "Smoke test task" \(planned\)\.$/);

        const state = await callText('get_project_state');
        expect(state).toContain('vendor: none');
        expect(state).toContain('Smoke test task');
        expect(state).toContain('**Live Sessions:** 1');

        expect(await callText('query_tasks')).toContain('Smoke test task');
        expect(fs.existsSync(path.join(home, 'ledger.db'))).toBe(true);
    }, STARTUP_TIMEOUT_MS);

    it('sweeps argument folders a vendor call left behind when its sync runner starts (F11)', async () => {
        await waitUntil(() => !fs.existsSync(staleArgs));
        expect(fs.existsSync(staleArgs)).toBe(false);
    }, STARTUP_TIMEOUT_MS);

    it('announces itself on stderr, which this test captures so it never reaches the test output', async () => {
        await waitUntil(() => serverStderr.indexOf(STDIO_BANNER) >= 0);
        expect(serverStderr).toContain(STDIO_BANNER);
    }, STARTUP_TIMEOUT_MS);
});
