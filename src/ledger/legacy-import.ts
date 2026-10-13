import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getWorkspaces } from '../registry';
import { loadConfig, McpPmConfig } from '../config';
import { Ledger, write, nowIso } from './db';
import { ensureWorkspace, findWorkspace, normalizePath, setWorkspaceVendor } from './workspaces';
import {
    getWorkspaceSetting, setWorkspaceSetting, PhaseStateMap,
    SETTING_ACTIVE_SPRINT, SETTING_CURRENT_USER, SETTING_PHASE_STATE_MAP, SETTING_SYNC_POLICY, SYNC_POLICY_LINKED_ONLY,
} from './settings';
import { getTask, insertTaskRow, insertVendorLink } from './tasks';
import { recordEvent } from './events';
import { enqueueComment, projectTask } from './projection';
import { Phase, VENDOR_SOURCE, Vendor } from './types';

export const LEGACY_DB_FILE = '.mcp-pm.db';
export const LEGACY_CONFIG_FILE = '.mcp-pm.yml';
/** Workspace setting: when this repo's legacy data was imported. Set once per repo. */
export const LEGACY_IMPORT_SETTING = 'legacy_import_at';
export const LEGACY_SOURCE = VENDOR_SOURCE;
const LEGACY_COMMENT_SEPARATOR = '\n---\n';
const CLAUDE_CONFIG_FILE = '.claude.json';
const LEGACY_USER_KEY = 'current_user';
const LEGACY_SPRINT_KEY = 'active_sprint';
const LEGACY_OUTBOX_TABLE = 'outbox';
const LEGACY_PENDING = 'pending';
const START_TRANSITION = 'start_task';
const PUSH_TRANSITION = 'code_push';
const WORD_START = /\b[a-z]/g;
const AZURE_DEVOPS: Vendor = 'azure_devops';

/** Spec §11. Anything unknown lands in the fallback phase. */
const STATE_PHASE: Record<string, Phase> = {
    new: 'planned', open: 'planned', 'to do': 'planned', proposed: 'planned', approved: 'planned',
    active: 'in_progress', in_progress: 'in_progress', committed: 'in_progress', doing: 'in_progress',
    in_review: 'in_review', resolved: 'in_review', testing: 'in_review',
    closed: 'done', done: 'done',
    removed: 'dropped',
};
const FALLBACK_PHASE: Phase = 'planned';

/** The spec §11 state table without its fallback: undefined for a state it does not know. */
export function knownStatePhase(state: string): Phase | undefined {
    const key = state.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(STATE_PHASE, key) ? STATE_PHASE[key] : undefined;
}

export function vendorStateToPhase(state: string): Phase {
    return knownStatePhase(state) ?? FALLBACK_PHASE;
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
    /** Rows 1.4.0 queued but never pushed, now in the ledger's outbox. */
    queued: number;
}

function splitLegacyComments(comments: string | null | undefined): string[] {
    if (!comments) return [];
    return comments.split(LEGACY_COMMENT_SEPARATOR).map(c => c.trim()).filter(c => c.length > 0);
}

function readLegacyMetadata(legacy: Database.Database): Map<string, string> {
    const rows = legacy.prepare('SELECT key, value FROM metadata').all() as { key: string; value: string }[];
    return new Map(rows.map(r => [r.key, r.value] as [string, string]));
}

/** Only fills gaps: a sprint or user someone set since the first import stays. */
function applyLegacyMetadata(db: Ledger, workspaceId: number, metadata: Map<string, string>): void {
    const user = metadata.get(LEGACY_USER_KEY);
    if (user && getWorkspaceSetting(db, workspaceId, SETTING_CURRENT_USER) === undefined) {
        setWorkspaceSetting(db, workspaceId, SETTING_CURRENT_USER, user);
    }

    const sprint = metadata.get(LEGACY_SPRINT_KEY);
    if (!sprint || getWorkspaceSetting(db, workspaceId, SETTING_ACTIVE_SPRINT) !== undefined) return;
    try {
        const parsed = JSON.parse(sprint) as { name?: string };
        if (parsed.name) setWorkspaceSetting(db, workspaceId, SETTING_ACTIVE_SPRINT, parsed.name);
    } catch { /* unreadable legacy sprint value */ }
}

/**
 * 1.4.0 synced existing items both ways but never created one: a legacy repo keeps that as
 * `linked-only` under the `off` default. Only fills a gap: a policy a person set is never overwritten.
 */
function keepLegacyPolicy(db: Ledger, workspaceId: number): void {
    if (getWorkspaceSetting(db, workspaceId, SETTING_SYNC_POLICY) === undefined) {
        setWorkspaceSetting(db, workspaceId, SETTING_SYNC_POLICY, SYNC_POLICY_LINKED_ONLY);
    }
}

/** 1.4.0's sniffer lower-cased the state names; Azure Boards' stock names are title case ("To Do"). */
const titleCase = (state: string): string => state.replace(WORD_START, letter => letter.toUpperCase());

