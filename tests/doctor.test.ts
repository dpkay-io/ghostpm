import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { removeTempDir } from './temp-dir';
import {
    diagnose, DiagnosisProbe, FINDING_STALE_REGISTRATION, FINDING_CLAUDE_JSON_REGISTRATION, FINDING_STALE_SKILL,
    FINDING_NEWER_LEDGER, FINDING_NODE_TOO_OLD, MCP_SERVER_KEY, REMOVED_TOOLS, changeDirCommand, machineProbe, quoteForShell,
    removeDirCommand, skillCandidates,
} from '../src/doctor';
import { PLUGIN_ID } from '../src/help';
import { userSettingsPath } from '../src/plugin-setup';
import { minimumNodeMajor, packageVersion } from '../src/package-info';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION, ledgerPath } from '../src/ledger/db';
import { homeDir } from '../src/registry';
import { isolateHomes } from './ledger/helpers';

const PLUGIN_ARGS = ['${CLAUDE_PLUGIN_ROOT}/dist/cli-main.js', 'serve'];
/** The oldest Node.js engines allows: these tests run on whatever Node runs jest, which may be older. */
const SUPPORTED_NODE = `${minimumNodeMajor()}.0.0`;

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
        nodeVersion: SUPPORTED_NODE,
        ...over,
    });

    /** machineProbe reads the Node running jest; the findings under test are the other ones. */
    const onSupportedNode = (found: DiagnosisProbe): DiagnosisProbe => ({ ...found, nodeVersion: SUPPORTED_NODE });

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
                `Set-Location -LiteralPath 'C:/work/app'; claude mcp remove ${MCP_SERVER_KEY} -s local`,
                `Set-Location -LiteralPath 'C:/work/site'; claude mcp remove ${MCP_SERVER_KEY} -s local`,
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
                expect(found.nodeVersion).toBe(process.versions.node);
                expect(found.skills.map(skill => skill.skillMd)).toEqual([path.join(dir, 'SKILL.md')]);
                expect(diagnose(onSupportedNode(found)).map(finding => finding.code)).toEqual([FINDING_CLAUDE_JSON_REGISTRATION, FINDING_STALE_SKILL]);
                expect(fs.existsSync(ghostpmHome)).toBe(false);
            } finally {
                if (previous === undefined) delete process.env.GHOSTPM_HOME; else process.env.GHOSTPM_HOME = previous;
                restore();
            }
        });
    });

    // Forward guards: no check reads a plugin cache, enabledPlugins or a project's own .claude-plugin today, so these pass
    // on the code as it is. They fail as soon as a new check flags GhostPM's own plugin from either marketplace (ruling).
    describe("GhostPM's own plugin, installed from either marketplace", () => {
        const REPO = path.join(__dirname, '..');
        const [PLUGIN_NAME, RELEASE_MARKETPLACE] = PLUGIN_ID.split('@');
        /** The repository checkout's marketplace while developing (.claude-plugin/marketplace.json). */
        const DEV_MARKETPLACE = 'ghostpm-local';
        const PLUGIN_FILES = ['.claude-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', 'skills/ghostpm/SKILL.md'];

        /**
         * Claude Code copies a marketplace plugin to ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/, but a
         * plugin from a marketplace added by local path loads in place: the checkout, which is a project as well.
         */
        const pluginRoot = (marketplace: string): string => (marketplace === DEV_MARKETPLACE
            ? path.join(home, 'checkout')
            : path.join(home, '.claude', 'plugins', 'cache', marketplace, PLUGIN_NAME, packageVersion()));

        it.each([RELEASE_MARKETPLACE, DEV_MARKETPLACE])('reports nothing for the plugin from %s', marketplace => {
            const restore = isolateHomes(home);
            const previous = process.env.GHOSTPM_HOME;
            process.env.GHOSTPM_HOME = path.join(home, '.ghostpm');
            try {
                const root = pluginRoot(marketplace);
                PLUGIN_FILES.forEach(file => {
                    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
                    fs.copyFileSync(path.join(REPO, file), path.join(root, file));
                });
                fs.mkdirSync(path.dirname(userSettingsPath()), { recursive: true });
                fs.writeFileSync(userSettingsPath(), JSON.stringify({ enabledPlugins: { [`${PLUGIN_NAME}@${marketplace}`]: true } }));
                fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [root]: {} } }));
                expect(diagnose(onSupportedNode(machineProbe()))).toEqual([]);
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
                expect(fix.startsWith(`${changeDirCommand(NASTY, platform)}${platform === 'win32' ? ';' : ' &&'} claude`)).toBe(true);
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
            expect(diagnose(onSupportedNode(found)).map(finding => finding.code)).toEqual([FINDING_NEWER_LEDGER]);
        });
    });

    describe('a Node.js older than package.json engines allows', () => {
        const minimum = minimumNodeMajor();

        it('names the running version and says to install the oldest supported one or newer', () => {
            const found = diagnose(probe({ nodeVersion: `${minimum - 2}.20.2` })).filter(finding => finding.code === FINDING_NODE_TOO_OLD);
            expect(found).toHaveLength(1);
            expect(found[0].message).toContain(`${minimum - 2}.20.2`);
            expect(found[0].message).toMatch(/Python/);
            expect(found[0].fix).toContain(`Install Node.js ${minimum} or newer`);
        });

        it('flags the major just below, and stays quiet from the minimum up', () => {
            expect(codesFrom(probe({ nodeVersion: `${minimum - 1}.99.0` }))).toEqual([FINDING_NODE_TOO_OLD]);
            expect(diagnose(probe({ nodeVersion: `${minimum}.0.0` }))).toEqual([]);
            expect(diagnose(probe({ nodeVersion: `${minimum + 4}.1.0` }))).toEqual([]);
        });
    });

    describe('PowerShell reads more than the ASCII quote', () => {
        const CURLY = ['\u2018', '\u2019', '\u201A', '\u201B'];

        it('doubles each curly single quote, as well as the plain one', () => {
            CURLY.forEach(quote => {
                expect(quoteForShell(`a${quote}b`, 'win32')).toBe(`'a${quote}${quote}b'`);
            });
            expect(quoteForShell("a'b", 'win32')).toBe("'a''b'");
        });

        it('leaves curly quotes alone for POSIX shells, which do not read them as quotes', () => {
            expect(quoteForShell('a\u2019b', 'linux')).toBe("'a\u2019b'");
        });

        it('changes folder literally: Set-Location -LiteralPath on Windows, cd && on POSIX', () => {
            expect(changeDirCommand('C:/a[a]', 'win32')).toBe("Set-Location -LiteralPath 'C:/a[a]'");
            expect(changeDirCommand('/a[a]', 'linux')).toBe("cd '/a[a]'");
        });
    });

    describe('the Windows hints run in a real PowerShell', () => {
        const shell = ['pwsh', 'powershell'].find(name => spawnSync(name, ['-NoProfile', '-Command', '1']).status === 0);
        const PROGRESS_OFF = "$ProgressPreference = 'SilentlyContinue'; ";
        const run = (script: string): void => {
            const encoded = Buffer.from(PROGRESS_OFF + script,'utf16le').toString('base64');
            const result = spawnSync(shell as string, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8' });
            expect(result.stderr).toBe('');
            expect(result.status).toBe(0);
        };

        (shell === undefined ? it.skip : it)('removes and enters exactly the named folder, never a wildcard sibling', () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-doctor-ps-'));
            try {
                const names = ['a[a]', 'a\u2019b', 'aa', "it's"];
                names.forEach(name => fs.mkdirSync(path.join(root, name, '.claude', 'skills', 'ghostpm'), { recursive: true }));
                const out = path.join(root, 'landed.txt');
                const hintFor = (name: string): string => diagnose(probe({
                    claudeJson: JSON.stringify({ projects: { [path.join(root, name)]: { mcpServers: { [MCP_SERVER_KEY]: {} } } } }),
                }))[0].fix.split('; claude')[0];
                const q = (value: string): string => quoteForShell(value, 'win32');
                const record = `[IO.File]::WriteAllText(${q(out)}, (Get-Location).Path, (New-Object Text.UTF8Encoding $false))`;
                run(`${hintFor('a[a]')}; ${record}`);
                expect(fs.readFileSync(out, 'utf8')).toBe(path.join(root, 'a[a]'));
                run(`${hintFor('a\u2019b')}; ${record}`);
                expect(fs.readFileSync(out, 'utf8')).toBe(path.join(root, 'a\u2019b'));
                names.slice(0, 2).concat("it's").forEach(name => run(removeDirCommand(path.join(root, name, '.claude', 'skills', 'ghostpm'), 'win32')));
                expect(fs.readdirSync(root).sort()).toEqual(['a[a]', 'a\u2019b', 'aa', "it's", 'landed.txt'].sort());
                expect(fs.existsSync(path.join(root, 'aa', '.claude', 'skills', 'ghostpm'))).toBe(true);
                ['a[a]', 'a\u2019b', "it's"].forEach(name => expect(fs.existsSync(path.join(root, name, '.claude', 'skills', 'ghostpm'))).toBe(false));
            } finally {
                removeTempDir(root);
            }
        });
    });
});
