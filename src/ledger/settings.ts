import { Ledger, write } from './db';
import { DEFAULT_STALE_SESSION_MINUTES } from './sessions';
import { CLOSED_PHASES, PHASES, Phase, isPhase } from './types';

export const SETTING_CREATE_BRANCH = 'create_branch';
export const SETTING_STALE_SESSION_MINUTES = 'stale_session_minutes';
export const SETTING_CURRENT_USER = 'current_user';
export const SETTING_ACTIVE_SPRINT = 'active_sprint';
/** The statusline command configured before ghostpm chained itself in; restored on uninstall. */
export const SETTING_PREVIOUS_STATUSLINE = 'previous_statusline';
export const SETTING_SYNC_POLICY = 'sync_policy';
export const SETTING_PROGRESS_COMMENTS = 'progress_comments';
export const SETTING_PHASE_STATE_MAP = 'phase_state_map';
export const SETTING_ADO_WORK_ITEM_TYPE = 'ado_work_item_type';
export const SETTING_PLAN_GLOBS = 'plan_globs';
/** GitHub: what every phase label starts with (`ghostpm:in_progress`). May be empty (`in_progress`). */
export const SETTING_LABEL_PREFIX = 'label_prefix';
/** GitHub: a label of your own for a phase, in place of the prefixed one (`in_progress=In progress`). */
export const SETTING_PHASE_LABEL_MAP = 'phase_label_map';
/** How far Claude may move a task on its own once it has verified the work (`ask`, `review`). */
export const SETTING_COMPLETION = 'completion';
/**
 * Workspace, internal: phase labels an earlier label_prefix or phase_label_map gave, label to phase. They still read
 * as that phase, and the next push of the item replaces them with the current label.
 */
export const SETTING_RETIRED_PHASE_LABELS = 'retired_phase_labels';
export const SETTING_SYNC_PULL_MINUTES = 'sync_pull_minutes';
export const SETTING_MAX_PUSH_ATTEMPTS = 'max_push_attempts';
/** Workspace, internal: why sync is paused there (spec §8.8). Absent means not paused. */
export const SETTING_SYNC_PAUSED = 'sync_paused';
/**
 * Workspace, internal: when the last pull that read everything began, advanced only by such a pull (spec §8.5). The pull
 * schedule counts from it. A pull that read a full page leaves it, so the next pull is due at once.
 */
export const SETTING_LAST_SYNC = 'last_sync';
/** Workspace, internal: where the next pull reads from (its `since`), advanced only after a successful pull. */
export const SETTING_PULL_WATERMARK = 'pull_watermark';
/** Workspace, internal: task id the rotating linked-item check stopped at. */
export const SETTING_LINK_CHECK_CURSOR = 'link_check_cursor';
/** Workspace, internal: event seq (first record of a pull request) the rotating merged-PR check stopped at. */
export const SETTING_PR_CHECK_CURSOR = 'pr_check_cursor';

export const SYNC_POLICY_AUTO = 'auto';
export const SYNC_POLICY_PROMOTE = 'promote';
export const SYNC_POLICY_LINKED_ONLY = 'linked-only';
/** No push, no pull, nothing queued. The global default: a workspace opts in explicitly. */
export const SYNC_POLICY_OFF = 'off';
export const SYNC_POLICIES = [SYNC_POLICY_AUTO, SYNC_POLICY_PROMOTE, SYNC_POLICY_LINKED_ONLY, SYNC_POLICY_OFF] as const;
export type SyncPolicy = typeof SYNC_POLICIES[number];
export const PROGRESS_COMMENTS_PHASE = 'phase';
/** No progress comments (and no evidence-driven phase comments) on the vendor. */
export const PROGRESS_COMMENTS_NONE = 'none';
/** `session` and `turn` (spec §8.2) are not built yet. */
export const PROGRESS_COMMENT_MODES = [PROGRESS_COMMENTS_PHASE, PROGRESS_COMMENTS_NONE] as const;
export type PhaseStateMap = Partial<Record<Phase, string>>;
export type PhaseLabelMap = Partial<Record<Phase, string>>;
/** Claude changes a phase only when the user asks (the default, and how 2.0 behaves). */
export const COMPLETION_ASK = 'ask';
/**
 * Claude may move the task its session works on to in_review once it has verified the work and committed it, saying
 * what it verified. Done still comes from a merged PR, the vendor (a close, or a closing keyword such as `Fixes #42`
 * landing on the default branch) or the user.
 */
