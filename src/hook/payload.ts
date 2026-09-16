export interface ToolCall {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_response?: unknown;
}

export interface HookPayload {
    event: string;
    sessionId: string;
    cwd: string;
    prompt: string;
    toolCalls: ToolCall[];
    raw: Record<string, unknown>;
}

/** Some Windows shells prepend a BOM when piping, which breaks JSON.parse. */
const BOM = /^﻿/;

/**
 * Never throws: a malformed payload still yields a usable shape, so the hook can exit 0.
 * The prompt field differs between harnesses — ponytail reads `prompt` and demonstrably
 * works, claude-lifecycle-core reads `user_prompt` — so accept either.
 */
export function readPayload(stdin: string, argvEvent: string): HookPayload {
    let raw: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(stdin.replace(BOM, ''));
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            raw = parsed as Record<string, unknown>;
        }
    } catch { /* malformed stdin: fall back to the argv event */ }

    const str = (key: string): string => (typeof raw[key] === 'string' ? raw[key] as string : '');
    return {
        event: str('hook_event_name') || argvEvent,
        sessionId: str('session_id'),
        cwd: str('cwd') || process.cwd(),
        prompt: str('prompt') || str('user_prompt'),
        toolCalls: Array.isArray(raw.tool_calls) ? raw.tool_calls as ToolCall[] : [],
        raw,
    };
}
