import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '../ledger/db';

const DAYS_PER_WEEK = 7;
const MS_PER_UNIT: { [unit: string]: number } = {
    m: MS_PER_MINUTE,
    h: MS_PER_HOUR,
    d: MS_PER_DAY,
    w: DAYS_PER_WEEK * MS_PER_DAY,
};
const DURATION = /^(\d+)\s*([mhdw])$/i;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}/;
const DAYS_BACK: { [keyword: string]: number } = { today: 0, yesterday: 1 };

export const SINCE_HELP =
    'Use a duration (90m, 36h, 2d, 1w), a date (2026-09-28), a date and time (2026-09-28T09:00), today or yesterday.';

function localMidnight(now: Date, daysBack: number): Date {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
}

function isValid(date: Date): boolean {
    return !isNaN(date.getTime());
}

/** new Date(2026, 1, 30) quietly becomes 2 March; a date that does not round-trip was never a date. */
function isCalendarDate(year: number, month: number, date: number): boolean {
    const check = new Date(Date.UTC(year, month, date));
    return check.getUTCFullYear() === year && check.getUTCMonth() === month && check.getUTCDate() === date;
}

/**
 * Reads `--since` and the timeline tool's `since`. Dates and times without a zone are local
 * time, which is what a person means by "since 9:00". Anything else is an error naming the
 * accepted forms: a typo must never read as "nothing happened".
 */
export function parseSince(input: string, now: Date = new Date()): Date {
    const value = input.trim();
    const keyword = value.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(DAYS_BACK, keyword)) return localMidnight(now, DAYS_BACK[keyword]);

    const duration = value.match(DURATION);
    if (duration && Number(duration[1]) > 0) {
        const start = new Date(now.getTime() - Number(duration[1]) * MS_PER_UNIT[duration[2].toLowerCase()]);
        if (isValid(start)) return start;
    }

    const day = value.match(DATE_ONLY);
    if (day) {
        const year = Number(day[1]);
        const month = Number(day[2]) - 1;
        const date = Number(day[3]);
        if (isCalendarDate(year, month, date)) return new Date(year, month, date);
    }

    const dateTime = value.match(DATE_TIME);
    if (dateTime && isCalendarDate(Number(dateTime[1]), Number(dateTime[2]) - 1, Number(dateTime[3]))) {
        const start = new Date(value);
        if (isValid(start)) return start;
    }

    throw new Error(`Cannot read since "${input}". ${SINCE_HELP}`);
}
