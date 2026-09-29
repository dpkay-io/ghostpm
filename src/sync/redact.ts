export const REDACTED = '[redacted]';

/**
 * Spec §8.9: secrets never leave the machine. One forward scan, linear in the text: fixed-shape tokens,
 * then private-key blocks, then `key=value` / `"key": "value"` pairs whose value is read by hand.
 * Pushing a secret cannot be undone, so the shapes lean towards redacting.
 */

/** Left edge of a token: the start, or a character that cannot continue one (`_` and `-` included, unlike \b). */
const EDGE = '(^|[^A-Za-z0-9])';
/** A JWT segment may contain `_` and `-`, so its left edge must not be one: a run of them is never re-entered. */
const BASE64URL_EDGE = '(^|[^A-Za-z0-9_-])';
const END = '(?![A-Za-z0-9])';
/** Longest token body looked at: real ones are far shorter, and the bound keeps every attempt constant-time. */
const MAX_TOKEN = 255;
const MAX_JWT_SEGMENT = 4096;

/** Group 1 is the edge (kept), group 2 the secret. */
const TOKEN_PATTERNS: readonly RegExp[] = [
    new RegExp(`${EDGE}(gh[pousr]_[A-Za-z0-9]{36,${MAX_TOKEN}})${END}`, 'g'),                          // GitHub tokens
    new RegExp(`${EDGE}(github_pat_[A-Za-z0-9_]{22,${MAX_TOKEN}})`, 'g'),                               // GitHub fine-grained tokens
    new RegExp(`${EDGE}((?:AKIA|ASIA)[0-9A-Z]{16})${END}`, 'g'),                                        // AWS access key ids
    new RegExp(`${EDGE}(xox[abeprs]-[A-Za-z0-9-]{10,${MAX_TOKEN}})`, 'g'),                             // Slack tokens
    new RegExp(`${EDGE}(sk-[A-Za-z0-9_-]{20,${MAX_TOKEN}})`, 'g'),                                      // OpenAI / Anthropic style keys
    new RegExp(`${EDGE}(AIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])`, 'g'),                                 // Google API keys
    new RegExp(`${BASE64URL_EDGE}(eyJ[A-Za-z0-9_-]{5,${MAX_JWT_SEGMENT}}\\.eyJ[A-Za-z0-9_-]{5,${MAX_JWT_SEGMENT}}\\.[A-Za-z0-9_-]{0,${MAX_JWT_SEGMENT}})`, 'g'), // JWTs
    new RegExp(`${EDGE}([A-Za-z0-9]{76}AZDO[A-Za-z0-9]{4})${END}`, 'g'),                                // Azure DevOps PATs (84-character format)
    new RegExp(`${EDGE}([a-z2-7]{52})${END}`, 'g'),                                                     // Azure DevOps PATs (52-character base32)
];

/** PEM, OpenSSH and PGP private keys: from the header to its END line or, cut off, to the end of the text. */
const KEY_BLOCK_BEGIN = /-----BEGIN [A-Z ]{0,64}PRIVATE KEY(?: BLOCK)?-----/g;
const KEY_BLOCK_END = /-----END [A-Z ]{0,64}PRIVATE KEY(?: BLOCK)?-----/g;

/**
 * A key naming a secret, its quotes, and its separator. Groups: 1 the edge before it, 2 its opening quote, 3 the key
 * (words joined by `_`/`-`, one of them a secret keyword), 4 its closing quote, 5 the separator, 6 space after it.
 * Every quantifier is bounded, and a key can only start where an identifier starts.
 */
const KEY = new RegExp(
    '(^|[^A-Za-z0-9_-])(["\']?)((?:[A-Za-z0-9]{0,64}[_-]){0,16}(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_-]{0,64})'
    + '(["\']?)\\s{0,64}([=:])(\\s{0,64})', 'gi');
