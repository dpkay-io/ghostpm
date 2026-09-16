import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getWorkspaces } from '../registry';
import { loadConfig } from '../config';
import { Ledger, write, nowIso } from './db';
import { ensureWorkspace, normalizePath, setWorkspaceVendor } from './workspaces';
import { getSetting, setSetting, setWorkspaceSetting, SETTING_ACTIVE_SPRINT, SETTING_CURRENT_USER } from './settings';
import { insertTaskRow, insertVendorLink } from './tasks';
import { recordEvent } from './events';
import { Phase, Vendor } from './types';

export const LEGACY_DB_FILE = '.mcp-pm.db';
export const LEGACY_CONFIG_FILE = '.mcp-pm.yml';
export const LEGACY_IMPORT_SETTING = 'legacy_import_at';
export const LEGACY_SOURCE = 'vendor';
const LEGACY_COMMENT_SEPARATOR = '\n---\n';
const CLAUDE_CONFIG_FILE = '.claude.json';
const LEGACY_USER_KEY = 'current_user';
const LEGACY_SPRINT_KEY = 'active_sprint';

/** Spec §11. Anything unknown lands in the fallback phase. */
const STATE_PHASE: Record<string, Phase> = {
    new: 'planned', open: 'planned', 'to do': 'planned', proposed: 'planned', approved: 'planned',
    active: 'in_progress', in_progress: 'in_progress', committed: 'in_progress', doing: 'in_progress',
    in_review: 'in_review', resolved: 'in_review', testing: 'in_review',
    closed: 'done', done: 'done',
    removed: 'dropped',
};
const FALLBACK_PHASE: Phase = 'planned';

export function vendorStateToPhase(state: string): Phase {
    return STATE_PHASE[state.trim().toLowerCase()] ?? FALLBACK_PHASE;
}

export function claudeConfigPath(): string {
    return path.join(os.homedir(), CLAUDE_CONFIG_FILE);
}

/** Registry entries plus ~/.claude.json project folders, keeping the ones that still have a legacy config. */
export function discoverLegacyRoots(claudeJsonPath: string = claudeConfigPath()): string[] {
    const candidates = getWorkspaces().map(w => w.path);
    try {
        const parsed = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')) as { projects?: Record<string, unknown> };
        candidates.push(...Object.keys(parsed.projects ?? {}));
    } catch { /* missing or unreadable ~/.claude.json: registry only */ }

    const byPath = new Map<string, string>();
    for (const candidate of candidates) {
        const key = normalizePath(candidate);
        if (!byPath.has(key) && fs.existsSync(path.join(candidate, LEGACY_CONFIG_FILE))) byPath.set(key, candidate);
    }
    return Array.from(byPath.values());
}

interface LegacyTaskRow {
    id: string;
    title: string;
    state: string;
    assignee?: string | null;
    body?: string | null;
    comments?: string | null;
    updatedAt?: string | null;
    labels?: string | null;
    milestone?: string | null;
    url?: string | null;
}

export interface LegacyImportResult {
    root: string;
    workspaceId: number;
    imported: number;
    skipped: number;
}

function splitLegacyComments(comments: string | null | undefined): string[] {
    if (!comments) return [];
    return comments.split(LEGACY_COMMENT_SEPARATOR).map(c => c.trim()).filter(c => c.length > 0);
}

function readLegacyMetadata(legacy: Database.Database): Map<string, string> {
    const rows = legacy.prepare('SELECT key, value FROM metadata').all() as { key: string; value: string }[];
    return new Map(rows.map(r => [r.key, r.value] as [string, string]));
}

function applyLegacyMetadata(db: Ledger, workspaceId: number, metadata: Map<string, string>): void {
    const user = metadata.get(LEGACY_USER_KEY);
    if (user) setWorkspaceSetting(db, workspaceId, SETTING_CURRENT_USER, user);

    const sprint = metadata.get(LEGACY_SPRINT_KEY);
    if (!sprint) return;
    try {
        const parsed = JSON.parse(sprint) as { name?: string };
        if (parsed.name) setWorkspaceSetting(db, workspaceId, SETTING_ACTIVE_SPRINT, parsed.name);
    } catch { /* unreadable legacy sprint value */ }
}

/** Imports one legacy repo. Safe to run twice: tasks already linked to a remote id are skipped. */
export function importLegacyWorkspace(db: Ledger, root: string): LegacyImportResult {
    const vendor: Vendor = loadConfig(root).vendor;
    const workspace = ensureWorkspace(db, root);
    setWorkspaceVendor(db, workspace.id, vendor);

    const legacyPath = path.join(root, LEGACY_DB_FILE);
    if (!fs.existsSync(legacyPath)) return { root, workspaceId: workspace.id, imported: 0, skipped: 0 };

    const legacy = new Database(legacyPath, { readonly: true, fileMustExist: true });
    let rows: LegacyTaskRow[];
    let metadata: Map<string, string>;
    try {
        rows = legacy.prepare('SELECT * FROM tasks').all() as LegacyTaskRow[];
        metadata = readLegacyMetadata(legacy);
    } finally {
        legacy.close();
    }

    return write(db, () => {
        applyLegacyMetadata(db, workspace.id, metadata);
        const alreadyLinked = new Set((db.prepare(`
            SELECT l.remote_id FROM vendor_links l JOIN tasks t ON t.id = l.task_id
            WHERE t.workspace_id = ? AND l.vendor = ?`).all(workspace.id, vendor) as { remote_id: string }[])
            .map(r => r.remote_id));

        let imported = 0;
        let skipped = 0;
        for (const row of rows) {
            if (alreadyLinked.has(row.id)) {
                skipped++;
                continue;
            }
            const at = nowIso();
            const task = insertTaskRow(db, {
                title: row.title,
                phase: vendorStateToPhase(row.state),
                workspaceId: workspace.id,
                origin: 'vendor',
                source: LEGACY_SOURCE,
                body: row.body ?? null,
                assignee: row.assignee ?? null,
                milestone: row.milestone ?? null,
            }, at);
            insertVendorLink(db, {
                taskId: task.id,
                vendor,
                remoteId: row.id,
                remoteUrl: row.url ?? null,
                remoteState: row.state,
                labels: row.labels ?? null,
                remoteUpdatedAt: row.updatedAt ?? null,
            });
            for (const text of splitLegacyComments(row.comments)) {
                recordEvent(db, { taskId: task.id, kind: 'comment', source: LEGACY_SOURCE, payload: { text } }, at);
            }
            imported++;
        }
        return { root, workspaceId: workspace.id, imported, skipped };
    });
}

/**
 * Runs once per ledger. A repo that fails is logged and skipped; the others still import.
 * The guard is checked before discovery: discovery stats every project path in ~/.claude.json,
 * and this runs on every server start, so once the import is done that work must not happen at all.
 */
export function runLegacyImportOnce(db: Ledger, roots?: string[]): LegacyImportResult[] {
    if (getSetting<string>(db, LEGACY_IMPORT_SETTING)) return [];
    const results: LegacyImportResult[] = [];
    for (const root of roots ?? discoverLegacyRoots()) {
        try {
            results.push(importLegacyWorkspace(db, root));
        } catch (error) {
            console.error(`GhostPM: legacy import skipped for ${root}: ${(error as Error).message}`);
        }
    }
    setSetting(db, LEGACY_IMPORT_SETTING, nowIso());
    return results;
}
