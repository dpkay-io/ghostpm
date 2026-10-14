import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PmServer } from '../src/mcp-server';
import { openLedger, LEDGER_FILE } from '../src/ledger/db';
import { REMOVED_TOOLS } from '../src/doctor';
import { removeTempDir } from './temp-dir';

const SKILL_PATH = path.join(__dirname, '..', 'skills', 'ghostpm', 'SKILL.md');
const FRONTMATTER_NAME = /^---\r?\nname: ghostpm\r?\n/;

describe('the plugin skill', () => {
    const skill = fs.readFileSync(SKILL_PATH, 'utf8');
    let tools: string[] = [];

    beforeAll(async () => {
        // The tool list comes from the server itself, so the skill cannot drift from what ships.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-skill-'));
        const db = openLedger(path.join(dir, LEDGER_FILE));
        const client = new Client({ name: 'skill-test', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([
            client.connect(clientTransport),
            new PmServer({ db, cwd: dir, sessionId: 'mcp:skill', legacyImport: false }).run(serverTransport),
        ]);
        tools = (await client.listTools()).tools.map(tool => tool.name);
        await client.close();
        db.close();
        removeTempDir(dir);
    });

    it('is named ghostpm, so the plugin namespaces it as ghostpm:ghostpm', () => {
        expect(skill).toMatch(FRONTMATTER_NAME);
    });

    it('documents every tool the server registers', () => {
        expect(tools.length).toBeGreaterThan(0);
        tools.forEach(tool => expect(skill).toContain(tool));
    });

    it.each(REMOVED_TOOLS)('never mentions the removed %s', tool => {
        expect(skill).not.toContain(tool);
    });

    it('knows how to show the machine-wide dashboard', () => {
        expect(skill).toContain('all_workspaces');
    });

    it('says vendor sync is off by default and turned on by ghostpm init', () => {
        expect(skill).toMatch(/sync is off by default/i);
        expect(skill).toContain('ghostpm init');
    });
});
