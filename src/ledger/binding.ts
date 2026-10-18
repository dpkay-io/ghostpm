import * as path from 'path';
import { getGhostpmHome } from '../registry';

/** Where a bootstrapped addon lives, relative to the ghostpm home. */
export const BINDING_DIR = 'native';
export const BINDING_FILE = 'better_sqlite3.node';

/** The text the `bindings` package uses when no compiled addon is on disk. */
const MISSING_BINDING_MARKER = 'Could not locate the bindings file';
/** Node's code and text when an addon was compiled for another NODE_MODULE_VERSION (another Node.js major). */
const DLOPEN_FAILED = 'ERR_DLOPEN_FAILED';
const WRONG_NODE_MARKER = 'NODE_MODULE_VERSION';

/**
 * An addon loads only into the platform, CPU and Node.js ABI it was compiled for. One folder each, so a Node.js switch
 * (nvm, an upgrade) never loads, reuses or overwrites another Node.js's build, and Node.js versions can take turns.
 */
export function abiFolder(): string {
    return `${process.platform}-${process.arch}-${process.versions.modules}`;
}

/**
 * The ghostpm home, not the plugin directory: ${CLAUDE_PLUGIN_ROOT} is scoped to a single
 * version and replaced on every update, and a plain CLI install has no plugin root at all.
 * One copy here serves the hooks, the MCP server and the CLI alike.
 */
export function bootstrappedBindingPath(home: string = getGhostpmHome()): string {
    return path.join(home, BINDING_DIR, abiFolder(), BINDING_FILE);
}

/** As narrow as isMissingBinding: a dlopen failure with any other cause (a missing DLL, a corrupt file) is not this. */
export function isWrongNodeBinding(error: unknown): boolean {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === DLOPEN_FAILED
        && error.message.indexOf(WRONG_NODE_MARKER) >= 0;
}

/**
 * Matches on the message because `bindings` throws a plain Error carrying no code.
 * Deliberately narrow: a corrupt database or a permissions failure must not be mistaken
 * for a missing addon and sent down the bootstrap path.
 */
export function isMissingBinding(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.indexOf(MISSING_BINDING_MARKER) >= 0;
}
