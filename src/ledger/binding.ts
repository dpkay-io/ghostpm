import * as path from 'path';
import { getGhostpmHome } from '../registry';

/** Where a bootstrapped addon lives, relative to the ghostpm home. */
export const BINDING_DIR = 'native';
export const BINDING_FILE = 'better_sqlite3.node';

/** The text the `bindings` package uses when no compiled addon is on disk. */
const MISSING_BINDING_MARKER = 'Could not locate the bindings file';

/**
 * The ghostpm home, not the plugin directory: ${CLAUDE_PLUGIN_ROOT} is scoped to a single
 * version and replaced on every update, and a plain CLI install has no plugin root at all.
 * One copy here serves the hooks, the MCP server and the CLI alike.
 */
export function bootstrappedBindingPath(home: string = getGhostpmHome()): string {
    return path.join(home, BINDING_DIR, BINDING_FILE);
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
