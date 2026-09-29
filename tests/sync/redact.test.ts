import { redactSecrets, REDACTED } from '../../src/sync/redact';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ADO_PAT_52 = Array.from({ length: 52 }, (_, i) => BASE32[(i * 7) % BASE32.length]).join('');
/** The 84-character Azure DevOps PAT shape: `AZDO` at 76-79 (per Microsoft's announcement; unverified against a real PAT). */
const ADO_PAT_84 = `${'A'.repeat(52)}${'b'.repeat(24)}AZDO${'c'.repeat(4)}`;
const GITHUB_TOKEN = `ghp_${'a1'.repeat(18)}`;
/** 100 KB of `a_`: a scan that restarts at every character takes ~17 s on it (measured); a linear one a few ms. */
const IDENTIFIER_RUN_PAIRS = 50000;
const LINEAR_BOUND_MS = 1000;
const JWT ='eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

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

    it('stays linear on a long run of identifier characters (a quadratic pattern takes seconds here)', () => {
        const started = Date.now();
        redactSecrets(`${'a_'.repeat(IDENTIFIER_RUN_PAIRS)}password`);
        expect(Date.now() - started).toBeLessThan(LINEAR_BOUND_MS);
    });

    it('never matches its own placeholder again', () => {
        const once = redactSecrets(`token=${GITHUB_TOKEN}`).text;
        expect(redactSecrets(once)).toEqual({ text: once, count: 0 });
    });
});