const ASSIGNMENT = '=';
const QUOTES = '"\'';
const isQuote = (char: string | undefined): boolean => char !== undefined && char.length === 1 && QUOTES.indexOf(char) >= 0;
/** Longest value read after a key. */
const MAX_VALUE = 4096;
const WHITESPACE = /\s/;
const HAS_DIGIT = /\d/;
/** An assignment (`key=value`, `key="value"`, or a quoted key and a colon, as in pasted config): any value this long is a secret. */
const ASSIGNED_SECRET_MIN_LENGTH = 8;
/** Prose (`token: expiration bug`, `key = value`): a secret only when this long with a digit in it. */
const SECRET_VALUE_MIN_LENGTH = 12;

export interface Redaction {
    text: string;
    count: number;
}

interface Span {
    start: number;
    end: number;
}

/**
 * The value after a key. A quoted one runs to its closing quote (spaces included); an unquoted one to whitespace or a
 * quote, and never into the next key (`abc&password: …` is two pairs, `abc&def;ghi` one value). Both are bounded.
 */
function readValue(text: string, at: number, nextKeyAt: number): Span {
    const quote = text[at];
    if (isQuote(quote)) {
        const limit = Math.min(text.length, at + 1 + MAX_VALUE);
        for (let end = at + 1; end < limit; end++) {
            if (text[end] === quote) return { start: at + 1, end };
        }
        at++;   // never closed: read what follows the quote as unquoted
    }
    const limit = Math.min(nextKeyAt, text.length, at + MAX_VALUE);
    let end = at;
    while (end < limit && !WHITESPACE.test(text[end]) && !isQuote(text[end])) end++;
    return { start: at, end };
}

function isSecret(value: string, assigned: boolean): boolean {
    // A token pattern ran first: its placeholder is never counted twice.
    if (value.indexOf(REDACTED) >= 0) return false;
    return assigned
        ? value.length >= ASSIGNED_SECRET_MIN_LENGTH
        : value.length >= SECRET_VALUE_MIN_LENGTH && HAS_DIGIT.test(value);
}

export function redactSecrets(text: string): Redaction {
    let count = 0;

    // 1. Private-key blocks, by hand: the END search resumes where the block ends, so nothing is scanned twice.
    let result = '';
    let copied = 0;
    KEY_BLOCK_BEGIN.lastIndex = 0;
    for (let begin = KEY_BLOCK_BEGIN.exec(text); begin !== null; begin = KEY_BLOCK_BEGIN.exec(text)) {
        KEY_BLOCK_END.lastIndex = KEY_BLOCK_BEGIN.lastIndex;
        const end = KEY_BLOCK_END.exec(text);
        result += `${text.slice(copied, begin.index)}${REDACTED}`;
        copied = end === null ? text.length : KEY_BLOCK_END.lastIndex;
        KEY_BLOCK_BEGIN.lastIndex = copied;
        count++;
    }
    result += text.slice(copied);

    // 2. Fixed-shape tokens.
    for (const pattern of TOKEN_PATTERNS) {
        result = result.replace(pattern, (_match: string, edge: string) => {
            count++;
            return `${edge}${REDACTED}`;
        });
    }

    // 3. key=value pairs. Each key is found once; a kept value is still searched for the next key inside it.
    const out: string[] = [];
    copied = 0;
    KEY.lastIndex = 0;
    let key = KEY.exec(result);
    while (key !== null) {
        const [whole, edge, open, , close, separator, after] = key;
        const valueAt = key.index + whole.length;
        KEY.lastIndex = valueAt;
        const next = KEY.exec(result);
        const value = readValue(result, valueAt, next === null ? result.length : next.index);
        const quotedKey = close.length > 0 && (open.length > 0 || isQuote(edge));
        const assigned = separator === ASSIGNMENT ? after.length === 0 : quotedKey;
        if (isSecret(result.slice(value.start, value.end), assigned)) {
            out.push(result.slice(copied, value.start), REDACTED);
            copied = value.end;
            count++;
            if (next !== null && next.index < value.end) {
                // A quoted value can hold what looked like the next key: resume after the value.
                KEY.lastIndex = value.end;
                key = KEY.exec(result);
                continue;
            }
        }
        key = next;
    }
    out.push(result.slice(copied));
    return { text: out.join(''), count };
}
