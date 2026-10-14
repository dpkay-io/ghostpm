/** Every flag the CLI reads, named once. */
export const FLAG_PREFIX = '--';
export const FLAG_ONCE = '--once';

export function hasFlag(args: readonly string[], name: string): boolean {
    return args.indexOf(name) >= 0;
}

export const FLAG_SINCE = '--since';

/** `--name value` or `--name=value`; undefined when absent. A flag with no value is an error, not a silent default. */
export function flagValue(args: readonly string[], name: string): string | undefined {
    const inline = `${name}=`;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg.indexOf(inline) === 0) return arg.slice(inline.length);
        if (arg !== name) continue;
        const value = args[index + 1];
        if (value === undefined || value.indexOf(FLAG_PREFIX) === 0) throw new Error(`${name} needs a value.`);
        return value;
    }
    return undefined;
}

export const FLAG_ALL = '--all';
export const FLAG_YES = '--yes';

/** The first argument that is not a flag, e.g. `ghostpm unregister [path] --yes`. */
export function firstPositional(args: readonly string[]): string | undefined {
    for (const arg of args) if (arg.indexOf(FLAG_PREFIX) !== 0) return arg;
    return undefined;
}
export const FLAG_VERSION = '--version';
export const FLAG_VERSION_SHORT = '-v';
export const FLAG_STATUSLINE = '--statusline';
export const FLAG_RESTORE = '--restore';
