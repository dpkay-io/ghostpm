import { ELLIPSIS, formatClock, formatDateTime, padLeft, padRight, truncate, visibleLength, workspaceLabel, NO_WORKSPACE, cleanText } from '../../src/surfaces/text';

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
        expect(visibleLength('a😀b')).toBe(4);
        expect(truncate('a😀bc', 4)).toBe(`a😀${ELLIPSIS}`);
        expect(truncate('a😀bc', 3)).toBe(`a${ELLIPSIS}`);
    });
});

describe('layout helpers', () => {
    it('pads to a width and leaves longer text alone', () => {
        expect(padRight('ab', 4)).toBe('ab  ');
        expect(padLeft('7', 3)).toBe('  7');
        expect(padRight('abcdef', 3)).toBe('abcdef');
    });

    it('formats local clock and date-time with zero padding', () => {
        const at = new Date(2026, 0, 5, 7, 8, 9);
        expect(formatClock(at)).toBe('07:08:09');
        expect(formatDateTime(at)).toBe('2026-01-05 07:08');
    });

    it('labels a workspace by its folder name', () => {
        expect(workspaceLabel('/work/repos/wa-tasks')).toBe('wa-tasks');
        expect(workspaceLabel(null)).toBe(NO_WORKSPACE);
    });
});

describe('terminal columns and control characters (I2)', () => {
    it('counts wide glyphs as two columns and combining marks and joiners as none', () => {
        expect(visibleLength('漢字')).toBe(4);
        expect(visibleLength('한글')).toBe(4);
        expect(visibleLength('ＡＢ')).toBe(4);
        expect(visibleLength('😀')).toBe(2);
        expect(visibleLength('é')).toBe(1);
        expect(visibleLength('a‍b')).toBe(2);
    });

    it('truncates and pads by columns, never splitting a wide glyph past the width', () => {
        expect(visibleLength(truncate('漢字漢字漢字', 7))).toBeLessThanOrEqual(7);
        expect(truncate('漢字', 4)).toBe('漢字');
        expect(visibleLength(padRight('漢', 4))).toBe(4);
        expect(padLeft('😀', 4)).toBe('  😀');
    });

    it('replaces control characters, including newline and escape, with a space', () => {
        expect(cleanText('a\nb\u001b[31mc\td\u0085e')).toBe('a b [31mc d e');
        expect(cleanText('plain')).toBe('plain');
    });

    it('truncate output never carries a control character', () => {
        expect(truncate('x\ny', 10)).toBe('x y');
    });
});