export const COMPLETION_REVIEW = 'review';
export const COMPLETION_MODES = [COMPLETION_ASK, COMPLETION_REVIEW] as const;
export type CompletionMode = typeof COMPLETION_MODES[number];
/** The phases a GitHub label can show: a closed issue shows its phase by its close reason and carries no phase label. */
export const LABELLED_PHASES: readonly Phase[] = PHASES.filter(phase => !CLOSED_PHASES.has(phase));
export const DEFAULT_LABEL_PREFIX = 'ghostpm:';
/** GitHub's limit on a label name. */
export const LABEL_NAME_LIMIT = 50;
/** `gh issue create --label` and `gh issue edit --add-label` split their value on commas. */
const LABEL_LIST_SEPARATOR = ',';
const LONGEST_PHASE = Math.max(...LABELLED_PHASES.map(phase => phase.length));
export const LABEL_PREFIX_LIMIT = LABEL_NAME_LIMIT - LONGEST_PHASE;
/** C0 and C1 controls: never part of a label name. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export const DEFAULT_PLAN_GLOBS: readonly string[] = ['docs/**/{specs,plans}/**/*.md'];
export const DEFAULT_SYNC_PULL_MINUTES = 5;
export const DEFAULT_MAX_PUSH_ATTEMPTS = 8;
/** Present in all four stock Azure Boards process templates (Basic, Agile, Scrum, CMMI). */
export const DEFAULT_ADO_WORK_ITEM_TYPE = 'Task';

export type SettingScope = 'global' | 'workspace' | 'both';
export type SettingSource = 'workspace' | 'global' | 'default';

export interface SettingDef<T> {
    readonly scope: SettingScope;
    readonly fallback: T;
    /** `ghostpm config set` arguments to a value. Throws a message the user can act on. */
    parse(values: readonly string[]): T;
    /** Guards stored JSON: anything it rejects reads as the default. */
    accepts(value: unknown): boolean;
    /**
     * For settings set a part at a time: what `ghostpm config set` stores, given the value already stored at that
     * scope and the parsed one. undefined removes the value. Without it the parsed value replaces the stored one.
     */
    combine?(stored: unknown, parsed: T): T | undefined;
}

const MAP_SEPARATOR = '=';
const POSITIVE_INT = /^[1-9]\d*$/;
const BOOLEAN_TEXT: { [text: string]: boolean | undefined } = { true: true, false: false };

function single(values: readonly string[]): string {
    if (values.length !== 1) throw new Error('expects exactly one value');
    return values[0];
}

function choice<T extends string>(options: readonly T[], fallback: T, scope: SettingScope): SettingDef<T> {
    const accepts = (value: unknown): value is T =>
        typeof value === 'string' && (options as readonly string[]).indexOf(value) >= 0;
    return {
        scope, fallback, accepts,
        parse: values => {
            const value = single(values);
            if (!accepts(value)) throw new Error(`must be one of: ${options.join(', ')}`);
            return value;
        },
    };
}

function flag(fallback: boolean, scope: SettingScope): SettingDef<boolean> {
    return {
        scope, fallback,
        accepts: value => typeof value === 'boolean',
        parse: values => {
            const value = BOOLEAN_TEXT[single(values)];
            if (value === undefined) throw new Error('must be true or false');
            return value;
        },
    };
}

function positiveInt(fallback: number, scope: SettingScope): SettingDef<number> {
    return {
        scope, fallback,
        accepts: value => typeof value === 'number' && Number.isInteger(value) && value > 0,
        parse: values => {
            const text = single(values);
            if (!POSITIVE_INT.test(text)) throw new Error('must be a whole number above 0');
            return Number(text);
        },
    };
}

function text(fallback: string, scope: SettingScope): SettingDef<string> {
    return {
        scope, fallback,
        accepts: value => typeof value === 'string' && value.trim().length > 0,
        parse: values => {
            const value = single(values).trim();
            if (value.length === 0) throw new Error('must not be empty');
            return value;
        },
    };
}

function textList(fallback: readonly string[], scope: SettingScope): SettingDef<readonly string[]> {
    const accepts = (value: unknown): boolean => Array.isArray(value) && value.length > 0
        && value.every(item => typeof item === 'string' && item.trim().length > 0);
    return {
        scope, fallback, accepts,
        parse: values => {
            const list = values.map(value => value.trim());
            if (!accepts(list)) throw new Error('expects one or more non-empty values');
            return list;
        },
    };
}

