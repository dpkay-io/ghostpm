import * as fs from 'fs';
import * as path from 'path';
import { HANDLED_EVENTS } from '../src/hook/handlers';

const ROOT = path.join(__dirname, '..');
const PLUGIN_ROOT_VAR = '${CLAUDE_PLUGIN_ROOT}';
const HOOK_ENTRY = 'dist/hook.js';

function readJson(relativePath: string): any {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

/** hooks.json shape: { hooks: { <Event>: [ { matcher, hooks: [ { type, command, timeout } ] } ] } } */
function hookEntries(): { event: string; command: string; timeout: unknown; type: string }[] {
    const byEvent = readJson('hooks/hooks.json').hooks;
    const flattened: { event: string; command: string; timeout: unknown; type: string }[] = [];
    for (const event of Object.keys(byEvent)) {
        for (const matcher of byEvent[event]) {
            for (const hook of matcher.hooks) {
                flattened.push({ event, command: hook.command, timeout: hook.timeout, type: hook.type });
            }
        }
    }
    return flattened;
}

describe('plugin packaging', () => {
    it('leaves the standard hooks file to load itself', () => {
        // hooks/hooks.json at the standard path is loaded automatically. Naming it in
        // the manifest as well makes Claude Code reject the entire plugin with
        // "Duplicate hooks file detected", so the manifest must stay silent about it.
        const manifest = readJson('.claude-plugin/plugin.json');
        expect(manifest.name).toBe('ghostpm');
        expect(manifest.hooks).toBeUndefined();
        expect(fs.existsSync(path.join(ROOT, 'hooks', 'hooks.json'))).toBe(true);
    });

    it('ships the skill where Claude Code namespaces it as ghostpm:ghostpm', () => {
        expect(fs.existsSync(path.join(ROOT, 'skills', 'ghostpm', 'SKILL.md'))).toBe(true);
    });

    it('wires exactly the events the handler implements', () => {
        // Config drift both ways: an event wired to no handler fires for nothing, and a
        // handled event left unwired never fires at all.
        const wired = Object.keys(readJson('hooks/hooks.json').hooks).sort();
        expect(wired).toEqual(HANDLED_EVENTS.slice().sort());
    });

    it('runs the hook from the plugin root and names its event', () => {
        for (const entry of hookEntries()) {
            expect(entry.type).toBe('command');
            expect(entry.command).toContain(PLUGIN_ROOT_VAR);
            expect(entry.command).toContain(HOOK_ENTRY);
            // The entry point reads its event from argv, so each wiring must pass it.
            expect(entry.command.indexOf(entry.event)).toBeGreaterThan(-1);
        }
    });

    it('bounds every hook so a slow one cannot hold up a session', () => {
        const entries = hookEntries();
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) {
            expect(typeof entry.timeout).toBe('number');
            expect(entry.timeout as number).toBeGreaterThan(0);
        }
    });

    it('starts the MCP server from the plugin root, never a global binary', () => {
        // The stale registration on this machine points at a globally installed
        // `ghostpm` that predates the ledger entirely. The plugin must not repeat that.
        const server = readJson('.mcp.json').mcpServers.ghostpm;
        expect(server.command).toBe('node');
        expect(server.args.join(' ')).toContain(PLUGIN_ROOT_VAR);
        expect(server.args).toContain('serve');
    });
});
