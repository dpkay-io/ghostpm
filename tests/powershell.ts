import { SpawnSyncReturns, spawnSync } from 'child_process';

/** The PowerShell on this machine, if any: pwsh first, then Windows PowerShell. Tests that run a pasted hint skip without one. */
export const POWERSHELL = ['pwsh', 'powershell'].find(name => spawnSync(name, ['-NoProfile', '-Command', '1']).status === 0);

/** A progress bar would land on stderr, which these tests expect empty. */
const PROGRESS_OFF = "$ProgressPreference = 'SilentlyContinue'; ";

/** Runs `script` as a person's paste would, with no profile; encoded, so no quoting of ours comes between. */
export function runPowerShell(script: string, env: NodeJS.ProcessEnv = process.env): SpawnSyncReturns<string> {
    const encoded = Buffer.from(PROGRESS_OFF + script, 'utf16le').toString('base64');
    return spawnSync(POWERSHELL as string, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', env });
}
