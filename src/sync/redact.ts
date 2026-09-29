export const REDACTED = '[redacted]';

/** Left edge of a token or key: the start, or any character that cannot continue one (`_` and `-` included, unlike \b). */
const EDGE_CHAR = '(?:^|[^A-Za-z0-9])';
const EDGE = `(${EDGE_CHAR})`;
/** Right edge of a token: no letter or digit follows. */
const END = '(?![A-Za-z0-9])';
/** A key=value value this long with a digit in it is a secret; shorter or digit-free text is prose ("token: expiration bug"). */
const SECRET_VALUE_MIN_LENGTH = 12;
const HAS_DIGIT = /\d/;

/**
 * Spec §8.9: common token shapes, replaced before anything leaves the machine. Group 1 is kept
 * (the edge before the token); group 2 is the secret. Pushing a secret cannot be undone, so the
 * shapes lean towards redacting.
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
    new RegExp(`${EDGE}(gh[pousr]_[A-Za-z0-9]{36,})${END}`, 'g'),                                  // GitHub tokens
    new RegExp(`${EDGE}(github_pat_[A-Za-z0-9_]{22,})`, 'g'),                                       // GitHub fine-grained tokens
    new RegExp(`${EDGE}((?:AKIA|ASIA)[0-9A-Z]{16})${END}`, 'g'),                                    // AWS access key ids, long-lived and temporary
    new RegExp(`${EDGE}(xox[abeprs]-[A-Za-z0-9-]{10,})`, 'g'),                                     // Slack tokens
    new RegExp(`${EDGE}(sk-[A-Za-z0-9_-]{20,})`, 'g'),                                              // OpenAI / Anthropic style keys
    new RegExp(`${EDGE}(AIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])`, 'g'),                             // Google API keys
    new RegExp(`${EDGE}(eyJ[A-Za-z0-9_-]{5,}\\.eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]*)`, 'g'),        // JWTs
    new RegExp(`${EDGE}([A-Za-z0-9]{76}AZDO[A-Za-z0-9]{4})${END}`, 'g'),                            // Azure DevOps PATs (84-character format)
    new RegExp(`${EDGE}([a-z2-7]{52})${END}`, 'g'),                                                 // Azure DevOps PATs (52-character base32)
    // Private key blocks (PEM, OpenSSH, PGP), to their END line or, cut off, to the end of the text.
    /()(-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$))/g,
];

/** `password=…`, `"api_key": "…"`, `DB_PASSWORD=…`, `client_secret: …`: group 1 (the key and separator) is kept. */
const KEY_VALUE = new RegExp(`(${EDGE_CHAR}["']?(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_-]*["']?\\s*[:=]\\s*["']?)([^\\s"']+)`, 'gi');

/** A token pattern ran first, so `[redacted]` is never looked at again; otherwise long and not a plain word. */
const looksSecret = (value: string): boolean =>
    value.indexOf(REDACTED) < 0 && value.length >= SECRET_VALUE_MIN_LENGTH && HAS_DIGIT.test(value);

export interface Redaction {
    text: string;
    count: number;
}

export function redactSecrets(text: string): Redaction {
    let count = 0;
    let result = text;
    for (const pattern of TOKEN_PATTERNS) {
        result = result.replace(pattern, (_match: string, edge: string) => {
            count++;
            return `${edge}${REDACTED}`;
        });
    }
    const keyValues = (span: string): string => span.replace(KEY_VALUE, (_match: string, key: string, value: string) => {
        if (!looksSecret(value)) {
            // Not itself a secret, but it may run on into the next assignment (`[redacted]&password=…`): look inside it too.
            return `${key}${keyValues(value)}`;
        }
        count++;
        return `${key}${REDACTED}`;
    });
    return { text: keyValues(result), count };
}
