import { redactSecrets, REDACTED } from '../../src/sync/redact';

describe('redactSecrets (spec §8.9)', () => {
    it.each([
        ['GitHub token', `use ghp_${'a1'.repeat(18)} to push`],
        ['fine-grained GitHub token', `github_pat_${'A'.repeat(22)}_${'b'.repeat(59)}`],
        ['AWS access key id', 'key AKIAIOSFODNN7EXAMPLE here'],
        ['Slack token', 'xoxb-1234567890-abcdefghij'],
        ['API key', `sk-ant-api03-${'x'.repeat(40)}`],
        ['Google API key', `AIza${'B'.repeat(35)}`],
        ['private key block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'],
        ['password assignment', 'password=hunter2hunter2'],
        ['api_key assignment', 'api_key: 9f8e7d6c5b4a'],
    ])('redacts a %s', (_kind, text) => {
        const result = redactSecrets(text);
        expect(result.count).toBe(1);
        expect(result.text).toContain(REDACTED);
    });

    it('leaves ordinary text alone', () => {
        const text = 'Fix the token refresh bug — see password reset flow (T42)';
        expect(redactSecrets(text)).toEqual({ text, count: 0 });
    });

    it('counts every match', () => {
        expect(redactSecrets('password=aaaaaaa1 and token=bbbbbbb2').count).toBe(2);
    });
});
