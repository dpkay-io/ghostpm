/** Every flag the CLI reads, named once. */
export const FLAG_PREFIX = '--';
export const FLAG_ONCE = '--once';

export function hasFlag(args: readonly string[], name: string): boolean {
    return args.indexOf(name) >= 0;
}
