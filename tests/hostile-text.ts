/** Vendor text that tries everything: an escape sequence, a bidi override, a line break and a markdown cell separator. */
export const HOSTILE = 'Sprint 7\u001b[31m red ‮gnp.exe\nsecond line | next cell';

/** The escape and the bidi override HOSTILE carries: never in any output. */
export const TERMINAL_CONTROL = /[\u001b‮]/;

/** Those, or its line break: never inside what is printed as one line. */
export const NOT_ONE_LINE = /[\u001b‮\r\n]/;
