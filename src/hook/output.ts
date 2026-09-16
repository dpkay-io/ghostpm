/**
 * Always the JSON form. SessionStart accepts raw stdout, but SubagentStart silently
 * drops it, so one shape is used everywhere rather than a per-event rule to remember.
 */
export function buildOutput(event: string, context: string | null): string {
    if (context === null || context.trim().length === 0) return JSON.stringify({});
    return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
}
