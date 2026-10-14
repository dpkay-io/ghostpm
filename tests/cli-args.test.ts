import { FLAG_SINCE, FLAG_YES, flagValue, firstPositional } from '../src/cli-args';

describe('firstPositional', () => {
    it('skips flags', () => {
        expect(firstPositional([FLAG_YES, 'C:/work/app'])).toBe('C:/work/app');
        expect(firstPositional([FLAG_YES])).toBeUndefined();
    });
});

describe('flagValue', () => {
    it('reads a value given as the next argument or after =', () => {
        expect(flagValue(['--since', '2d'], FLAG_SINCE)).toBe('2d');
        expect(flagValue(['--since=yesterday'], FLAG_SINCE)).toBe('yesterday');
        expect(flagValue(['--once', '--since', '-1d'], FLAG_SINCE)).toBe('-1d');
    });

    it('is undefined when the flag is absent', () => {
        expect(flagValue(['--once'], FLAG_SINCE)).toBeUndefined();
    });

    it('refuses a flag with no value instead of guessing one (Review Focus 3)', () => {
        expect(() => flagValue(['--since'], FLAG_SINCE)).toThrow('--since needs a value.');
        expect(() => flagValue(['--since', '--once'], FLAG_SINCE)).toThrow('--since needs a value.');
    });

    it('passes an empty value on for the parser to reject', () => {
        expect(flagValue(['--since='], FLAG_SINCE)).toBe('');
    });
});
