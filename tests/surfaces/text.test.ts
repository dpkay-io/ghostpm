import { ELLIPSIS, truncate, visibleLength } from '../../src/surfaces/text';

describe('text helpers', () => {
    it('leaves text that fits alone', () => {
        expect(truncate('abc', 5)).toBe('abc');
        expect(truncate('abc', 3)).toBe('abc');
    });

    it('cuts to the width, ending in an ellipsis', () => {
        expect(truncate('abcdef', 4)).toBe(`abc${ELLIPSIS}`);
        expect(truncate('abcdef', 1)).toBe(ELLIPSIS);
        expect(truncate('abcdef', 0)).toBe('');
    });

    it('never splits an emoji in half', () => {
        expect(visibleLength('a😀b')).toBe(3);
        expect(truncate('a😀bc', 3)).toBe(`a😀${ELLIPSIS}`);
    });
});
