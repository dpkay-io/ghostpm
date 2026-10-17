import { redactSecrets, REDACTED } from '../../src/sync/redact';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ADO_PAT_52 = Array.from({ length: 52 }, (_, i) => BASE32[(i * 7) % BASE32.length]).join('');
/** The 84-character Azure DevOps PAT shape: `AZDO` at 76-79 (per Microsoft's announcement; unverified against a real PAT). */
const ADO_PAT_84 = `${'A'.repeat(52)}${'b'.repeat(24)}AZDO${'c'.repeat(4)}`;
const GITHUB_TOKEN = `ghp_${'a1'.repeat(18)}`;
/** Built from parts so no scanner mistakes these fixtures for real Slack tokens in the source. */
const SLACK_BOT_TOKEN = `xox${'b'}-1234567890-abcdefghij`;
const SLACK_REFRESH_TOKEN = `xox${'e'}-1-abcdefghijklmnop`;
/** The recursive re-scan threw RangeError from about 2,000 links in a chain (measured). */
const DEEP_CHAIN = 5000;
const HOSTILE_BYTES = 1 << 18;
/** The large input is this many times the small one: linear scanning grows about 8x, quadratic 64x. */
const HOSTILE_GROWTH = 8;
/** Best of this many runs per size, the sizes taking turns, so a load spike on one run does not decide the result. */
const HOSTILE_RUNS = 3;
/** Runs for a second look at an input that measured over the limit (a load spike on a shared machine reached 24.6x). */
const HOSTILE_CONFIRM_RUNS = 7;
/** Between linear (8x; a quiet machine measured at most 10.7x) and quadratic (64x). */
const HOSTILE_MAX_RATIO = 24;
/** Below this the large run is too quick for a ratio to mean anything. */
const HOSTILE_NOISE_FLOOR_MS = 50;
/** Absolute backstop, far above any linear scan even under load; the quadratic patterns took 3-44 s (measured). */
const HOSTILE_BACKSTOP_MS = 10000;

/** The adversarial inputs, each about `bytes` long. */
const hostileInputs = (bytes: number): string[] => {
    const fill = (unit: string): string => unit.repeat(Math.ceil(bytes / unit.length));
    return [
        fill('_token'), fill('token:'), fill('token='), fill(`"'`), fill('=:'), fill('""""""token"""""":x '), fill('token '),
        fill('password'), `"${fill('a_')}token":abcdefghij`, `token${' '.repeat(bytes)}x`, `${'a_'.repeat(bytes / 2)}password`,
        fill('{"user": "octocat", "password": "correcthorse", "client_secret": "abcdefghij"}\n'),
        fill('-----BEGIN PRIVATE KEY-----'), fill('_eyJaaaaa'),
        // GitHub tokens are unbounded: one long run, repeated short runs, runs one short of a token.
        ` ghs_${'a'.repeat(bytes)}`, fill('ghs_'), fill(' ghs_1_'), fill(` ghs_${'a'.repeat(35)}`),
        // JWT segments are unbounded: a run with no dot, and one whose last dot never comes.
        ` eyJ${'a'.repeat(bytes)}`, ` eyJaaaaa.eyJ${'a'.repeat(bytes)}`, fill('.eyJaaaaa'),
        // camelCase keys: chains of them, with and without separators, and boundaries with no keyword.
        fill('aToken'), fill('aToken:'), fill('"aBcToken": "'), fill(` ${'aB'.repeat(40)}`), fill(` ${`${'aToken'.repeat(10)}_`.repeat(17)}`),
        // Keywords anywhere in a word: keyword-dense words, and long words a keyword never ends.
        fill('xtoken'), fill('xtokenx='), fill(`!${'a'.repeat(64)}token`), fill(`!${`${'a'.repeat(64)}_`.repeat(16)}${'a'.repeat(64)}tokex `),
        fill(`!${`${'token'.repeat(12)}_`.repeat(16)}${'token'.repeat(12)} `),
        // Values have no length cap but whitespace, a quote or the next key: one long value, quotes never
        // closed, and prose keys with long digitless quoted values back to back.
        `password=${'x'.repeat(bytes)}`, `password="${'x'.repeat(bytes)}`, fill('password="'),
        fill(`token = "${'a'.repeat(4000)}"`), fill(`token = "${'a b'.repeat(1500)}"`),
    ];
};