/** Spec §11.1: the Azure DevOps state for each phase, from the states and transitions 1.4.0 sniffed. */
export function legacyPhaseStateMap(config: McpPmConfig): PhaseStateMap {
    const map: PhaseStateMap = {};
    for (const state of config.workflow.states) {
        const phase = knownStatePhase(state);
        if (phase !== undefined && map[phase] === undefined) map[phase] = titleCase(state);
    }
    const start = config.workflow.transitions[START_TRANSITION];
    if (start) map.in_progress = titleCase(start);
    const push = config.workflow.transitions[PUSH_TRANSITION];
    if (push) map.in_review = titleCase(push);
    if (map.brainstorming === undefined && map.planned !== undefined) map.brainstorming = map.planned;
    return map;
}

interface LegacyOutboxRow {
    taskId: string;
    payload: string;
}

function readPendingOutbox(legacy: Database.Database): LegacyOutboxRow[] {
    const exists = legacy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(LEGACY_OUTBOX_TABLE);
    if (exists === undefined) return [];
    return legacy.prepare('SELECT taskId, payload FROM outbox WHERE status = ? ORDER BY id').all(LEGACY_PENDING) as LegacyOutboxRow[];
}

/**
 * 1.4.0 queued `{ state?, comment? }` per issue and applied the state to its cached task
 * at once, so the imported phase already is the desired state. Call inside write().
 */
function queueLegacyOutbox(db: Ledger, workspaceId: number, vendor: Vendor, rows: LegacyOutboxRow[]): number {
    let queued = 0;
    for (const row of rows) {
        const link = db.prepare(`
            SELECT l.task_id FROM vendor_links l JOIN tasks t ON t.id = l.task_id
            WHERE t.workspace_id = ? AND l.vendor = ? AND l.remote_id = ?`)
            .get(workspaceId, vendor, row.taskId) as { task_id: number } | undefined;
        if (link === undefined) continue;
        let payload: { state?: unknown; comment?: unknown };
        try {
            payload = JSON.parse(row.payload) as { state?: unknown; comment?: unknown };
        } catch {
            continue;
        }
        const task = getTask(db, link.task_id)!;
        const at = nowIso();
        if (typeof payload.state === 'string' && projectTask(db, task, 'change', at) === 'sync_queued') queued++;
        if (typeof payload.comment === 'string' && payload.comment.length > 0 && enqueueComment(db, task, payload.comment, at)) queued++;
    }
    return queued;
}

/** Imports one legacy repo. Safe to run twice: linked tasks are skipped and the outbox is queued once. */
export function importLegacyWorkspace(db: Ledger, root: string): LegacyImportResult {
    const config = loadConfig(root);
    const vendor: Vendor = config.vendor;
    const workspace = ensureWorkspace(db, root);
    setWorkspaceVendor(db, workspace.id, vendor);
    // Before the early return and before the outbox is queued: under `off` the queue would project nothing.
    keepLegacyPolicy(db, workspace.id);
    const firstImport = getWorkspaceSetting<string>(db, workspace.id, LEGACY_IMPORT_SETTING) === undefined;
    if (vendor === AZURE_DEVOPS && getWorkspaceSetting(db, workspace.id, SETTING_PHASE_STATE_MAP) === undefined) {
        setWorkspaceSetting(db, workspace.id, SETTING_PHASE_STATE_MAP, legacyPhaseStateMap(config));
    }

    const legacyPath = path.join(root, LEGACY_DB_FILE);
    if (!fs.existsSync(legacyPath)) {
        setWorkspaceSetting(db, workspace.id, LEGACY_IMPORT_SETTING, nowIso());
        return { root, workspaceId: workspace.id, imported: 0, skipped: 0, queued: 0 };
    }

    const legacy = new Database(legacyPath, { readonly: true, fileMustExist: true });
    let rows: LegacyTaskRow[];
    let metadata: Map<string, string>;
    let pending: LegacyOutboxRow[];
    try {
        rows = legacy.prepare('SELECT * FROM tasks').all() as LegacyTaskRow[];
        metadata = readLegacyMetadata(legacy);
        pending = readPendingOutbox(legacy);
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
                remoteTitle: row.title,
            });
            for (const text of splitLegacyComments(row.comments)) {
                recordEvent(db, { taskId: task.id, kind: 'comment', source: LEGACY_SOURCE, payload: { text } }, at);
            }
            imported++;
        }
        // Once per repo: a second import must not post the same comments again.
        const queued = firstImport ? queueLegacyOutbox(db, workspace.id, vendor, pending) : 0;
        setWorkspaceSetting(db, workspace.id, LEGACY_IMPORT_SETTING, nowIso());
        return { root, workspaceId: workspace.id, imported, skipped, queued };
    });
}

/**
 * Every server start: discover legacy repos and import each one not imported yet, so a repo
 * set up after the first start still arrives (spec §11.1). A repo that fails is logged and
 * skipped. Discovery stats every project folder in ~/.claude.json: 8-9 ms warm, 384 ms on a
 * cold cache (spec §15) — the price of not missing a repo.
 */
export function runLegacyImport(db: Ledger, roots?: string[]): LegacyImportResult[] {
    const results: LegacyImportResult[] = [];
    for (const root of roots ?? discoverLegacyRoots()) {
        try {
            const known = findWorkspace(db, root);
            if (known !== undefined && getWorkspaceSetting(db, known.id, LEGACY_IMPORT_SETTING) !== undefined) {
                keepLegacyPolicy(db, known.id);
                continue;
            }
            results.push(importLegacyWorkspace(db, root));
        } catch (error) {
            console.error(`GhostPM: legacy import skipped for ${root}: ${(error as Error).message}`);
        }
    }
    return results;
}
