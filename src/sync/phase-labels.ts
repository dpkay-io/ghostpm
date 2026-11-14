import { Ledger, nowIso } from '../ledger/db';
import { projectTask } from '../ledger/projection';
import {
    DEFAULT_LABEL_PREFIX, LABELLED_PHASES, PhaseLabelMap, getWorkspaceSetting, readSetting, setWorkspaceSetting,
    SETTING_LABEL_PREFIX, SETTING_PHASE_LABEL_MAP, SETTING_RETIRED_PHASE_LABELS,
} from '../ledger/settings';
import { CLOSED_PHASES, Phase, TaskRow, WorkspaceRow, isPhase } from '../ledger/types';
import { parseLabels } from './vendor';

/** GitHub matches label names without regard to case: so does every comparison here. */
const keyOf = (label: string): string => label.toLowerCase();
export const sameLabel = (a: string, b: string): boolean => keyOf(a) === keyOf(b);

/** Label to phase, as stored under retired_phase_labels. */
export type RetiredLabels = { [label: string]: Phase };

/** The label each open phase shows on GitHub, and which labels are GhostPM's to read and replace. */
export interface PhaseLabels {
    /** The label a push gives `phase` (an open phase: a closed issue carries none). */
    label(phase: Phase): string;
    /** The phase `label` shows, or null when it is not one of GhostPM's phase labels. */
    phaseOf(label: string): Phase | null;
    /** The phase `label` shows when it is a current label (not a default or retired one), else null. */
    currentPhaseOf(label: string): Phase | null;
    /** Whether `label` is one of GhostPM's phase labels: current, retired, or the default `ghostpm:` ones. */
    isOurs(label: string): boolean;
}

/** Each open phase's label under `prefix` and `map`. */
export function labelNames(prefix: string, map: PhaseLabelMap): Record<Phase, string> {
    const names = {} as Record<Phase, string>;
    for (const phase of LABELLED_PHASES) names[phase] = map[phase] ?? `${prefix}${phase}`;
    return names;
}

/** Two phases that would show the same label (a push could then not tell them apart), or null. */
export function labelClash(names: Record<Phase, string>): [Phase, Phase] | null {
    const seen = new Map<string, Phase>();
    for (const phase of LABELLED_PHASES) {
        const earlier = seen.get(keyOf(names[phase]));
        if (earlier !== undefined) return [earlier, phase];
        seen.set(keyOf(names[phase]), phase);
    }
    return null;
}

/**
 * Lookups, most authoritative first: the current labels, then the defaults (issues labelled before any prefix was
 * set), then labels an earlier setting gave. A label in several reads as the first.
 */
export function phaseLabelsFrom(prefix: string, map: PhaseLabelMap, retired: RetiredLabels = {}): PhaseLabels {
    const current = labelNames(prefix, map);
    const byCurrent = new Map<string, Phase>(LABELLED_PHASES.map(phase => [keyOf(current[phase]), phase]));
    const byLabel = new Map<string, Phase>();
    const learn = (label: string, phase: Phase): void => {
        if (!byLabel.has(keyOf(label))) byLabel.set(keyOf(label), phase);
    };
    for (const phase of LABELLED_PHASES) learn(current[phase], phase);
    for (const phase of LABELLED_PHASES) learn(`${DEFAULT_LABEL_PREFIX}${phase}`, phase);
    for (const label of Object.keys(retired)) {
        const phase = retired[label];
        if (isPhase(phase) && !CLOSED_PHASES.has(phase)) learn(label, phase);
    }
    return {
        label: phase => current[phase],
        phaseOf: label => byLabel.get(keyOf(label)) ?? null,
        currentPhaseOf: label => byCurrent.get(keyOf(label)) ?? null,
        isOurs: label => byLabel.has(keyOf(label)),
    };
}

export const DEFAULT_PHASE_LABELS: PhaseLabels = phaseLabelsFrom(DEFAULT_LABEL_PREFIX, {});

/** The effective label names for a workspace (or the global ones for null). */
export function workspaceLabelNames(db: Ledger, workspaceId: number | null): Record<Phase, string> {
    return labelNames(readSetting(db, workspaceId, SETTING_LABEL_PREFIX), readSetting(db, workspaceId, SETTING_PHASE_LABEL_MAP));
}

const retiredOf = (db: Ledger, workspaceId: number): RetiredLabels =>
    getWorkspaceSetting<RetiredLabels>(db, workspaceId, SETTING_RETIRED_PHASE_LABELS) ?? {};