const JWT ='eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
/** GitHub App installation tokens since 2026-04-27 (Actions' GITHUB_TOKEN): `ghs_<app id>_<JWT>` (synthetic; unverified against a real one). */
const GITHUB_APP_TOKEN = `ghs_1234567_${JWT}`;
/** Entra ID tokens carrying group claims reach about 10K characters. */
const LARGE_JWT_PAYLOAD = 10000;
const RS256_SIGNATURE_LENGTH = 342;
const LARGE_JWT = `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJ${'a1'.repeat(LARGE_JWT_PAYLOAD / 2)}.${'s'.repeat(RS256_SIGNATURE_LENGTH)}`;
/** Random-looking, with digits: a secret under either the assignment or the prose rule. */
const CAMEL_SECRET = 'Zx8Qv3LmNp7Rt2WyAb4Cd6Ef';
/** Longer than the 4,096 characters a value used to be cut off at. */
const LONG_VALUE = 5000;
const LONG_SECRET = CAMEL_SECRET.repeat(Math.ceil(LONG_VALUE / CAMEL_SECRET.length)).slice(0, LONG_VALUE);

describe('redactSecrets (spec §8.9)', () => {
    // [kind, text, the secret that must be gone]
    it.each([
        ['GitHub token', `use ${GITHUB_TOKEN} to push`, GITHUB_TOKEN],
        ['GitHub OAuth token', `gho_${'Z9'.repeat(18)}`, `gho_${'Z9'.repeat(18)}`],
        ['GitHub token followed by an underscore', `${GITHUB_TOKEN}_old`, GITHUB_TOKEN],
        ['fine-grained GitHub token', `github_pat_${'A'.repeat(22)}_${'b'.repeat(59)}`, `github_pat_${'A'.repeat(22)}`],
        ['AWS access key id', 'key AKIAIOSFODNN7EXAMPLE here', 'AKIAIOSFODNN7EXAMPLE'],
        ['AWS temporary access key id', 'ASIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE'],
        ['Slack token', SLACK_BOT_TOKEN, 'xox' + 'b-1234567890'],
        ['Slack refresh token', SLACK_REFRESH_TOKEN, SLACK_REFRESH_TOKEN],
        ['API key', `sk-ant-api03-${'x'.repeat(40)}`, `sk-ant-api03-${'x'.repeat(40)}`],
        ['Google API key', `AIza${'B'.repeat(35)}`, `AIza${'B'.repeat(35)}`],
        ['Azure DevOps PAT (52)', `pat ${ADO_PAT_52}`, ADO_PAT_52],
        ['Azure DevOps PAT (84)', `pat ${ADO_PAT_84}`, ADO_PAT_84],
        ['JWT bearer token', `Authorization: Bearer ${JWT}`, JWT],
        ['RSA private key block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', 'MIIEow'],
        ['OpenSSH private key block', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----', 'b3Bl'],
        ['PGP private key block', '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOY\n-----END PGP PRIVATE KEY BLOCK-----', 'lQOY'],
        ['private key cut off before its END line', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'],
        ['password assignment', 'password=hunter2hunter2', 'hunter2hunter2'],
        ['api_key assignment', 'api_key: 9f8e7d6c5b4a', '9f8e7d6c5b4a'],
        ['DB_PASSWORD variable', 'DB_PASSWORD=hunter2hunter2', 'hunter2hunter2'],
        ['GITHUB_TOKEN variable', 'GITHUB_TOKEN=abcdef123456abcdef', 'abcdef123456abcdef'],
        ['AWS secret variable', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
        ['client_secret assignment', 'client_secret=Zx8Qv3LmNp7Rt2Wy', 'Zx8Qv3LmNp7Rt2Wy'],
        ['JSON password', '{"password": "hunter2hunter2"}', 'hunter2hunter2'],
        ['quoted password', 'password = "hunter2hunter2"', 'hunter2hunter2'],
        ['token assignment holding a token', `token=${GITHUB_TOKEN}`, GITHUB_TOKEN],
    ])('redacts a %s, once', (_kind, text, secret) => {
        const result = redactSecrets(text);
        expect(result.count).toBe(1);
        expect(result.text).toContain(REDACTED);
        expect(result.text).not.toContain(secret);
    });

    it('keeps the key it redacts the value of', () => {
        expect(redactSecrets('DB_PASSWORD=hunter2hunter2').text).toBe(`DB_PASSWORD=${REDACTED}`);
        expect(redactSecrets('{"password": "hunter2hunter2"}').text).toBe(`{"password": "${REDACTED}"}`);
    });

    it.each([
        ['bare', `token in the log: ${GITHUB_APP_TOKEN} end`, `token in the log: ${REDACTED} end`],
        ['a Bearer header', `Authorization: Bearer ${GITHUB_APP_TOKEN}`, `Authorization: Bearer ${REDACTED}`],
        ['a token header', `-H "Authorization: token ${GITHUB_APP_TOKEN}"`, `-H "Authorization: token ${REDACTED}"`],
        ['a JSON value', `{"auth": "${GITHUB_APP_TOKEN}"}`, `{"auth": "${REDACTED}"}`],
    ])('redacts a new-format GitHub App token (ghs_<app id>_<JWT>) whole: %s', (_kind, text, redacted) => {
        expect(redactSecrets(text)).toEqual({ text: redacted, count: 1 });
    });

    it.each([
        ['bare', `id ${LARGE_JWT} end`, `id ${REDACTED} end`],
        ['as an assigned value', `access_token=${LARGE_JWT}`, `access_token=${REDACTED}`],
    ])('redacts a JWT of any size whole: %s', (_kind, text, redacted) => {
        expect(redactSecrets(text)).toEqual({ text: redacted, count: 1 });
    });

    it.each([
        ['a JWT later in the same query value', `https://x.test/login?password=Hunter2Hunter2x&jwt=${JWT}`, `https://x.test/login?password=${REDACTED}`],
        ['an AWS key after a comma', 'password=Hunter2Hunter2x,AKIAIOSFODNN7EXAMPLE', `password=${REDACTED}`],
        ['a Slack token after a semicolon, in prose form', `password: Hunter2Hunter2x1;${SLACK_BOT_TOKEN}`, `password: ${REDACTED}`],
        ['a GitHub token in the same quoted value', `password="Hunter2Hunter2x ${GITHUB_TOKEN}"`, `password="${REDACTED}"`],
    ])('never lets a token redaction shield the secret beside it: %s', (_kind, text, redacted) => {
        expect(redactSecrets(text).text).toBe(redacted);
    });

    it.each([
        ['JSON clientSecret', `{"clientSecret": "${CAMEL_SECRET}"}`, `{"clientSecret": "${REDACTED}"}`],
        ['JSON accessToken', `{"accessToken": "${CAMEL_SECRET}"}`, `{"accessToken": "${REDACTED}"}`],
        ['JSON refreshToken', `{"refreshToken":"${CAMEL_SECRET}"}`, `{"refreshToken":"${REDACTED}"}`],
        ['JSON dbPassword', `{"dbPassword": "${CAMEL_SECRET}"}`, `{"dbPassword": "${REDACTED}"}`],
        ['JSON apiKey', `{"apiKey": "${CAMEL_SECRET}"}`, `{"apiKey": "${REDACTED}"}`],
        ['YAML clientSecret', `clientSecret: ${CAMEL_SECRET}`, `clientSecret: ${REDACTED}`],
        ['YAML accessToken', `  accessToken: ${CAMEL_SECRET}`, `  accessToken: ${REDACTED}`],
        ['env dbPassword', 'dbPassword=correcthorse', `dbPassword=${REDACTED}`],
        ['env refreshToken', `export refreshToken=${CAMEL_SECRET}`, `export refreshToken=${REDACTED}`],
        ['a longer camelCase key', `oauthClientSecretValue=${CAMEL_SECRET}`, `oauthClientSecretValue=${REDACTED}`],
    ])('reads a camelCase secret key as a key: %s', (_kind, text, redacted) => {
        expect(redactSecrets(text)).toEqual({ text: redacted, count: 1 });
    });

    it.each(['mytoken', 'authtoken', 'oauth2Token', 'AWSSecret', 'GCPToken', 'dbpassword'].flatMap(key => [
        [`env ${key}`, `${key}=abcdefghij`, `${key}=${REDACTED}`],
        [`JSON ${key}`, `{"${key}": "abcdefghij"}`, `{"${key}": "${REDACTED}"}`],
        [`YAML-quoted ${key}`, `${key}: "abcdefghij"`, `${key}: "${REDACTED}"`],
    ]))('reads a key holding a secret keyword anywhere, in any case, as a key: %s', (_kind, text, redacted) => {
        expect(redactSecrets(text)).toEqual({ text: redacted, count: 1 });
    });

    it.each([
        ['unquoted', `DB_PASSWORD=${LONG_SECRET}`, `DB_PASSWORD=${REDACTED}`],
        ['quoted, with no spaces', `password="${LONG_SECRET}"`, `password="${REDACTED}"`],
    ])('redacts a secret value longer than 4,096 characters whole: %s', (_kind, text, redacted) => {
        expect(redactSecrets(text)).toEqual({ text: redacted, count: 1 });
    });

    it.each([
        'tokenizer: splits words',
        'passwordless login is next',
        'newTokenizer: handles text',
        'resetPassword: flow broken',
        'the clientSecret rotates weekly',
        'mytoken: abcdefghij',
        'AWSSecret: rotate weekly',
    ])('keeps prose around camelCase keys and keywords inside words: %s', text => {
        expect(redactSecrets(text)).toEqual({ text, count: 0 });
    });

    it('redacts a token inside a URL without breaking the URL around it', () => {
        const url = `https://x-access-token:ghs_${'q'.repeat(36)}@github.com/a/b`;
        expect(redactSecrets(url)).toEqual({ text: `https://x-access-token:${REDACTED}@github.com/a/b`, count: 1 });
    });

    it.each([
        'Fix the token refresh bug — see password reset flow (T42)',
        'Fix token: expiration bug',
        'Password: reset flow broken',
        'secret: rotate weekly',
    ])('leaves ordinary text alone: %s', text => {
        expect(redactSecrets(text)).toEqual({ text, count: 0 });
    });

    it('counts every match', () => {
        expect(redactSecrets('password=aaaaaaaaaaa1 and token=bbbbbbbbbbb2').count).toBe(2);
    });

    it.each([
        ['a URL query', `https://api.example.com/?access_token=${GITHUB_TOKEN}&password=hunter2hunter2`, 'https://api.example.com/?access_token=[redacted]&password=[redacted]'],
        ['a comma-joined header', `token=${GITHUB_TOKEN},client_secret=Zx8Qv3LmNp7Rt2Wy`, 'token=[redacted],client_secret=[redacted]'],
        ['a semicolon-joined env line', `GITHUB_TOKEN=${GITHUB_TOKEN};DB_PASSWORD=hunter2hunter2`, 'GITHUB_TOKEN=[redacted];DB_PASSWORD=[redacted]'],
    ])('never lets an earlier redaction shield the next secret in %s', (_kind, text, redacted) => {
        expect(redactSecrets(text)).toEqual({ text: redacted, count: 2 });
    });

    it.each([
        ['password=correcthorsebatterystaple', 'password=[redacted]'],
        ['client_secret=abcdefghijkl', 'client_secret=[redacted]'],
        ['DB_PASSWORD="hunter-hunter"', 'DB_PASSWORD="[redacted]"'],
        ["api_key='abcdefgh'", "api_key='[redacted]'"],
    ])('redacts any assigned value of 8 or more characters, digits or not: %s', (text, redacted) => {
        expect(redactSecrets(text)).toEqual({ text: redacted, count: 1 });
    });

    it.each([
        ['"password":"correcthorse"', '"password":"[redacted]"'],
        ['"client_secret": "abcdefghij"', '"client_secret": "[redacted]"'],
        ["'api_key': 'abcdefgh'", "'api_key': '[redacted]'"],
    ])('reads a quoted key and a colon as an assignment (pasted config): %s', (text, redacted) => {
        expect(redactSecrets(text)).toEqual({ text: redacted, count: 1 });
    });

    it('redacts both secrets of a pretty-printed JSON object', () => {
        const json = '{\n  "user": "octocat",\n  "password": "correcthorse",\n  "client_secret": "abcdefghij"\n}';
        expect(redactSecrets(json)).toEqual({
            text: '{\n  "user": "octocat",\n  "password": "[redacted]",\n  "client_secret": "[redacted]"\n}',
            count: 2,
        });
    });

    it.each([
        'password=hunter',
        'password: correcthorse',
        'token = expiration bug',
        'secret = rotateweekly',
    ])('leaves a short assigned value, or prose written with spaces, alone: %s', text => {
        expect(redactSecrets(text)).toEqual({ text, count: 0 });
    });

    it('still redacts a whole secret that holds & ; or ,', () => {
        expect(redactSecrets('password=abc&def;ghi,12345')).toEqual({ text: `password=${REDACTED}`, count: 1 });
    });

    it.each([
        ['a token, then a quoted password', `GITHUB_TOKEN=${GITHUB_TOKEN};DB_PASSWORD="hunter2hunter2"`],
        ['a token, then `password: `', `GITHUB_TOKEN=${GITHUB_TOKEN};DB_PASSWORD: hunter2hunter2`],
        ['a query token, then a quoted password', `?access_token=${GITHUB_TOKEN}&password="hunter2hunter2"`],
        ['a short value, then `password: `', 'token=abc&password: hunter2hunter2'],
        ['a short value, then a quoted password', 'token=abc&password="hunter2hunter2"'],
        ['a short password, then a JSON key', 'password=abc,"api_key": "hunter2hunter2"'],
    ])('never lets an earlier value hide a later secret: %s', (_kind, text) => {
        const result = redactSecrets(text);
        expect(result.text).not.toContain('hunter2hunter2');
        expect(result.text).not.toContain(GITHUB_TOKEN);
    });

    it.each([
        ['TOML', 'password = "staplehorse"', `password = "${REDACTED}"`],
        ['a TOML literal string under a table', "[database]\npassword = 'abcdefgh'", `[database]\npassword = '${REDACTED}'`],
        ['INI', '[auth]\nclient_secret = "letmeinnow"', `[auth]\nclient_secret = "${REDACTED}"`],
        ['INI with a colon', 'api_key : "abcdefghi"', `api_key : "${REDACTED}"`],
        ['Python', 'PASSWORD = "hunterpass"', `PASSWORD = "${REDACTED}"`],
        ['a Python attribute', "self.api_token = 'opensesame'", `self.api_token = '${REDACTED}'`],
        ['a Python keyword argument', 'connect(password = "swordfish")', `connect(password = "${REDACTED}")`],
        ['prose-spaced, holding a key', 'password = "see token=abcdefghij here"', `password = "${REDACTED}"`],
    ])('reads a quoted value after any separator as assigned: %s', (_kind, text, redacted) => {
        expect(redactSecrets(text)).toEqual({ text: redacted, count: 1 });
    });

    it('still examines a key inside a quoted value it keeps', () => {
        // Quoted but under 8 characters, so kept; its opening quote is the edge of a key whose value is a secret.
        expect(redactSecrets('password = "token="abcdefghij"')).toEqual({ text: 'password = "token="[redacted]"', count: 1 });
    });

    it('redacts the secret after a short value, not the short value and the key', () => {
        expect(redactSecrets('token=abc&password: hunter2hunter2')).toEqual({ text: 'token=abc&password: [redacted]', count: 1 });
    });

    it.each([
        ['PASSWORD=Hunter22', 'PASSWORD=[redacted]'],
        ["'api_key' : 'abcdefgh'", "'api_key' : '[redacted]'"],
        ['"x-api-key": "abcdefgh"', '"x-api-key": "[redacted]"'],
        ['"client_secret":abcdefgh', '"client_secret":[redacted]'],
        ['export DB_PASSWORD=correcthorse', 'export DB_PASSWORD=[redacted]'],
        ['my_password"="abcdefgh"', 'my_password"="[redacted]"'],
        ['password="correct horse battery"', 'password="[redacted]"'],
        ['x"password":"abcdefgh"', 'x"password":"[redacted]"'],
        ['"password"\t:\t"abcdefgh"', '"password"\t:\t"[redacted]"'],
    ])('redacts the assignment form %s', (text, redacted) => {
        expect(redactSecrets(text)).toEqual({ text: redacted, count: 1 });
    });

    it.each([
        'token:abcdefgh',
        'The "secret": to success',
        '{"token": "short"}',
        'password=[redacted]',
        '"password": "[redacted]"',
    ])('keeps %s', text => {
        expect(redactSecrets(text)).toEqual({ text, count: 0 });
    });

    it.each([
        ['token:', DEEP_CHAIN],
        ['secret:', DEEP_CHAIN],
        [`token=${GITHUB_TOKEN}&`, DEEP_CHAIN],
    ])('returns, without recursing, on %s repeated thousands of times', (unit, times) => {
        expect(() => redactSecrets(unit.repeat(times))).not.toThrow();
        expect(redactSecrets(`token=${GITHUB_TOKEN}&`.repeat(times)).count).toBe(times);
    });

    it('scans hostile inputs in linear time (8x the input takes about 8x the time, not 64x; the old regexes were quadratic or threw)', () => {
        const timed = (text: string): number => {
            const started = performance.now();
            redactSecrets(text);
            return performance.now() - started;
        };
        const large = hostileInputs(HOSTILE_BYTES * HOSTILE_GROWTH);
        /** Best of `runs` per size, the sizes taking turns. */
        const measure = (small: string, big: string, runs: number): { smallMs: number; largeMs: number } => {
            let smallMs = Infinity;
            let largeMs = Infinity;
            for (let run = 0; run < runs; run++) {
                smallMs = Math.min(smallMs, timed(small));
                largeMs = Math.min(largeMs, timed(big));
            }
            return { smallMs, largeMs };
        };
        const ratio = ({ smallMs, largeMs }: { smallMs: number; largeMs: number }): number =>
            (largeMs > HOSTILE_NOISE_FLOOR_MS ? largeMs / Math.max(smallMs, 1) : 0);
        hostileInputs(HOSTILE_BYTES).forEach((text, index) => {
            let timing = measure(text, large[index]!, HOSTILE_RUNS);
            // A quadratic scan is over the limit on every measurement; a load spike is not: look again before failing.
            if (ratio(timing) >= HOSTILE_MAX_RATIO) timing = measure(text, large[index]!, HOSTILE_CONFIRM_RUNS);
            expect(timing.largeMs).toBeLessThan(HOSTILE_BACKSTOP_MS);
            expect(ratio(timing)).toBeLessThan(HOSTILE_MAX_RATIO);
        });
    });

    it('never matches its own placeholder again', () => {
        const once = redactSecrets(`token=${GITHUB_TOKEN}`).text;
        expect(redactSecrets(once)).toEqual({ text: once, count: 0 });
    });
});
