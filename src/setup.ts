import { openLedger, ledgerPath } from './ledger/db';
import { chainStatusline, userSettingsPath } from './plugin-setup';

export interface SetupOptions {
    silent?: boolean;
}

/**
 * Only what the plugin cannot do: chain the statusline. The MCP server, the hooks and the
 * skill ship in the plugin (.mcp.json, hooks/hooks.json, skills/ghostpm/SKILL.md), so setup
 * registers no server and writes no skill. A second copy of either is what 1.4.0 left behind.
 */
export function setupStatusline(options: SetupOptions = {}): void {
    const settingsPath = userSettingsPath();
    const db = openLedger(ledgerPath());
    try {
        chainStatusline(db, settingsPath);
    } finally {
        db.close();
    }
    if (options.silent) return;
    console.log('Statusline chained:');
    console.log(`  + ${settingsPath}`);
    console.log('Run `ghostpm setup --restore` to undo it.');
}
