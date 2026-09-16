import { readPayload } from '../../src/hook/payload';

describe('readPayload', () => {
    it('strips a UTF-8 BOM before parsing', () => {
        // Some Windows shells prepend a BOM when piping, which breaks JSON.parse.
        const raw = '\uFEFF' + JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'abc' });
        expect(readPayload(raw, 'SessionStart').sessionId).toBe('abc');
    });

    it('prefers prompt but falls back to user_prompt', () => {
        expect(readPayload(JSON.stringify({ prompt: 'a' }), 'UserPromptSubmit').prompt).toBe('a');
        expect(readPayload(JSON.stringify({ user_prompt: 'b' }), 'UserPromptSubmit').prompt).toBe('b');
        expect(readPayload('{}', 'UserPromptSubmit').prompt).toBe('');
    });

    it('falls back to the argv event only when the payload omits one', () => {
        expect(readPayload('{}', 'SessionEnd').event).toBe('SessionEnd');
        expect(readPayload(JSON.stringify({ hook_event_name: 'Stop' }), 'SessionEnd').event).toBe('Stop');
    });

    it('reads the tool calls of a batch, defaulting to none', () => {
        const calls = [{ tool_name: 'Bash', tool_input: { command: 'git commit' } }];
        expect(readPayload(JSON.stringify({ hook_event_name: 'PostToolBatch', tool_calls: calls }), 'PostToolBatch').toolCalls).toEqual(calls);
        expect(readPayload(JSON.stringify({ hook_event_name: 'PostToolBatch' }), 'PostToolBatch').toolCalls).toEqual([]);
    });

    it('never throws on malformed stdin, so the hook can still exit 0', () => {
        const payload = readPayload('not json at all', 'SessionStart');
        expect(payload.event).toBe('SessionStart');
        expect(payload.toolCalls).toEqual([]);
        expect(payload.prompt).toBe('');
    });

    it('ignores non-string and non-object payload values', () => {
        const payload = readPayload(JSON.stringify({ session_id: 42, tool_calls: 'nope' }), 'SessionStart');
        expect(payload.sessionId).toBe('');
        expect(payload.toolCalls).toEqual([]);
    });

    it('defaults cwd to the process directory when absent', () => {
        expect(readPayload('{}', 'SessionStart').cwd).toBe(process.cwd());
        expect(readPayload(JSON.stringify({ cwd: 'C:/repo' }), 'SessionStart').cwd).toBe('C:/repo');
    });
});