/** What the GitHub adapter of a workspace labels phases with. */
export function phaseLabelsFor(db: Ledger, workspaceId: number): PhaseLabels {
    return phaseLabelsFrom(
        readSetting(db, workspaceId, SETTING_LABEL_PREFIX), readSetting(db, workspaceId, SETTING_PHASE_LABEL_MAP), retiredOf(db, workspaceId),
    );
}

const GITHUB = 'github';

const githubWorkspaces = (db: Ledger): WorkspaceRow[] =>
    db.prepare('SELECT * FROM workspaces WHERE vendor = ? ORDER BY id').all(GITHUB) as WorkspaceRow[];

/** Each GitHub workspace's label names, taken before a label setting changes. */
export function snapshotLabelNames(db: Ledger): Map<number, Record<Phase, string>> {
    return new Map(githubWorkspaces(db).map(workspace => [workspace.id, workspaceLabelNames(db, workspace.id)]));
}

/** The first clash any GitHub workspace (or the global setting) would have, worded for the user, or null. */
export function describeLabelClash(db: Ledger): string | null {
    const scopes: { where: string; id: number | null }[] = [{ where: 'global', id: null }];
    for (const workspace of githubWorkspaces(db)) scopes.push({ where: `workspace ${workspace.path}`, id: workspace.id });
    for (const scope of scopes) {
        const names = workspaceLabelNames(db, scope.id);
        const clash = labelClash(names);
        if (clash !== null) return `${clash[0]} and ${clash[1]} would both be labelled "${names[clash[0]]}" (${scope.where})`;
    }
    return null;
}

/**
 * After a label setting changed: in each GitHub workspace whose labels moved, the old labels are retired (still read,
 * and replaced on the next push), and every linked open task is queued to show its new label. Returns how many tasks
 * were queued (none while that workspace's sync is off: its labels move with its next push). Call inside write().
 */
export function relabelChanged(db: Ledger, before: Map<number, Record<Phase, string>>): number {
    const at = nowIso();
    let queued = 0;
    for (const workspace of githubWorkspaces(db)) {
        const old = before.get(workspace.id);
        if (old === undefined) continue;
        const now = workspaceLabelNames(db, workspace.id);
        const moved = LABELLED_PHASES.filter(phase => !sameLabel(old[phase], now[phase]));
        if (moved.length === 0) continue;
        const retired = retiredOf(db, workspace.id);
        // Read before the old labels are retired: what counted as GhostPM's labels until this change.
        const wasOurs = phaseLabelsFrom('', old, retired);
        // The default labels are always read as their phase: only the others need remembering.
        for (const phase of moved) if (!sameLabel(old[phase], `${DEFAULT_LABEL_PREFIX}${phase}`)) retired[old[phase]] = phase;
        // A label in use again is current, not retired.
        for (const phase of LABELLED_PHASES) {
            for (const label of Object.keys(retired)) if (sameLabel(label, now[phase])) delete retired[label];
        }
        setWorkspaceSetting(db, workspace.id, SETTING_RETIRED_PHASE_LABELS, Object.keys(retired).length === 0 ? undefined : retired);
        queued += requeueOpenLinked(db, workspace, moved, wasOurs, at);
    }
    return queued;
}

/**
 * Open tasks in `phases` with a working link whose item, as last seen, carries one of GhostPM's labels (`wasOurs`): it
 * no longer shows what was last pushed, so it pushes again. An item that never carried one (imported from the vendor
 * and never changed here) is left as it is: a rename is no reason to label it.
 */
function requeueOpenLinked(db: Ledger, workspace: WorkspaceRow, phases: readonly Phase[], wasOurs: PhaseLabels, at: string): number {
    const rows = db.prepare(`
        SELECT t.*, l.labels AS link_labels FROM tasks t JOIN vendor_links l ON l.task_id = t.id
        WHERE t.workspace_id = ? AND l.broken_at IS NULL AND t.phase IN (${phases.map(() => '?').join(', ')})
        ORDER BY t.id`)
        .all(workspace.id, ...phases) as (TaskRow & { link_labels: string | null })[];
    const tasks = rows.filter(row => parseLabels(row.link_labels).some(label => wasOurs.isOurs(label)));
    let queued = 0;
    for (const { link_labels: _labels, ...task } of tasks) {
        db.prepare('UPDATE vendor_links SET last_pushed_rev = NULL WHERE task_id = ?').run(task.id);
        if (projectTask(db, task, 'change', at) === 'sync_queued') queued++;
    }
    return queued;
}
