import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getWorkspaces } from '../registry';
import { loadConfig, McpPmConfig } from '../config';
import { Ledger, write, nowIso } from './db';
import { ensureWorkspace, findWorkspace, normalizePath, setWorkspaceVendor } from './workspaces';
import {
    getSetting, getWorkspaceSetting, setWorkspaceSetting, PhaseStateMap, PROGRESS_COMMENTS_NONE,
    SETTING_ACTIVE_SPRINT, SETTING_CURRENT_USER, SETTING_PHASE_STATE_MAP, SETTING_PROGRESS_COMMENTS, SETTING_SYNC_POLICY,
    SYNC_POLICY_LINKED_ONLY,
} from './settings';
import { getTask, insertTaskRow, insertVendorLink } from './tasks';
import { recordEvent } from './events';
import { enqueueComment, projectTask } from './projection';
import { Phase, VENDOR_SOURCE, Vendor, WorkspaceRow } from './types';
import { appendLog, SYNC_LOG_FILE } from '../hook/log';

export const LEGACY_DB_FILE = '.mcp-pm.db';
export const LEGACY_CONFIG_FILE = '.mcp-pm.yml';
/**
 * Workspace setting: when each legacy root was imported, by normalized root. Several roots can share
 * one workspace (a linked worktree), and each is imported once. Builds before roots were tracked
 * stored one time here; it covers the workspace's own root.
 */
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
 * What 1.4.0 did, as settings: it synced existing items both ways but never created one (`linked-only`, under the
 * `off` default), and it never posted phase comments nor moved labels on evidence (`progress_comments` none, ruling F8).
 */
const LEGACY_SETTINGS: readonly [string, unknown][] = [
    [SETTING_SYNC_POLICY, SYNC_POLICY_LINKED_ONLY],
    [SETTING_PROGRESS_COMMENTS, PROGRESS_COMMENTS_NONE],
];

/** A legacy repo keeps 1.4.0's behaviour. Only fills a gap: a value a person set, for this workspace or globally, stays. */
function keepLegacyPolicy(db: Ledger, workspaceId: number): void {
    for (const [key, value] of LEGACY_SETTINGS) {
        if (getWorkspaceSetting(db, workspaceId, key) === undefined && getSetting(db, key) === undefined) {
            setWorkspaceSetting(db, workspaceId, key, value);
        }
    }
}

type ImportedRoots = Record<string, string>;

function importedRoots(db: Ledger, workspace: WorkspaceRow): ImportedRoots {
    const stored = getWorkspaceSetting<string | ImportedRoots>(db, workspace.id, LEGACY_IMPORT_SETTING);
    return typeof stored === 'string' ? { [workspace.path]: stored } : stored ?? {};
}

const wasImported = (db: Ledger, workspace: WorkspaceRow, root: string): boolean =>
    importedRoots(db, workspace)[normalizePath(root)] !== undefined;

function markImported(db: Ledger, workspace: WorkspaceRow, root: string): void {
    write(db, () => setWorkspaceSetting(db, workspace.id, LEGACY_IMPORT_SETTING,
        { ...importedRoots(db, workspace), [normalizePath(root)]: nowIso() }));
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
    return legacy.prepare(`SELECT taskId, payload FROM ${LEGACY_OUTBOX_TABLE} WHERE status = ? ORDER BY id`)
        .all(LEGACY_PENDING) as LegacyOutboxRow[];
}

/**
 * 1.4.0 queued `{ state?, comment? }` per issue and applied the state to its cached task
 * at once, so the imported phase already is the desired state. `linked` maps the workspace's
 * remote ids to task ids. Returns the rows inserted; what it could not queue goes to `notes`,
 * to be logged once the write has committed (ruling F16). Call inside write().
 */
function queueLegacyOutbox(db: Ledger, workspace: WorkspaceRow, linked: Map<string, number>, rows: LegacyOutboxRow[], notes: string[]): number {
    // One pending sync_state per task absorbs a second state change, so count what was inserted:
    // inside write() nobody else inserts, and every new row gets an id above the current highest.
    const highestBefore = (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM outbox').get() as { id: number }).id;
    for (const row of rows) {
        const taskId = linked.get(row.taskId);
        if (taskId === undefined) {
            notes.push(`legacy import ${workspace.path}: #${row.taskId} is not in 1.4.0's cache, so its queued change was not imported`);
            continue;
        }
        let payload: { state?: unknown; comment?: unknown };
        try {
            payload = JSON.parse(row.payload) as { state?: unknown; comment?: unknown };
        } catch {
            continue;
        }
        const task = getTask(db, taskId)!;
        const at = nowIso();
        if (typeof payload.state === 'string') projectTask(db, task, 'change', at);
        if (typeof payload.comment === 'string' && payload.comment.length > 0) enqueueComment(db, task, payload.comment, at);
    }
    return (db.prepare('SELECT COUNT(*) AS count FROM outbox WHERE id > ?').get(highestBefore) as { count: number }).count;
}

/** Imports one legacy repo. Safe to run twice: linked tasks are skipped and the outbox is queued once. */
export function importLegacyWorkspace(db: Ledger, root: string): LegacyImportResult {
    const config = loadConfig(root);
    const vendor: Vendor = config.vendor;
    const workspace = ensureWorkspace(db, root);
    setWorkspaceVendor(db, workspace.id, vendor);
    // Before the early return and before the outbox is queued: under `off` the queue would project nothing.
    keepLegacyPolicy(db, workspace.id);
    if (vendor === AZURE_DEVOPS && getWorkspaceSetting(db, workspace.id, SETTING_PHASE_STATE_MAP) === undefined) {
        setWorkspaceSetting(db, workspace.id, SETTING_PHASE_STATE_MAP, legacyPhaseStateMap(config));
    }

    const legacyPath = path.join(root, LEGACY_DB_FILE);
    if (!fs.existsSync(legacyPath)) {
        markImported(db, workspace, root);
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

    // No file I/O under the write lock: what to log is logged after the write commits.
    const notes: string[] = [];
    const result = write(db, () => {
        // Read under the write lock: two servers starting at once must not both queue this root's rows.
        const firstImport = !wasImported(db, workspace, root);
        applyLegacyMetadata(db, workspace.id, metadata);
        const linked = new Map((db.prepare(`
            SELECT l.remote_id, l.task_id FROM vendor_links l JOIN tasks t ON t.id = l.task_id
            WHERE t.workspace_id = ? AND l.vendor = ?`).all(workspace.id, vendor) as { remote_id: string; task_id: number }[])
            .map(r => [r.remote_id, r.task_id] as [string, number]));

        let imported = 0;
        let skipped = 0;
        for (const row of rows) {
            if (linked.has(row.id)) {
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
            linked.set(row.id, task.id);
            imported++;
        }
        // Once per root: a second import must not post the same comments again.
        const queued = firstImport ? queueLegacyOutbox(db, workspace, linked, pending, notes) : 0;
        markImported(db, workspace, root);
        return { root, workspaceId: workspace.id, imported, skipped, queued };
    });
    notes.forEach(note => appendLog(SYNC_LOG_FILE, note));
    return result;
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
            if (known !== undefined && wasImported(db, known, root)) {
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
