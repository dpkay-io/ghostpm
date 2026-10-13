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
