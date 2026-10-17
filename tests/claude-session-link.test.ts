import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PmServer } from '../src/mcp-server';
import { getTask } from '../src/ledger/tasks';
import { getSession, listLiveSessions, mcpSessionId } from '../src/ledger/sessions';
import { readPayload, ToolCall } from '../src/hook/payload';
import { handleWith, HookOptions, HOOK_CLIENT } from '../src/hook/handlers';
import { tempLedger, TempLedger, eventKinds, isolateHomes } from './ledger/helpers';

jest.mock('child_process');

/** The variable Claude Code sets in every process it starts, hooks and MCP servers alike (observed on 2.x). */
const CLAUDE_SESSION_ENV = 'CLAUDE_CODE_SESSION_ID';
const CLAUDE_SESSION = '1c9d4a15-a7ea-4bed-bf45-e5b0c200264c';
/** The id /clear gives the conversation while the MCP server keeps running with the first one in its environment. */
const AFTER_CLEAR = 'b3ae7040-6724-4b7e-a0ab-c23583fc1660';
/** Claude Code's process id, which only its hooks receive as CLAUDE_PID. */
const HOOK_ENV = { CLAUDE_PID: '16064' };
const PR_URL = 'https://github.com/acme/widgets/pull/7';
const NO_SPAWN: HookOptions = { startSync: () => undefined };
const GIT_FAILURE = 'not a git repository';

describe("track_work attaches Claude Code's own session, the one its hooks report", () => {
    let ledger: TempLedger;
    let repo: string;
    let client: Client;
    let restoreHomes: () => void;
    let originalClaudeSession: string | undefined;

    const hook = (event: string, sessionId: string, toolCalls: ToolCall[] = []): string | null =>
        handleWith(ledger.db, readPayload(JSON.stringify({
            hook_event_name: event, session_id: sessionId, cwd: repo, tool_calls: toolCalls,
        }), event, HOOK_ENV), NO_SPAWN);

    const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
        const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[] };
        return result.content[0].text;
    };

    const trackedId = async (): Promise<number> =>
        Number((await call('track_work', { title: 'Login fix', intent: 'implement' })).match(/T(\d+)/)![1]);

    /** Started as Claude Code starts it: no session id passed in, CLAUDE_CODE_SESSION_ID (or none) in the environment. */
    const startServer = async (claudeSession: string | undefined): Promise<void> => {
        if (claudeSession === undefined) delete process.env[CLAUDE_SESSION_ENV];
        else process.env[CLAUDE_SESSION_ENV] = claudeSession;
        const server = new PmServer({ db: ledger.db, cwd: repo, legacyImport: false });
        client = new Client({ name: 'claude-code', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.run(serverTransport)]);
    };

    beforeEach(() => {
        // Not a git repository: get_project_state's branch lookup fails at once instead of waiting on the mock.
        (child_process.execFile as unknown as jest.Mock).mockImplementation((...args: unknown[]) => {
            const cb = args[args.length - 1];
            if (typeof cb === 'function') (cb as (e: Error | null, out: string, err: string) => void)(new Error(GIT_FAILURE), '', '');
        });
        ledger = tempLedger();
        restoreHomes = isolateHomes(ledger.dir);
        repo = path.join(ledger.dir, 'repo');
        fs.mkdirSync(repo, { recursive: true });
        originalClaudeSession = process.env[CLAUDE_SESSION_ENV];
    });

    afterEach(async () => {
        await client.close();
        if (originalClaudeSession !== undefined) process.env[CLAUDE_SESSION_ENV] = originalClaudeSession;
        else delete process.env[CLAUDE_SESSION_ENV];
        restoreHomes();
        ledger.cleanup();
        jest.clearAllMocks();
    });

    it('so the PR the session opens is recorded on the task and moves it to in_review', async () => {
        // On --resume the MCP server starts before the SessionStart hook runs: start it first.
        await startServer(CLAUDE_SESSION);
        hook('SessionStart', CLAUDE_SESSION);
        hook('UserPromptSubmit', CLAUDE_SESSION);
        const taskId = await trackedId();

        hook('PostToolBatch', CLAUDE_SESSION, [
            { tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' }, tool_response: `${PR_URL}\n` },
        ]);

        expect(getSession(ledger.db, CLAUDE_SESSION)!.task_id).toBe(taskId);
        expect(eventKinds(ledger.db, taskId)).toContain('pr');
        expect(getTask(ledger.db, taskId)!.phase).toBe('in_review');
    });

    it('and after /clear, the new conversation rather than the id the server was started with', async () => {
        await startServer(CLAUDE_SESSION);
        hook('SessionStart', CLAUDE_SESSION);
        hook('SessionEnd', CLAUDE_SESSION);
        hook('SessionStart', AFTER_CLEAR);
        hook('UserPromptSubmit', AFTER_CLEAR);
        const taskId = await trackedId();

        hook('PostToolBatch', AFTER_CLEAR, [{ tool_name: 'Bash', tool_input: { command: 'git commit -m "fix login"' } }]);

        expect(getSession(ledger.db, CLAUDE_SESSION)!.task_id).toBeNull();
        expect(eventKinds(ledger.db, taskId)).toContain('commit');
        expect(getTask(ledger.db, taskId)!.phase).toBe('in_progress');
    });

    it('registering no session of its own, so the live sessions count Claude Code once, labelled as Claude Code', async () => {
        await startServer(CLAUDE_SESSION);
        hook('SessionStart', CLAUDE_SESSION);

        expect(await call('get_project_state')).toContain('**Live Sessions:** 1');
        expect(listLiveSessions(ledger.db).map(session => [session.id, session.client])).toEqual([[CLAUDE_SESSION, HOOK_CLIENT]]);
        expect(getSession(ledger.db, mcpSessionId())).toBeUndefined();
    });

    it("leaving the session's cwd to the hooks, which report where Claude Code works now", async () => {
        const subfolder = path.join(repo, 'packages', 'app');
        fs.mkdirSync(subfolder, { recursive: true });
        await startServer(CLAUDE_SESSION);
        handleWith(ledger.db, readPayload(JSON.stringify({
            hook_event_name: 'SessionStart', session_id: CLAUDE_SESSION, cwd: subfolder,
        }), 'SessionStart', HOOK_ENV), NO_SPAWN);

        await call('get_project_state');

        expect(getSession(ledger.db, CLAUDE_SESSION)!.cwd).toBe(subfolder);
    });

    it('keeps its own mcp:<pid> session, with its own cwd, for a client that is not Claude Code', async () => {
        await startServer(undefined);
        const taskId = await trackedId();

        expect(getSession(ledger.db, mcpSessionId())).toMatchObject({ task_id: taskId, cwd: repo });
    });
});
