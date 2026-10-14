import * as path from 'path';

/** One character that stands for "there was more here". */
export const ELLIPSIS = '…';

/**
 * Code points, not UTF-16 units, so an emoji counts once. Wide glyphs (CJK, most emoji)
 * still count as one column. ponytail: measure East Asian Width if such titles misalign.
 */
export function visibleLength(text: string): number {
    return Array.from(text).length;
}

/** Fits text into `width` columns without ever splitting a surrogate pair. */
export function truncate(text: string, width: number): string {
    const chars = Array.from(text);
    if (chars.length <= width) return text;
    if (width <= 0) return '';
    return `${chars.slice(0, width - 1).join('')}${ELLIPSIS}`;
}

export function padRight(text: string, width: number): string {
    const gap = width - visibleLength(text);
    return gap > 0 ? `${text}${' '.repeat(gap)}` : text;
}

export function padLeft(text: string, width: number): string {
    const gap = width - visibleLength(text);
    return gap > 0 ? `${' '.repeat(gap)}${text}` : text;
}

const SINGLE_DIGIT_LIMIT = 10;

function twoDigits(value: number): string {
    return value < SINGLE_DIGIT_LIMIT ? `0${value}` : String(value);
}

/**
 * Local `HH:MM:SS`. Absolute rather than "12s ago": the dashboard redraws only when the
 * ledger changes, and an absolute time stays true between redraws.
 */
export function formatClock(date: Date): string {
    return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`;
}

/** Local `YYYY-MM-DD HH:MM`. */
export function formatDateTime(date: Date): string {
    return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

export const NO_WORKSPACE = '(no workspace)';

/** A workspace's folder name. ponytail: two repos with the same folder name read alike; add the parent folder if that confuses anyone. */
export function workspaceLabel(workspacePath: string | null | undefined): string {
    if (!workspacePath) return NO_WORKSPACE;
    return path.basename(workspacePath) || workspacePath;
}

const CSI = '\u001b[';

/** VT100/ANSI sequences, written only when stdout is a terminal. */
export const ANSI = {
    altScreenOn: `${CSI}?1049h`,
    altScreenOff: `${CSI}?1049l`,
    hideCursor: `${CSI}?25l`,
    showCursor: `${CSI}?25h`,
    clearScreen: `${CSI}2J`,
    eraseLine: `${CSI}K`,
    eraseDown: `${CSI}J`,
    bold: `${CSI}1m`,
    dim: `${CSI}2m`,
    yellow: `${CSI}33m`,
    cyan: `${CSI}36m`,
    reset: `${CSI}0m`,
};

/** Moves the cursor to the start of a 1-based row. */
export function cursorTo(row: number): string {
    return `${CSI}${row};1H`;
}
