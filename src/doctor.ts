// src/doctor.ts
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Ledger, SCHEMA_VERSION, openLedgerReadOnly, schemaVersion } from './ledger/db';
import { claudeConfigPath } from './ledger/legacy-import';
import { normalizePath } from './ledger/workspaces';
import { PLUGIN_ID } from './help';
import { SERVER_NAME, packageVersion } from './package-info';
import { userSettingsPath } from './plugin-setup';

export const FINDING_STALE_REGISTRATION = 'stale_registration';
export const FINDING_CLAUDE_JSON_REGISTRATION = 'claude_json_registration';
export const FINDING_STALE_SKILL = 'stale_skill';
export const FINDING_NEWER_LEDGER = 'ledger_newer_than_build';

/** Tools GhostPM 1.4.0 exposed that 2.0 removed (spec D10). A skill naming them predates the ledger. */
export const REMOVED_TOOLS = ['start_task', 'resolve_conflict'];
/** The server name 1.4.0's `claude mcp add` registered, and the name the plugin's own server uses. */
export const MCP_SERVER_KEY = SERVER_NAME;
/** The bare binary name a registration uses when it launches the global install. */
const GLOBAL_BINARY = 'ghostpm';
const CLAUDE_DIR = '.claude';
const SKILL_DIR = path.join(CLAUDE_DIR, 'skills', 'ghostpm');
const SKILL_FILE = 'SKILL.md';
/** Phase 2 `setup` also wrote this beside the skill, which makes the folder load as a skills-dir plugin. */
const SKILL_PLUGIN_JSON = path.join('.claude-plugin', 'plugin.json');
const SKILL_PLUGIN_NAME = 'ghostpm';
const WINDOWS = 'win32';

export interface Finding {
    code: string;
    message: string;
    /** What the user would run. doctor never does it for them. */
    fix: string;
}

export interface SkillFile {
    skillMd: string;
    content: string;
    /** Text of `.claude-plugin/plugin.json` beside the skill, when there is one. */
    pluginJson?: string | null;
}

export interface DiagnosisProbe {
    /** Settings file to inspect. Injected so tests never read the real one. */
    settingsPath: string;
    /** Where the `ghostpm` binary resolves, or null when it is not on PATH. */
    resolveGlobal: () => string | null;
    /** Whether an install directory contains the ledger, i.e. Phase 1 or later. */
    hasLedgerCode: (installDir: string) => boolean;
    /** ~/.claude.json text, or null when it is absent. Injected so tests never read the real file. */
    claudeJson: string | null;
    /** SKILL.md files that exist in folders a 1.4.0 `setup` could have written. */
    skills: SkillFile[];
    /** user_version of the ledger, or null when there is none. */
    ledgerSchema: number | null;
    /** This copy's version, named in messages. */
    version: string;
    /** Chooses the shell syntax of printed commands. */
    platform: string;
}

interface Settings {
    mcpServers?: { [name: string]: { command?: unknown } };
}

interface McpServers {
    [name: string]: unknown;
}

export interface ClaudeJson {
    mcpServers?: McpServers;
    projects?: { [projectPath: string]: { mcpServers?: McpServers } | null | undefined };
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
        fix: `Install the plugin (claude plugin install ${PLUGIN_ID}) so the server starts from the plugin root instead.`,
    };
}

export function parseClaudeJson(text: string | null): ClaudeJson {
    if (text === null) return {};
    try {
        const parsed = JSON.parse(text);
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ClaudeJson : {};
    } catch {
        return {};
    }
}

function registersGhostpm(servers: McpServers | null | undefined): boolean {
    return servers !== null && typeof servers === 'object' && Object.prototype.hasOwnProperty.call(servers, MCP_SERVER_KEY);
}

const DUPLICATE_SERVER = `The plugin already provides the ${MCP_SERVER_KEY} MCP server, so this registration starts a second copy of every GhostPM tool. `
    + `A 1.4.0 copy also offers ${REMOVED_TOOLS.join(' and ')} and writes to the per-repo database the agent no longer reads.`;

/** 1.4.0 ran `claude mcp add ghostpm -s user|local`: top-level mcpServers, or projects[path].mcpServers (Claude Code MCP docs). */
function claudeJsonRegistrations(claude: ClaudeJson): Finding[] {
    const findings: Finding[] = [];
    if (registersGhostpm(claude.mcpServers)) {
        findings.push({
            code: FINDING_CLAUDE_JSON_REGISTRATION,
            message: `~/.claude.json registers a user-scope "${MCP_SERVER_KEY}" MCP server. ${DUPLICATE_SERVER}`,
            fix: `claude mcp remove ${MCP_SERVER_KEY} -s user`,
        });
    }
    const projects = claude.projects ?? {};
    Object.keys(projects).sort().forEach(projectPath => {
        const project = projects[projectPath];
        if (project === null || typeof project !== 'object' || !registersGhostpm(project.mcpServers)) return;
        findings.push({
            code: FINDING_CLAUDE_JSON_REGISTRATION,
            message: `~/.claude.json registers a "${MCP_SERVER_KEY}" MCP server for ${projectPath}. ${DUPLICATE_SERVER}`,
            // Local scope is keyed by the project folder, so the removal runs from inside it.
            fix: `cd "${projectPath}"; claude mcp remove ${MCP_SERVER_KEY} -s local`,
        });
    });
    return findings;
}

