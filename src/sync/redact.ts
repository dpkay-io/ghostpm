export const REDACTED = '[redacted]';

/** Spec §8.9: common token shapes. Anything matching is replaced before it leaves the machine. */
const SECRET_PATTERNS: readonly RegExp[] = [
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,                                       // GitHub tokens
    /\bgithub_pat_[A-Za-z0-9_]{22,}/g,                                        // GitHub fine-grained tokens
    /\bAKIA[0-9A-Z]{16}\b/g,                                                  // AWS access key ids
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                                        // Slack tokens
    /\bsk-[A-Za-z0-9_-]{20,}/g,                                               // OpenAI / Anthropic style keys
    /\bAIza[0-9A-Za-z_-]{35}\b/g,                                             // Google API keys
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s"']{6,}/gi, // key=value assignments
];

export interface Redaction {
    text: string;
    count: number;
}

export function redactSecrets(text: string): Redaction {
    let count = 0;
    let result = text;
    for (const pattern of SECRET_PATTERNS) {
        result = result.replace(pattern, () => {
            count++;
            return REDACTED;
        });
    }
    return { text: result, count };
}
