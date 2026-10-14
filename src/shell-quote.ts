// Paths in the commands GhostPM asks a person to paste. No imports: the SessionStart hook loads this (via the sync schedule).

export const WINDOWS = 'win32';

/** PowerShell reads these as single quotes too (U+2018, U+2019, U+201A, U+201B), so each must be doubled like the ASCII one. */
const POWERSHELL_QUOTES = /['‘’‚‛]/g;

/**
 * A path pasted into a shell. Paths are untrusted (a repo folder can be named anything), so single quotes: nothing inside
 * them expands in PowerShell or in POSIX shells. The shell is the one on this machine unless a caller names another.
 */
export function quoteForShell(value: string, platform: string = process.platform): string {
    return platform === WINDOWS ? `'${value.replace(POWERSHELL_QUOTES, quote => quote + quote)}'` : `'${value.split("'").join("'\\''")}'`;
}

/** Local scope is keyed by the folder, so the next command must run in exactly it. -LiteralPath: `cd` reads [ and ] as wildcards and can land in a sibling. */
export function changeDirCommand(dir: string, platform: string = process.platform): string {
    return platform === WINDOWS ? `Set-Location -LiteralPath ${quoteForShell(dir, platform)}` : `cd ${quoteForShell(dir, platform)}`;
}