/** What a value is refused for, or null: checks a value set for one phase. */
type ValueCheck = (value: string) => string | null;

const isPlainObject = (value: unknown): value is { [key: string]: unknown } =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * `phase=Value` pairs for `phases`. `ghostpm config set` merges them into the map already stored at that scope, and
 * `phase=` with no value removes that phase; the whole map goes with `config unset`.
 */
function phaseMap(scope: SettingScope, phases: readonly Phase[], what: string, check: ValueCheck = () => null): SettingDef<PhaseStateMap> {
    const allowed = (key: string): boolean => isPhase(key) && phases.indexOf(key) >= 0;
    const accepts = (value: unknown): boolean => isPlainObject(value)
        && Object.keys(value).every(key => allowed(key) && typeof value[key] === 'string' && (value[key] as string).length > 0
            && check(value[key] as string) === null);
    const pairHint = `phase${MAP_SEPARATOR}${what}`;
    return {
        scope, fallback: {}, accepts,
        parse: values => {
            if (values.length === 0) throw new Error(`expects ${pairHint} pairs (${'phase' + MAP_SEPARATOR} with no value removes one)`);
            // Empty values mark a removal for combine; never stored as they are.
            const patch: PhaseStateMap = {};
            for (const pair of values) {
                const at = pair.indexOf(MAP_SEPARATOR);
                const phase = pair.slice(0, at).trim();
                const value = pair.slice(at + 1).trim();
                if (at < 0 || !allowed(phase)) {
                    throw new Error(`"${pair}" is not ${pairHint}; phases are ${phases.join(', ')}`);
                }
                const refused = value.length === 0 ? null : check(value);
                if (refused !== null) throw new Error(`"${pair}": ${refused}`);
                patch[phase as Phase] = value;
            }
            return patch;
        },
        combine: (stored, patch) => {
            const merged: PhaseStateMap = accepts(stored) ? { ...(stored as PhaseStateMap) } : {};
            for (const phase of Object.keys(patch) as Phase[]) {
                if (patch[phase] === '') delete merged[phase];
                else merged[phase] = patch[phase];
            }
            return Object.keys(merged).length === 0 ? undefined : merged;
        },
    };
}

/** Why `name` cannot start a GitHub label (`whole`: cannot be one), or null. */
function labelProblem(name: string, limit: number, whole: boolean): string | null {
    if (name.indexOf(LABEL_LIST_SEPARATOR) >= 0) return 'a label cannot contain a comma (gh reads it as a list)';
    if (CONTROL.test(name)) return 'a label cannot contain control characters';
    if (name !== name.trimStart() || (whole && name !== name.trimEnd())) return 'a label cannot start or end with a space';
    if (name.length > limit) return `at most ${limit} characters`;
    return null;
}

const labelNameProblem = (name: string): string | null => labelProblem(name, LABEL_NAME_LIMIT, true);

/** The label prefix: any text a label can start with, the empty prefix included (`ghostpm config set label_prefix ""`). */
function labelPrefix(scope: SettingScope): SettingDef<string> {
    const problem = (value: string): string | null => labelProblem(value, LABEL_PREFIX_LIMIT, false);
    return {
        scope, fallback: DEFAULT_LABEL_PREFIX,
        accepts: value => typeof value === 'string' && problem(value) === null,
        parse: values => {
            const value = single(values);
            const refused = problem(value);
            if (refused !== null) throw new Error(`${refused} (use "" for no prefix)`);
            return value;
        },
    };
}

/** Spec §8.2, defined once: scope, default and validation for every user-facing setting. */
export const SETTING_DEFS = {
    [SETTING_SYNC_POLICY]: choice(SYNC_POLICIES, SYNC_POLICY_OFF, 'both'),
    [SETTING_PROGRESS_COMMENTS]: choice(PROGRESS_COMMENT_MODES, PROGRESS_COMMENTS_PHASE, 'both'),
    [SETTING_CREATE_BRANCH]: flag(false, 'both'),
    [SETTING_PHASE_STATE_MAP]: phaseMap('workspace', PHASES, 'State'),
    [SETTING_LABEL_PREFIX]: labelPrefix('both'),
    [SETTING_PHASE_LABEL_MAP]: phaseMap('both', LABELLED_PHASES, 'Label', labelNameProblem),
    [SETTING_COMPLETION]: choice(COMPLETION_MODES, COMPLETION_ASK, 'both'),
    [SETTING_ADO_WORK_ITEM_TYPE]: text(DEFAULT_ADO_WORK_ITEM_TYPE, 'workspace'),
    [SETTING_PLAN_GLOBS]: textList(DEFAULT_PLAN_GLOBS, 'both'),
    [SETTING_SYNC_PULL_MINUTES]: positiveInt(DEFAULT_SYNC_PULL_MINUTES, 'global'),
    [SETTING_STALE_SESSION_MINUTES]: positiveInt(DEFAULT_STALE_SESSION_MINUTES, 'global'),
    [SETTING_MAX_PUSH_ATTEMPTS]: positiveInt(DEFAULT_MAX_PUSH_ATTEMPTS, 'global'),
};

