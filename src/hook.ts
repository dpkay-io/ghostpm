#!/usr/bin/env node
import { readPayload } from './hook/payload';
import { buildOutput } from './hook/output';
import { logHookError } from './hook/log';
import { handle, SESSION_START } from './hook/handlers';
import { recoverFromMissingBinding } from './hook/recover';
import { refreshLauncher } from './plugin-setup';

/** A hook must never block a session, so every path exits 0. */
const EXIT_OK = 0;

function main(): void {
    let stdin = '';
    process.stdin.on('data', chunk => { stdin += chunk; });
    process.stdin.on('end', () => {
        const payload = readPayload(stdin, process.argv[2] ?? '');
        // Apart from the ledger, which may not open: an update must not strand the statusline.
        if (payload.event === SESSION_START) {
            try {
                refreshLauncher();
            } catch (error) {
                logHookError(error);
            }
        }
        let context: string | null = null;
        try {
            context = handle(payload);
        } catch (error) {
            logHookError(error);
            context = recoverFromMissingBinding(payload.event, error);
        }
        process.stdout.write(buildOutput(payload.event, context));
        process.exit(EXIT_OK);
    });
}

main();
