import { globToRegExp, matchesAnyGlob } from '../../src/ledger/glob';

const PLAN_GLOBS = ['docs/**/{specs,plans}/**/*.md'];

describe('plan_globs matching', () => {
    it.each([
        ['docs/superpowers/specs/ledger.md', true],
        ['docs/specs/ledger.md', true],
        ['docs/superpowers/plans/2026/phase3.md', true],
        ['docs/superpowers/specs/ledger.txt', false],
        ['src/specs/ledger.md', false],
        ['docs/superpowers/notes/ledger.md', false],
    ])('%s matches the default: %s', (file, expected) => {
        expect(matchesAnyGlob(file, PLAN_GLOBS)).toBe(expected);
    });

    it('accepts Windows separators', () => {
        expect(matchesAnyGlob('docs\\superpowers\\plans\\x.md', PLAN_GLOBS)).toBe(true);
    });

    it('keeps * and ? inside one path segment', () => {
        expect(globToRegExp('notes/*.md').test('notes/a.md')).toBe(true);
        expect(globToRegExp('notes/*.md').test('notes/deep/a.md')).toBe(false);
        expect(globToRegExp('v?.md').test('v1.md')).toBe(true);
        expect(globToRegExp('v?.md').test('v/.md')).toBe(false);
    });

    it('treats regex characters in a glob as literal text', () => {
        expect(globToRegExp('notes/(draft)+.md').test('notes/(draft)+.md')).toBe(true);
        expect(globToRegExp('notes/(draft)+.md').test('notes/draftdraft.md')).toBe(false);
    });

    it('matches any of several globs', () => {
        expect(matchesAnyGlob('rfc/0001.md', ['docs/**/*.md', 'rfc/*.md'])).toBe(true);
    });
});
