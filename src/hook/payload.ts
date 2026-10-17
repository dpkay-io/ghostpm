import { CLAUDE_PID_ENV } from '../ledger/sessions';

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
    /** The client process the hook runs for: Claude Code passes its own as CLAUDE_PID. */
    clientPid: number | null;
    raw: Record<string, unknown>;
}

/** Some Windows shells prepend a BOM when piping, which breaks JSON.parse. */
const BOM = /^﻿/;
const PROCESS_ID = /^\d+$/;

/**
 * Never throws: a malformed payload still yields a usable shape, so the hook can exit 0.
 * The prompt field differs between harnesses — ponytail reads `prompt` and demonstrably
 * works, claude-lifecycle-core reads `user_prompt` — so accept either.
 */
export function readPayload(stdin: string, argvEvent: string, env: NodeJS.ProcessEnv = process.env): HookPayload {
    let raw: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(stdin.replace(BOM, ''));
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            raw = parsed as Record<string, unknown>;
        }
    } catch { /* malformed stdin: fall back to the argv event */ }

    const clientPid = env[CLAUDE_PID_ENV] ?? '';
    const str = (key: string): string => (typeof raw[key] === 'string' ? raw[key] as string : '');
    return {
        event: str('hook_event_name') || argvEvent,
        sessionId: str('session_id'),
        cwd: str('cwd') || process.cwd(),
        prompt: str('prompt') || str('user_prompt'),
        toolCalls: Array.isArray(raw.tool_calls) ? raw.tool_calls as ToolCall[] : [],
        clientPid: PROCESS_ID.test(clientPid) ? Number(clientPid) : null,
        raw,
    };
}
