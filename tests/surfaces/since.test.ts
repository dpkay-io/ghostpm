import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '../../src/ledger/db';
import { SINCE_HELP, parseSince } from '../../src/surfaces/since';

// Local time on purpose: dates without a zone mean the user's own clock.
const NOW = new Date(2026, 8, 29, 15, 30, 0);

describe('parseSince (Review Focus 3)', () => {
    it('defines an hour as sixty minutes, once', () => {
        expect(MS_PER_HOUR).toBe(60 * MS_PER_MINUTE);
    });

    it.each([
        ['2d', NOW.getTime() - 2 * MS_PER_DAY],
        ['36h', NOW.getTime() - 36 * MS_PER_HOUR],
        ['90m', NOW.getTime() - 90 * MS_PER_MINUTE],
        ['1w', NOW.getTime() - 7 * MS_PER_DAY],
        ['2D', NOW.getTime() - 2 * MS_PER_DAY],
        [' 2d ', NOW.getTime() - 2 * MS_PER_DAY],
        ['2 d', NOW.getTime() - 2 * MS_PER_DAY],
    ])('reads the duration %p', (input, expected) => {
        expect(parseSince(input as string, NOW).getTime()).toBe(expected);
    });

    it('reads today and yesterday as local midnight', () => {
        expect(parseSince('today', NOW)).toEqual(new Date(2026, 8, 29));
        expect(parseSince('Yesterday', NOW)).toEqual(new Date(2026, 8, 28));
        expect(parseSince('yesterday', new Date(2026, 9, 1, 8))).toEqual(new Date(2026, 8, 30));
    });

    it('reads a date as local midnight and a date-time without a zone as local time', () => {
        expect(parseSince('2026-09-28', NOW)).toEqual(new Date(2026, 8, 28));
        expect(parseSince('2026-09-28T09:00', NOW)).toEqual(new Date(2026, 8, 28, 9, 0));
    });

    it('honours an explicit zone', () => {
        expect(parseSince('2026-09-28T09:00:00Z', NOW).getTime()).toBe(Date.UTC(2026, 8, 28, 9, 0, 0));
        expect(parseSince('2026-09-28T09:00:00.000+05:30', NOW).getTime()).toBe(Date.UTC(2026, 8, 28, 3, 30, 0));
    });

    it.each(['', 'Monday', '2 days', '-1d', '0h', '99999999999d', '2026-02-30', '2026-09-28Tsoon', 'soon', '__proto__'])(
        'refuses %p with the accepted forms instead of reporting nothing',
        input => {
            expect(() => parseSince(input, NOW)).toThrow(SINCE_HELP);
        },
    );
});