export type SettingKey = keyof typeof SETTING_DEFS;
export type SettingValue<K extends SettingKey> = (typeof SETTING_DEFS)[K]['fallback'];

export function isSettingKey(key: string): key is SettingKey {
    return Object.prototype.hasOwnProperty.call(SETTING_DEFS, key);
}

type SettingsObject = Record<string, unknown>;

export function getSetting<T>(db: Ledger, key: string): T | undefined {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
}

export function setSetting(db: Ledger, key: string, value: unknown): void {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, JSON.stringify(value));
}

export function deleteSetting(db: Ledger, key: string): void {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

function readWorkspaceSettings(db: Ledger, workspaceId: number): SettingsObject | undefined {
    const row = db.prepare('SELECT settings FROM workspaces WHERE id = ?').get(workspaceId) as { settings: string } | undefined;
    return row ? JSON.parse(row.settings) as SettingsObject : undefined;
}

export function getWorkspaceSetting<T>(db: Ledger, workspaceId: number, key: string): T | undefined {
    return readWorkspaceSettings(db, workspaceId)?.[key] as T | undefined;
}

/** Read-modify-write under an immediate lock. Passing undefined removes the key. */
export function setWorkspaceSetting(db: Ledger, workspaceId: number, key: string, value: unknown): void {
    write(db, () => {
        const settings = readWorkspaceSettings(db, workspaceId);
        if (!settings) throw new Error(`Workspace ${workspaceId} not found`);
        if (value === undefined) delete settings[key];
        else settings[key] = value;
        db.prepare('UPDATE workspaces SET settings = ? WHERE id = ?').run(JSON.stringify(settings), workspaceId);
    });
}

/** Workspace override, then global setting, then fallback. For keys outside SETTING_DEFS. */
export function resolveSetting<T>(db: Ledger, workspaceId: number | null, key: string, fallback: T): T {
    const scoped = workspaceId === null ? undefined : getWorkspaceSetting<T>(db, workspaceId, key);
    if (scoped !== undefined) return scoped;
    return getSetting<T>(db, key) ?? fallback;
}

export interface ExplainedSetting<T> {
    value: T;
    source: SettingSource;
}

/** The effective value and where it comes from. A stored value the definition rejects is skipped. */
export function explainSetting<K extends SettingKey>(
    db: Ledger,
    workspaceId: number | null,
    key: K,
): ExplainedSetting<SettingValue<K>> {
    const def: SettingDef<unknown> = SETTING_DEFS[key];
    if (def.scope !== 'global' && workspaceId !== null) {
        const scoped = getWorkspaceSetting<unknown>(db, workspaceId, key);
        if (scoped !== undefined && def.accepts(scoped)) return { value: scoped as SettingValue<K>, source: 'workspace' };
    }
    if (def.scope !== 'workspace') {
        const global = getSetting<unknown>(db, key);
        if (global !== undefined && def.accepts(global)) return { value: global as SettingValue<K>, source: 'global' };
    }
    return { value: def.fallback as SettingValue<K>, source: 'default' };
}

export function readSetting<K extends SettingKey>(db: Ledger, workspaceId: number | null, key: K): SettingValue<K> {
    return explainSetting(db, workspaceId, key).value;
}

export function getSyncPause(db: Ledger, workspaceId: number): string | undefined {
    return getWorkspaceSetting<string>(db, workspaceId, SETTING_SYNC_PAUSED);
}

/** Passing undefined resumes sync for the workspace. */
export function setSyncPause(db: Ledger, workspaceId: number, reason: string | undefined): void {
    setWorkspaceSetting(db, workspaceId, SETTING_SYNC_PAUSED, reason);
}
