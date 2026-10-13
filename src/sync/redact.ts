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

/**
 * Group 1 is the edge (kept), group 2 the secret. GitHub and JWT bodies are unbounded (App tokens and Entra ID JWTs
 * run to thousands of characters) and stay linear: each starts at a literal prefix, a match takes its whole run, and
 * a JWT attempt that fails is never retried from inside the same run (its edge).
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
    new RegExp(`${EDGE}(gh[pousr]_[A-Za-z0-9._-]{36,})`, 'g'),                                          // GitHub tokens, classic and ghs_<app id>_<JWT>
    new RegExp(`${EDGE}(github_pat_[A-Za-z0-9_]{22,${MAX_TOKEN}})`, 'g'),                               // GitHub fine-grained tokens
    new RegExp(`${EDGE}((?:AKIA|ASIA)[0-9A-Z]{16})${END}`, 'g'),                                        // AWS access key ids
    new RegExp(`${EDGE}(xox[abeprs]-[A-Za-z0-9-]{10,${MAX_TOKEN}})`, 'g'),                             // Slack tokens
    new RegExp(`${EDGE}(sk-[A-Za-z0-9_-]{20,${MAX_TOKEN}})`, 'g'),                                      // OpenAI / Anthropic style keys
    new RegExp(`${EDGE}(AIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])`, 'g'),                                 // Google API keys
    new RegExp(`${BASE64URL_EDGE}(eyJ[A-Za-z0-9_-]{5,}\\.eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]*)`, 'g'),   // JWTs
    new RegExp(`${EDGE}([A-Za-z0-9]{76}AZDO[A-Za-z0-9]{4})${END}`, 'g'),                                // Azure DevOps PATs (84-character format)
    new RegExp(`${EDGE}([a-z2-7]{52})${END}`, 'g'),                                                     // Azure DevOps PATs (52-character base32)
];

/** PEM, OpenSSH and PGP private keys: from the header to its END line or, cut off, to the end of the text. */
const KEY_BLOCK_BEGIN = /-----BEGIN [A-Z ]{0,64}PRIVATE KEY(?: BLOCK)?-----/g;
const KEY_BLOCK_END = /-----END [A-Z ]{0,64}PRIVATE KEY(?: BLOCK)?-----/g;

/** Longest word of a key, and longest part of one before its keyword. */
const MAX_KEY_WORD = 64;

/**
 * A key naming a secret, its quotes, and its separator. Groups: 1 the edge before it, 2 its opening quote, 3 the key
 * (words joined by `_`/`-`, one of them holding a secret keyword anywhere, in any case: `client_secret`,
 * `clientSecret`, `mytoken`, `AWSSecret`), 4 its closing quote, 5 the separator, 6 space after it. Every quantifier
 * is bounded, and a key can only start where an identifier starts.
 */
const KEY = new RegExp(
    `(^|[^A-Za-z0-9_-])(["']?)((?:[A-Za-z0-9]{0,${MAX_KEY_WORD}}[_-]){0,16}[A-Za-z0-9]{0,${MAX_KEY_WORD}}`
    + `(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_-]{0,${MAX_KEY_WORD}})`
    + '(["\']?)\\s{0,64}([=:])(\\s{0,64})', 'gi');
const ASSIGNMENT = '=';
const QUOTES = '"\'';
const isQuote = (char: string | undefined): boolean => char !== undefined && char.length === 1 && QUOTES.indexOf(char) >= 0;
/** Furthest a closing quote is looked for after a value's opening quote. */
const MAX_VALUE = 4096;
const WHITESPACE = /\s/;
const HAS_DIGIT = /\d/;
/** An assignment (`key=value`, `key="value"`, or a colon after a quoted key or before a quoted value, as in pasted config): any value this long is a secret. */
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
 * The value after a key. A quoted one runs to its closing quote (spaces included), looked for within MAX_VALUE; an
 * unquoted one, however long, to whitespace, a quote or the next key (`abc&password: …` is two pairs, `abc&def;ghi`
 * one value). An unquoted read never overlaps a later key's, so the scan stays linear.
 */
function readValue(text: string, at: number, nextKeyAt: number): Span {
    const quote = text[at];
    if (isQuote(quote)) {
        const limit = Math.min(text.length, at + 1 + MAX_VALUE);
        for (let end = at + 1; end < limit; end++) {
            if (text[end] === quote) return { start: at + 1, end };
        }
        at++;   // never closed nearby: read what follows the quote as unquoted
    }
    let end = at;
    while (end < nextKeyAt && !WHITESPACE.test(text[end]) && !isQuote(text[end])) end++;
    return { start: at, end };
}

function isSecret(text: string, assigned: boolean): boolean {
    // A token pattern ran first: its placeholder is not judged, but the text beside it is (`pw&jwt=[redacted]`).
    const value = text.indexOf(REDACTED) < 0 ? text : text.split(REDACTED).join('');   // most values hold none: no copy
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
        const quotedValue = value.start > valueAt;
        // A colon is pasted config (JSON, YAML) when the key or the value is quoted; `key: value` alone is prose.
        const assigned = separator === ASSIGNMENT ? after.length === 0 : quotedKey || quotedValue;
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
