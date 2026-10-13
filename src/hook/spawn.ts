import { spawn } from 'child_process';
import { CLI_ENTRY_PATH } from '../plugin-setup';

/**
 * Runs `ghostpm <args>` from the running copy, detached (the work outlives the few seconds a
 * hook is allowed) and hidden (no console window flashing up on Windows).
 */
export function spawnCliDetached(...args: string[]): void {
    spawn(process.execPath, [CLI_ENTRY_PATH, ...args], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
