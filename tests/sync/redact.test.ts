import { redactSecrets, REDACTED } from '../../src/sync/redact';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ADO_PAT_52 = Array.from({ length: 52 }, (_, i) => BASE32[(i * 7) % BASE32.length]).join('');
/** The 84-character Azure DevOps PAT shape: `AZDO` at 76-79 (per Microsoft's announcement; unverified against a real PAT). */
const ADO_PAT_84 = `${'A'.repeat(52)}${'b'.repeat(24)}AZDO${'c'.repeat(4)}`;
const GITHUB_TOKEN = `ghp_${'a1'.repeat(18)}`;
/** The recursive re-scan threw RangeError from about 2,000 links in a chain (measured). */
const DEEP_CHAIN = 5000;
const HOSTILE_BYTES = 1 << 20;
/** Generous: a linear scan of 1 MB takes tens of ms; the quadratic patterns took 3-44 s on far less (measured). */
const HOSTILE_BOUND_MS = 1000;
const JWT ='eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
/** GitHub App installation tokens since 2026-04-27 (Actions' GITHUB_TOKEN): `ghs_<app id>_<JWT>` (synthetic; unverified against a real one). */
const GITHUB_APP_TOKEN = `ghs_1234567_${JWT}`;
/** Entra ID tokens carrying group claims reach about 10K characters. */
const LARGE_JWT_PAYLOAD = 10000;
const RS256_SIGNATURE_LENGTH = 342;
const LARGE_JWT = `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJ${'a1'.repeat(LARGE_JWT_PAYLOAD / 2)}.${'s'.repeat(RS256_SIGNATURE_LENGTH)}`;
/** A JWT segment is unbounded, so its hostile run is measured at four times the size. */
const JWT_RUN_BYTES = 4 * HOSTILE_BYTES;
/** Random-looking, with digits: a secret under either the assignment or the prose rule. */
const CAMEL_SECRET = 'Zx8Qv3LmNp7Rt2WyAb4Cd6Ef';

describe('redactSecrets (spec §8.9)', () => {
    // [kind, text, the secret that must be gone]
    it.each([
        ['GitHub token', `use ${GITHUB_TOKEN} to push`, GITHUB_TOKEN],
        ['GitHub OAuth token', `gho_${'Z9'.repeat(18)}`, `gho_${'Z9'.repeat(18)}`],
        ['GitHub token followed by an underscore', `${GITHUB_TOKEN}_old`, GITHUB_TOKEN],
        ['fine-grained GitHub token', `github_pat_${'A'.repeat(22)}_${'b'.repeat(59)}`, `github_pat_${'A'.repeat(22)}`],
        ['AWS access key id', 'key AKIAIOSFODNN7EXAMPLE here', 'AKIAIOSFODNN7EXAMPLE'],
        ['AWS temporary access key id', 'ASIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE'],
        ['Slack token', 'xoxb-1234567890-abcdefghij', 'xoxb-1234567890'],
        ['Slack refresh token', 'xoxe-1-abcdefghijklmnop', 'xoxe-1-abcdefghijklmnop'],
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
        ['a Slack token after a semicolon, in prose form', 'password: Hunter2Hunter2x1;xoxb-1234567890-abcdefghij', `password: ${REDACTED}`],
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

    it.each([
        'tokenizer: splits words',
        'passwordless login is next',
        'newTokenizer: handles text',
        'resetPassword: flow broken',
        'the clientSecret rotates weekly',
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

    it('still examines a key inside a quoted value it keeps', () => {
        expect(redactSecrets('password = "see token=abcdefghij here"')).toEqual({ text: 'password = "see token=[redacted] here"', count: 1 });
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

    it('scans hostile inputs in linear time: 1 MB each, 4 MB for a JWT run (each well under a second; the old regexes took seconds or threw)', () => {
        const fill = (unit: string): string => unit.repeat(Math.ceil(HOSTILE_BYTES / unit.length));
        const hostile = [
            fill('_token'), fill('token:'), fill('token='), fill(`"'`), fill('=:'), fill('""""""token"""""":x '), fill('token '),
            fill('password'), `"${fill('a_')}token":abcdefghij`, `token${' '.repeat(HOSTILE_BYTES)}x`, `${'a_'.repeat(HOSTILE_BYTES / 2)}password`,
            fill('{"user": "octocat", "password": "correcthorse", "client_secret": "abcdefghij"}\n'),
            fill('-----BEGIN PRIVATE KEY-----'), fill('_eyJaaaaa'),
            // GitHub tokens are unbounded: one long run, repeated short runs, runs one short of a token.
            ` ghs_${'a'.repeat(HOSTILE_BYTES)}`, fill('ghs_'), fill(' ghs_1_'), fill(` ghs_${'a'.repeat(35)}`),
            // JWT segments are unbounded: a run with no dot, and one whose last dot never comes.
            ` eyJ${'a'.repeat(JWT_RUN_BYTES)}`, ` eyJaaaaa.eyJ${'a'.repeat(JWT_RUN_BYTES)}`, fill('.eyJaaaaa'),
            // camelCase keys: chains of them, with and without separators, and boundaries with no keyword.
            fill('aToken'), fill('aToken:'), fill('"aBcToken": "'), fill(` ${'aB'.repeat(40)}`), fill(` ${`${'aToken'.repeat(10)}_`.repeat(17)}`),
        ];
        for (const text of hostile) {
            const started = Date.now();
            redactSecrets(text);
            expect(Date.now() - started).toBeLessThan(HOSTILE_BOUND_MS);
        }
    });

    it('never matches its own placeholder again', () => {
        const once = redactSecrets(`token=${GITHUB_TOKEN}`).text;
        expect(redactSecrets(once)).toEqual({ text: once, count: 0 });
    });
});
