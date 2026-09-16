import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { removeTempDir } from './temp-dir';
import { diagnose, DiagnosisProbe, FINDING_STALE_REGISTRATION, FINDING_STATUSLINE_UNCHAINED } from '../src/doctor';

const PLUGIN_ARGS = ['${CLAUDE_PLUGIN_ROOT}/dist/cli-main.js', 'serve'];

describe('diagnose', () => {
    let home: string;
    let settingsPath: string;

    const writeSettings = (settings: unknown): void => {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    };

    const probe = (over: Partial<DiagnosisProbe> = {}): DiagnosisProbe => ({
        settingsPath,
        resolveGlobal: () => null,
        hasLedgerCode: () => false,
        ...over,
    });

    const codesFrom = (p: DiagnosisProbe): string[] => diagnose(p).map(finding => finding.code);

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-doctor-'));
        settingsPath = path.join(home, 'settings.json');
    });

    afterEach(() => {
        removeTempDir(home);
    });

    it('flags a registration pointing at a global install with no ledger code', () => {
        // Exactly the state found on this machine: mcpServers.ghostpm -> "ghostpm",
        // resolving to a build that predates the ledger entirely.
        writeSettings({ mcpServers: { ghostpm: { command: 'ghostpm', args: ['serve'] } } });

        const codes = codesFrom(probe({
            resolveGlobal: () => 'C:/nvm4w/nodejs/node_modules/ghostpm',
            hasLedgerCode: () => false,
        }));

        expect(codes).toContain(FINDING_STALE_REGISTRATION);
    });

    it('does not flag a global install that does carry ledger code', () => {
        writeSettings({ mcpServers: { ghostpm: { command: 'ghostpm', args: ['serve'] } } });

        const codes = codesFrom(probe({
            resolveGlobal: () => 'C:/nvm4w/nodejs/node_modules/ghostpm',
            hasLedgerCode: () => true,
        }));

        expect(codes).not.toContain(FINDING_STALE_REGISTRATION);
    });

    it('does not flag a registration that already runs from the plugin root', () => {
        writeSettings({ mcpServers: { ghostpm: { command: 'node', args: PLUGIN_ARGS } } });

        expect(codesFrom(probe())).not.toContain(FINDING_STALE_REGISTRATION);
    });

    it('reports an unchained statusline, and stops reporting it once chained', () => {
        writeSettings({ statusLine: { type: 'command', command: 'claude-ticker' } });
        expect(codesFrom(probe())).toContain(FINDING_STATUSLINE_UNCHAINED);

        writeSettings({ statusLine: { type: 'command', command: 'ghostpm statusline' } });
        expect(codesFrom(probe())).not.toContain(FINDING_STATUSLINE_UNCHAINED);
    });

    it('says nothing about a statusline that was never configured', () => {
        writeSettings({ mcpServers: {} });

        expect(codesFrom(probe())).not.toContain(FINDING_STATUSLINE_UNCHAINED);
    });

    it('changes nothing on disk', () => {
        // The whole point of doctor: it is safe to run before deciding anything.
        writeSettings({ mcpServers: { ghostpm: { command: 'ghostpm', args: ['serve'] } }, statusLine: { type: 'command', command: 'claude-ticker' } });
        const before = fs.readFileSync(settingsPath, 'utf8');

        diagnose(probe({ resolveGlobal: () => 'C:/somewhere/ghostpm' }));

        expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
    });

    it('survives a settings file that is missing or unreadable', () => {
        expect(() => diagnose(probe())).not.toThrow();

        fs.writeFileSync(settingsPath, '{ not valid json', 'utf8');
        expect(() => diagnose(probe())).not.toThrow();
    });

    it('describes every finding it reports', () => {
        writeSettings({ mcpServers: { ghostpm: { command: 'ghostpm', args: ['serve'] } }, statusLine: { type: 'command', command: 'claude-ticker' } });

        const findings = diagnose(probe({ resolveGlobal: () => 'C:/somewhere/ghostpm' }));

        expect(findings.length).toBeGreaterThan(0);
        for (const finding of findings) {
            expect(typeof finding.code).toBe('string');
            expect(finding.message.length).toBeGreaterThan(0);
            expect(finding.fix.length).toBeGreaterThan(0);
        }
    });
});