export function removeDirCommand(dir: string, platform: string): string {
    return platform === WINDOWS ? `Remove-Item -Recurse -Force "${dir}"` : `rm -rf "${dir}"`;
}

/** SKILL.md paths a 1.4.0 `setup` could have written: the home, then every project Claude Code or GhostPM knows. */
export function skillCandidates(home: string, projectPaths: string[]): string[] {
    const seen = new Set<string>();
    const candidates: string[] = [];
    [home].concat(projectPaths).forEach(base => {
        const file = path.join(base, SKILL_DIR, SKILL_FILE);
        const key = normalizePath(file);
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push(file);
    });
    return candidates;
}

/** The skills-dir plugin name conflicts with the marketplace plugin (it is reported "Not loaded"), so a folder naming it is stale too. */
function namesGhostpmPlugin(pluginJson: string | null | undefined): boolean {
    if (pluginJson === null || pluginJson === undefined) return false;
    try {
        return (JSON.parse(pluginJson) as { name?: unknown } | null)?.name === SKILL_PLUGIN_NAME;
    } catch {
        return false;
    }
}

function staleSkills(skills: SkillFile[], platform: string): Finding[] {
    return skills
        .filter(skill => REMOVED_TOOLS.some(tool => skill.content.indexOf(tool) >= 0) || namesGhostpmPlugin(skill.pluginJson))
        .map(skill => ({
            code: FINDING_STALE_SKILL,
            message: `${skill.skillMd} is a GhostPM skill from before the plugin: it names ${REMOVED_TOOLS.join(' and ')} or loads as a second "${SKILL_PLUGIN_NAME}" plugin that conflicts with the marketplace one. The plugin ships the current skill.`,
            // The whole folder: setup also wrote a .claude-plugin/plugin.json beside it.
            fix: removeDirCommand(path.dirname(skill.skillMd), platform),
        }));
}

function newerLedger(probe: DiagnosisProbe): Finding | null {
    if (probe.ledgerSchema === null || probe.ledgerSchema <= SCHEMA_VERSION) return null;
    return {
        code: FINDING_NEWER_LEDGER,
        message: `The ledger is schema ${probe.ledgerSchema}, newer than this ghostpm ${probe.version} understands (schema ${SCHEMA_VERSION}). `
            + 'Hooks and servers from a copy this old stop recording and log why to hook.log.',
        fix: `npm install -g ghostpm@latest; claude plugin update ${PLUGIN_ID}`,
    };
}

/** Read-only by design: safe to run before deciding anything. */
export function diagnose(probe: DiagnosisProbe): Finding[] {
    const findings: Finding[] = [];
    const stale = staleRegistration(readSettings(probe.settingsPath), probe);
    if (stale !== null) findings.push(stale);
    findings.push(...claudeJsonRegistrations(parseClaudeJson(probe.claudeJson)));
    findings.push(...staleSkills(probe.skills, probe.platform));
    const newer = newerLedger(probe);
    if (newer !== null) findings.push(newer);
    return findings;
}

function readText(file: string): string | null {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

function openIfPresent(): Ledger | null {
    try {
        return openLedgerReadOnly();
    } catch {
        return null;
    }
}

/** Read-only on any schema: doctor must work on exactly the ledgers other commands refuse. */
function ledgerFacts(): { schema: number | null; workspacePaths: string[] } {
    const db = openIfPresent();
    if (db === null) return { schema: null, workspacePaths: [] };
    try {
        let workspacePaths: string[] = [];
        try {
            workspacePaths = (db.prepare('SELECT path FROM workspaces').all() as { path: string }[]).map(row => row.path);
        } catch { /* a schema this copy cannot read: skip the per-workspace skill check */ }
        return { schema: schemaVersion(db), workspacePaths };
    } catch {
        // Not a SQLite file: nothing to compare.
        return { schema: null, workspacePaths: [] };
    } finally {
        db.close();
    }
}

/** The binary on PATH is a shim; the package sits beside it in node_modules. */
function resolveGlobal(): string | null {
    try {
        const finder = process.platform === WINDOWS ? 'where.exe' : 'which';
        const shim = String(execFileSync(finder, [GLOBAL_BINARY])).split(/\r?\n/)[0].trim();
        if (shim.length === 0) return null;
        const installDir = path.join(path.dirname(shim), 'node_modules', GLOBAL_BINARY);
        return fs.existsSync(installDir) ? installDir : null;
    } catch {
        return null;
    }
}

/** The real machine, read once for `ghostpm doctor`. Tests build a DiagnosisProbe by hand instead. */
export function machineProbe(): DiagnosisProbe {
    const claudeJson = readText(claudeConfigPath());
    const ledger = ledgerFacts();
    const projects = Object.keys(parseClaudeJson(claudeJson).projects ?? {});
    const skills: SkillFile[] = [];
    skillCandidates(os.homedir(), projects.concat(ledger.workspacePaths)).forEach(skillMd => {
        const content = readText(skillMd);
        if (content !== null) skills.push({ skillMd, content, pluginJson: readText(path.join(path.dirname(skillMd), SKILL_PLUGIN_JSON)) });
    });
    return {
        settingsPath: userSettingsPath(),
        resolveGlobal,
        hasLedgerCode: installDir => fs.existsSync(path.join(installDir, 'dist', 'ledger', 'db.js')),
        claudeJson,
        skills,
        ledgerSchema: ledger.schema,
        version: packageVersion(),
        platform: process.platform,
    };
}
