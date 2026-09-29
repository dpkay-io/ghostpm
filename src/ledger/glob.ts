/** On Windows paths compare case-insensitively, as the filesystem does. */
const GLOB_FLAGS = process.platform === 'win32' ? 'i' : '';
const REGEX_SPECIAL = /[.+^$()|[\]\\{}]/;
const BACKSLASH = /\\/g;

/**
 * `**`, `*`, `?` and `{a,b}`: what plan_globs needs. Not path.matchesGlob: on Node 20 it is
 * experimental (it prints an ExperimentalWarning) and it does not exist before 20.17.
 */
export function globToRegExp(glob: string): RegExp {
    let source = '';
    let openBraces = 0;
    for (let i = 0; i < glob.length; i++) {
        const char = glob[i];
        if (char === '*' && glob[i + 1] === '*') {
            // `**/` spans zero or more whole segments; a trailing `**` spans the rest.
            const wholeSegments = glob[i + 2] === '/';
            source += wholeSegments ? '(?:[^/]*/)*' : '.*';
            i += wholeSegments ? 2 : 1;
        } else if (char === '*') {
            source += '[^/]*';
        } else if (char === '?') {
            source += '[^/]';
        } else if (char === '{') {
            source += '(?:';
            openBraces++;
        } else if (char === '}' && openBraces > 0) {
            source += ')';
            openBraces--;
        } else if (char === ',' && openBraces > 0) {
            source += '|';
        } else {
            source += REGEX_SPECIAL.test(char) ? `\\${char}` : char;
        }
    }
    return new RegExp(`^${source}$`, GLOB_FLAGS);
}

/** `relativePath` may use either separator. */
export function matchesAnyGlob(relativePath: string, globs: readonly string[]): boolean {
    const normalized = relativePath.replace(BACKSLASH, '/');
    return globs.some(glob => globToRegExp(glob).test(normalized));
}
