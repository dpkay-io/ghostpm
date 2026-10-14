/** Vendor text that tries everything: an escape sequence, a bidi override, a line break and a markdown cell separator. */
export const HOSTILE = 'Sprint 7\u001b[31m red \u202Egnp.exe\nsecond line | next cell';

/** The escape and the bidi override HOSTILE carries: never in any output. */
export const TERMINAL_CONTROL = /[\u001b\u202e]/;

/** A remote GhostPM reads as GitHub (it names github.com) but names no repository sync can read, with an escape in it. */
export const UNREADABLE_REMOTE = 'https://www.github.com/acme/widgets\u001b[31m.git';

/** Those, or its line break: never inside what is printed as one line. */
export const NOT_ONE_LINE = /[\u001b\u202e\r\n]/;
