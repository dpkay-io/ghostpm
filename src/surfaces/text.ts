import * as path from 'path';

/** One character that stands for "there was more here". */
export const ELLIPSIS = '…';

/** Control characters (C0, DEL, C1), line and paragraph separators, and bidi controls (they enable title spoofing). */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

/**
 * Titles come from other tools (vendor items, session cwd): a newline would break the frame
 * and an ESC would let them drive the terminal, so each becomes a space.
 */
export function cleanText(text: string): string {
    return text.replace(CONTROL_CHARACTERS, ' ');
}

type CodePointRange = readonly [number, number];

/** Combining marks, joiners, variation selectors: no column of their own. */
const ZERO_WIDTH: readonly CodePointRange[] = [
    [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x064b, 0x065f], [0x1ab0, 0x1aff],
    [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0x1f3fb, 0x1f3ff], [0xe0100, 0xe01ef],
];

/** East Asian wide and fullwidth forms, Hangul, and the emoji planes: two columns. */
const DOUBLE_WIDTH: readonly CodePointRange[] = [
    [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
    [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x3fffd],
    // Emoji and symbols terminals draw wide. Over-counting is the safe side: a line may end early, never overflow.
    [0x231a, 0x231b], [0x23e9, 0x23f3], [0x25fd, 0x25fe], [0x2600, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
    [0x1f000, 0x1f2ff], [0x1f300, 0x1faff],
];

const inRanges = (codePoint: number, ranges: readonly CodePointRange[]): boolean =>
    ranges.some(([from, to]) => codePoint >= from && codePoint <= to);

/** Terminal columns one character takes. ponytail: a ZWJ emoji sequence counts each emoji, not one glyph. */
function columnsOf(character: string): number {
    const codePoint = character.codePointAt(0)!;
    if (inRanges(codePoint, ZERO_WIDTH)) return 0;
    return inRanges(codePoint, DOUBLE_WIDTH) ? 2 : 1;
}

const EMOJI_SELECTOR = 0xfe0f;
const EMOJI_COLUMNS = 2;

interface Cluster {
    text: string;
    columns: number;
}

/** Characters with the zero-width marks that follow them. A trailing U+FE0F asks for the emoji form: two columns. */
function clusters(text: string): Cluster[] {
    const result: Cluster[] = [];
    for (const character of Array.from(text)) {
        const columns = columnsOf(character);
        const last = result[result.length - 1];
        if (columns === 0 && last !== undefined) {
            last.text += character;
            if (character.codePointAt(0) === EMOJI_SELECTOR) last.columns = EMOJI_COLUMNS;
        } else {
            result.push({ text: character, columns });
        }
    }
    return result;
}

/** Terminal columns the text occupies. */
export function visibleLength(text: string): number {
    return clusters(text).reduce((columns, cluster) => columns + cluster.columns, 0);
}

/** Fits text into `width` columns without splitting a surrogate pair or a wide glyph; control characters become spaces. */
export function truncate(text: string, width: number): string {
    const clean = cleanText(text);
    if (visibleLength(clean) <= width) return clean;
    if (width <= 0) return '';
    const budget = width - visibleLength(ELLIPSIS);
    let used = 0;
    let kept = '';
    for (const cluster of clusters(clean)) {
        used += cluster.columns;
        if (used > budget) break;
        kept += cluster.text;
    }
    return `${kept}${ELLIPSIS}`;
}


export function padRight(text: string, width: number): string {
    const clean = cleanText(text);
    const gap = width - visibleLength(clean);
    return gap > 0 ? `${clean}${' '.repeat(gap)}` : clean;
}

export function padLeft(text: string, width: number): string {
    const clean = cleanText(text);
    const gap = width - visibleLength(clean);
    return gap > 0 ? `${' '.repeat(gap)}${clean}` : clean;
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

const COLUMN_GAP = '  ';
const TRAILING_SPACE = /\s+$/;

/** Left-aligned columns. Cells longer than maxCellWidth are truncated; the last column is never padded. */
export function alignColumns(rows: string[][], maxCellWidth: number): string[] {
    const cells = rows.map(row => row.map(cell => truncate(cell, maxCellWidth)));
    const widths: number[] = [];
    cells.forEach(row => row.forEach((cell, index) => { widths[index] = Math.max(widths[index] ?? 0, visibleLength(cell)); }));
    return cells.map(row => row
        .map((cell, index) => (index === row.length - 1 ? cell : padRight(cell, widths[index])))
        .join(COLUMN_GAP)
        .replace(TRAILING_SPACE, ''));
}
