import { buildOutput } from '../../src/hook/output';

describe('buildOutput', () => {
    it('uses the hookSpecificOutput form so SubagentStart does not drop the context', () => {
        expect(JSON.parse(buildOutput('SessionStart', 'Resuming T4'))).toEqual({
            hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Resuming T4' },
        });
    });

    it('carries the event name through, whatever it is', () => {
        expect(JSON.parse(buildOutput('UserPromptSubmit', 'Active: T7')).hookSpecificOutput.hookEventName)
            .toBe('UserPromptSubmit');
    });

    it('emits an empty object when there is nothing to inject', () => {
        expect(JSON.parse(buildOutput('Stop', null))).toEqual({});
        expect(JSON.parse(buildOutput('Stop', ''))).toEqual({});
        expect(JSON.parse(buildOutput('Stop', '   '))).toEqual({});
    });

    it('always produces parseable JSON on one line', () => {
        const output = buildOutput('SessionStart', 'line one\nline two "quoted"');
        expect(output).not.toContain('\n');
        expect(JSON.parse(output).hookSpecificOutput.additionalContext).toBe('line one\nline two "quoted"');
    });
});
