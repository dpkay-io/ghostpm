import { spawn } from 'child_process';
import * as path from 'path';
import { MISSING_BINDING_HELP } from '../ledger/db';

const SESSION_START = 'SessionStart';
const CLI_ENTRY = 'cli-main.js';
const BOOTSTRAP_COMMAND = 'bootstrap';

/** Said in the session itself, because nobody goes looking in hook.log. */
export const BOOTSTRAP_NOTICE =
    'GhostPM is compiling its SQLite addon in the background. Task tracking resumes once it finishes.';

export type StartBootstrap = () => void;

/** Detached: compiling takes far longer than the few seconds a hook is allowed. */
const spawnBootstrap: StartBootstrap = () => {
    spawn(process.execPath, [path.join(__dirname, '..', CLI_ENTRY), BOOTSTRAP_COMMAND], {
        detached: true,
        stdio: 'ignore',
    }).unref();
};

/**
 * Turns the one failure a user cannot act on into one that fixes itself, and returns the
 * line to show them. Anything else is left to the caller's log.
 */
export function recoverFromMissingBinding(
    event: string,
    error: unknown,
    start: StartBootstrap = spawnBootstrap,
): string | null {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== MISSING_BINDING_HELP) return null;
    // SessionStart only: it fires once per session, while the prompt and tool hooks fire
    // repeatedly and would each start a competing build in the same directory.
    if (event !== SESSION_START) return null;
    start();
    return BOOTSTRAP_NOTICE;
}
