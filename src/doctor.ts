import * as fs from 'fs';
import { STATUSLINE_COMMAND } from './plugin-setup';

export const FINDING_STALE_REGISTRATION = 'stale_registration';
export const FINDING_STATUSLINE_UNCHAINED = 'statusline_unchained';

/** The bare binary name a registration uses when it launches the global install. */
const GLOBAL_BINARY = 'ghostpm';

export interface Finding {
    code: string;
    message: string;
    /** What the user would run or change. doctor never does it for them. */
    fix: string;
}

export interface DiagnosisProbe {
    /** Settings file to inspect. Injected so this never reads the real one in tests. */
    settingsPath: string;
    /** Where the `ghostpm` binary resolves, or null when it is not on PATH. */
    resolveGlobal: () => string | null;
    /** Whether an install directory contains the ledger, i.e. Phase 1 or later. */
    hasLedgerCode: (installDir: string) => boolean;
}

interface Settings {
    mcpServers?: { [name: string]: { command?: unknown } };
    statusLine?: { command?: unknown };
}

function readSettings(settingsPath: string): Settings {
    try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        return parsed !== null && typeof parsed === 'object' ? parsed as Settings : {};
    } catch {
        // Missing or malformed: nothing to diagnose, and never a reason to throw.
        return {};
    }
}

function staleRegistration(settings: Settings, probe: DiagnosisProbe): Finding | null {
    // Only a registration that launches the bare binary would run the global install;
    // one naming an explicit path runs that path, whatever else is installed.
    if (settings.mcpServers?.ghostpm?.command !== GLOBAL_BINARY) return null;
    const installDir = probe.resolveGlobal();
    if (installDir === null || probe.hasLedgerCode(installDir)) return null;
    return {
        code: FINDING_STALE_REGISTRATION,
        message: `MCP server points at the global ${GLOBAL_BINARY} install at ${installDir}, which has no ledger code. Sessions are running a build from before the ledger existed.`,
        fix: 'Install the plugin from this repo so the server starts from the plugin root instead.',
    };
}

function unchainedStatusline(settings: Settings): Finding | null {
    const configured = settings.statusLine?.command;
    if (typeof configured !== 'string' || configured.length === 0) return null;
    if (configured.indexOf(STATUSLINE_COMMAND) >= 0) return null;
    return {
        code: FINDING_STATUSLINE_UNCHAINED,
        message: `Statusline runs "${configured}" directly, so the active task is not shown.`,
        fix: `Chain it: run ${STATUSLINE_COMMAND}, which runs "${configured}" and appends the active task.`,
    };
}

/** Read-only by design: safe to run before deciding anything. */
export function diagnose(probe: DiagnosisProbe): Finding[] {
    const settings = readSettings(probe.settingsPath);
    const findings: Finding[] = [];
    const stale = staleRegistration(settings, probe);
    if (stale !== null) findings.push(stale);
    const statusline = unchainedStatusline(settings);
    if (statusline !== null) findings.push(statusline);
    return findings;
}
