import { ELLIPSIS, formatClock, formatDateTime, padLeft, padRight, truncate, visibleLength, workspaceLabel, NO_WORKSPACE } from '../../src/surfaces/text';

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
