import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { removeTempDir } from './temp-dir';
import {
    diagnose, DiagnosisProbe, FINDING_STALE_REGISTRATION, FINDING_CLAUDE_JSON_REGISTRATION, FINDING_STALE_SKILL,
    FINDING_NEWER_LEDGER, MCP_SERVER_KEY, REMOVED_TOOLS, machineProbe, quoteForShell, removeDirCommand, skillCandidates,
} from '../src/doctor';
import { PLUGIN_ID } from '../src/help';
import { userSettingsPath } from '../src/plugin-setup';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION, ledgerPath } from '../src/ledger/db';
import { homeDir } from '../src/registry';
import { isolateHomes } from './ledger/helpers';

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
        claudeJson: null,
        skills: [],
        ledgerSchema: SCHEMA_VERSION,
        version: '2.0.0',
        platform: 'win32',
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

    describe('1.4.0 registrations in ~/.claude.json (Review Focus 5)', () => {
        const ONE_FOUR = { command: 'ghostpm', args: ['serve'] };

        it('names the user-scope registration and the command that removes it', () => {
            const findings = diagnose(probe({ claudeJson: JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: ONE_FOUR } }) }));
            const found = findings.filter(finding => finding.code === FINDING_CLAUDE_JSON_REGISTRATION);
            expect(found).toHaveLength(1);
            expect(found[0].fix).toBe(`claude mcp remove ${MCP_SERVER_KEY} -s user`);
            expect(found[0].message).toContain('user-scope');
        });

        it('names each project that registers it, and only those', () => {
            const claudeJson = JSON.stringify({
                projects: {
                    'C:/work/app': { mcpServers: { [MCP_SERVER_KEY]: ONE_FOUR } },
                    'C:/work/other': { mcpServers: { unrelated: { command: 'x' } } },
                    'C:/work/site': { mcpServers: { [MCP_SERVER_KEY]: ONE_FOUR } },
                    'C:/work/plain': {},
                },
            });
            const fixes = diagnose(probe({ claudeJson }))
                .filter(finding => finding.code === FINDING_CLAUDE_JSON_REGISTRATION)
                .map(finding => finding.fix);
            expect(fixes).toEqual([
                `cd 'C:/work/app'; claude mcp remove ${MCP_SERVER_KEY} -s local`,
                `cd 'C:/work/site'; claude mcp remove ${MCP_SERVER_KEY} -s local`,
            ]);
        });

        it('reports nothing on a machine that only has the plugin', () => {
            const claudeJson = JSON.stringify({ mcpServers: { other: {} }, projects: { 'C:/work/app': { mcpServers: {} } } });
            expect(diagnose(probe({ claudeJson }))).toEqual([]);
        });

        it('survives a ~/.claude.json that is malformed or not an object', () => {
            expect(diagnose(probe({ claudeJson: '{ nope' }))).toEqual([]);
            expect(diagnose(probe({ claudeJson: '[]' }))).toEqual([]);
            expect(diagnose(probe({ claudeJson: JSON.stringify({ projects: { 'C:/x': null } }) }))).toEqual([]);
        });
    });

    describe('stale 1.4.0 skills (Review Focus 5)', () => {
        const staleSkill = `---\nname: ghostpm\n---\n| Start working | \`${REMOVED_TOOLS[0]}\` |`;
        const skillMd = (): string => path.join(home, '.claude', 'skills', 'ghostpm', 'SKILL.md');
        const SKILLS_DIR_PLUGIN = JSON.stringify({ name: MCP_SERVER_KEY, version: '1.5.0' });

        it('flags a skill that still names removed tools, with the command that removes its folder', () => {
            const found = diagnose(probe({ skills: [{ skillMd: skillMd(), content: staleSkill }] })).filter(finding => finding.code === FINDING_STALE_SKILL);
            expect(found).toHaveLength(1);
            expect(found[0].fix).toBe(`Remove-Item -Recurse -Force -LiteralPath '${path.dirname(skillMd())}'`);
        });

        it('flags the skills-dir plugin that Phase 2 setup wrote, though its text names no removed tool (C45)', () => {
            const skills = [{ skillMd: skillMd(), content: '---\nname: ghostpm\n---\ncurrent text', pluginJson: SKILLS_DIR_PLUGIN }];
            const found = diagnose(probe({ skills })).filter(finding => finding.code === FINDING_STALE_SKILL);
            expect(found).toHaveLength(1);
            expect(found[0].fix).toBe(`Remove-Item -Recurse -Force -LiteralPath '${path.dirname(skillMd())}'`);
        });

        it('leaves a folder alone whose plugin.json names another plugin or is unreadable', () => {
            const content = '---\nname: something-else\n---\nhello';
            expect(diagnose(probe({ skills: [{ skillMd: skillMd(), content, pluginJson: JSON.stringify({ name: 'other' }) }] }))).toEqual([]);
            expect(diagnose(probe({ skills: [{ skillMd: skillMd(), content, pluginJson: '{ nope' }] }))).toEqual([]);
        });

        it('uses rm outside Windows', () => {
            expect(removeDirCommand('/home/dpk/.claude/skills/ghostpm', 'linux')).toBe("rm -rf '/home/dpk/.claude/skills/ghostpm'");
        });

        it('leaves a skill alone when it names no removed tool', () => {
            expect(diagnose(probe({ skills: [{ skillMd: skillMd(), content: '---\nname: something-else\n---\nhello' }] }))).toEqual([]);
        });

        it('looks in the home and every known project, once each', () => {
            const candidates = skillCandidates('/home/dpk', ['/work/app', '/work/app', '/work/site']);
            expect(candidates).toEqual([
                path.join('/home/dpk', '.claude', 'skills', 'ghostpm', 'SKILL.md'),
                path.join('/work/app', '.claude', 'skills', 'ghostpm', 'SKILL.md'),
                path.join('/work/site', '.claude', 'skills', 'ghostpm', 'SKILL.md'),
            ]);
        });
    });

    describe('a ledger newer than this copy (Review Focus 4)', () => {
        it('names the update commands', () => {
            const found = diagnose(probe({ ledgerSchema: SCHEMA_VERSION + 1 })).filter(finding => finding.code === FINDING_NEWER_LEDGER);
            expect(found).toHaveLength(1);
            expect(found[0].fix).toContain('npm install -g ghostpm@latest');
            expect(found[0].fix).toContain(`claude plugin update ${PLUGIN_ID}`);
        });

        it('stays quiet for the same schema, or no ledger at all', () => {
            expect(diagnose(probe({ ledgerSchema: SCHEMA_VERSION }))).toEqual([]);
            expect(diagnose(probe({ ledgerSchema: null }))).toEqual([]);
        });
    });

    describe('machineProbe', () => {
        it('reads claude.json, skills and the ledger under a scratch home, and creates nothing', () => {
            const restore = isolateHomes(home);
            const previous = process.env.GHOSTPM_HOME;
            const ghostpmHome = path.join(home, '.ghostpm');
            process.env.GHOSTPM_HOME = ghostpmHome;
            try {
                fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: {} } }));
                const dir = path.join(home, '.claude', 'skills', 'ghostpm');
                fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
                fs.writeFileSync(path.join(dir, 'SKILL.md'), 'x');
                fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: MCP_SERVER_KEY }));
                const found = machineProbe();
                expect(found.ledgerSchema).toBeNull();
                expect(found.skills.map(skill => skill.skillMd)).toEqual([path.join(dir, 'SKILL.md')]);
                expect(diagnose(found).map(finding => finding.code)).toEqual([FINDING_CLAUDE_JSON_REGISTRATION, FINDING_STALE_SKILL]);
                expect(fs.existsSync(ghostpmHome)).toBe(false);
            } finally {
                if (previous === undefined) delete process.env.GHOSTPM_HOME; else process.env.GHOSTPM_HOME = previous;
                restore();
            }
        });
    });

    describe('quoting the paths it asks you to paste', () => {
        const NASTY = 'C:/w/a $x `y` "q" it\'s [z]';

        it('single-quotes for PowerShell and doubles an embedded quote', () => {
            expect(quoteForShell(NASTY, 'win32')).toBe("'C:/w/a $x `y` \"q\" it''s [z]'");
        });

        it('single-quotes for POSIX and closes, escapes and reopens an embedded quote', () => {
            expect(quoteForShell(NASTY, 'linux')).toBe("'C:/w/a $x `y` \"q\" it'\\''s [z]'");
        });

        it('uses the quoted, literal form in both removal commands', () => {
            expect(removeDirCommand(NASTY, 'win32')).toBe(`Remove-Item -Recurse -Force -LiteralPath ${quoteForShell(NASTY, 'win32')}`);
            expect(removeDirCommand(NASTY, 'linux')).toBe(`rm -rf ${quoteForShell(NASTY, 'linux')}`);
        });

        it('quotes the project folder in the local-scope fix on both platforms', () => {
            const claudeJson = JSON.stringify({ projects: { [NASTY]: { mcpServers: { [MCP_SERVER_KEY]: {} } } } });
            [ 'win32', 'linux' ].forEach(platform => {
                const fix = diagnose(probe({ claudeJson, platform }))[0].fix;
                expect(fix.startsWith(`cd ${quoteForShell(NASTY, platform)}`)).toBe(true);
            });
        });
    });

    describe('home is os.homedir() everywhere', () => {
        it('ignores HOME and USERPROFILE', () => {
            const restore = isolateHomes(path.join(home, 'real'));
            process.env.HOME = path.join(home, 'env-home');
            process.env.USERPROFILE = path.join(home, 'env-profile');
            try {
                expect(homeDir()).toBe(path.join(home, 'real'));
                expect(userSettingsPath()).toBe(path.join(home, 'real', '.claude', 'settings.json'));
            } finally {
                restore();
            }
        });
    });

    describe('machineProbe on an odd ledger', () => {
        const withScratchLedger = (write: (file: string) => void): ReturnType<typeof machineProbe> => {
            const restore = isolateHomes(home);
            const previous = process.env.GHOSTPM_HOME;
            process.env.GHOSTPM_HOME = path.join(home, '.ghostpm');
            try {
                fs.mkdirSync(process.env.GHOSTPM_HOME, { recursive: true });
                write(ledgerPath());
                return machineProbe();
            } finally {
                if (previous === undefined) delete process.env.GHOSTPM_HOME; else process.env.GHOSTPM_HOME = previous;
                restore();
            }
        };

        it('gives a null schema for a file that is not a database', () => {
            expect(withScratchLedger(file => fs.writeFileSync(file, 'this is not sqlite, '.repeat(20))).ledgerSchema).toBeNull();
        });

        it('reports a newer schema, and then the update finding', () => {
            const found = withScratchLedger(file => {
                const db = new Database(file);
                db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
                db.close();
            });
            expect(found.ledgerSchema).toBe(SCHEMA_VERSION + 1);
            expect(diagnose(found).map(finding => finding.code)).toEqual([FINDING_NEWER_LEDGER]);
        });
    });
});
