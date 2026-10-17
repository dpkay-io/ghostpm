export const PHASES = ['brainstorming', 'planned', 'in_progress', 'in_review', 'done', 'dropped'] as const;
export type Phase = typeof PHASES[number];
/** Terminal phases: evidence never moves a task out of them; only track_work reopens. */
export const CLOSED_PHASES: ReadonlySet<Phase> = new Set<Phase>(['done', 'dropped']);

export const INTENTS = ['brainstorm', 'plan', 'implement', 'fix'] as const;
export type Intent = typeof INTENTS[number];

/** Phase a newly tracked task starts in. Evidence (Phase 2 hooks) moves it further. */
export const INTENT_PHASE: Record<Intent, Phase> = {
    brainstorm: 'brainstorming',
    plan: 'planned',
    implement: 'planned',
    fix: 'planned',
};

export const EVENT_KINDS = ['created', 'phase', 'progress', 'commit', 'pr', 'comment', 'renamed', 'merged', 'dropped', 'linked'] as const;
export type EventKind = typeof EVENT_KINDS[number];

export type Vendor = 'github' | 'azure_devops' | 'none';
export const NO_VENDOR: Vendor = 'none';
/** Its own literal type, so comparing a vendor identity's `vendor` with it narrows the identity. */
export const AZURE_DEVOPS = 'azure_devops';
export type Origin = 'local' | 'vendor';
/** A task that came from GitHub or Azure DevOps. */
export const VENDOR_ORIGIN: Origin = 'vendor';
/** Event source for anything that came from GitHub or Azure DevOps. Never projected back. */
export const VENDOR_SOURCE = 'vendor';
/** Event source for what the sync engine records itself: links, broken links, merged-PR moves. */
export const SYNC_SOURCE = 'sync';

export const TASK_ID_PREFIX = 'T';
export const formatTaskId = (id: number): string => `${TASK_ID_PREFIX}${id}`;
/** `1 commit`, `2 commits`; `suffix` for nouns that take another (`2 pushes`). */
export const plural = (count: number, noun: string, suffix = 's'): string => `${count} ${noun}${count === 1 ? '' : suffix}`;
export const isPhase = (value: string): value is Phase => (PHASES as readonly string[]).includes(value);

export interface TaskRow {
    id: number;
    title: string;
    phase: Phase;
    workspace_id: number | null;
    origin: Origin;
    summary: string | null;
    body: string | null;
    assignee: string | null;
    milestone: string | null;
    rev: number;
    human_phase_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface EventRow {
    seq: number;
    task_id: number | null;
    session_id: string | null;
    source: string;
    kind: EventKind;
    payload: string | null;
    at: string;
}

export interface WorkspaceRow {
    id: number;
    path: string;
    git_remote: string | null;
    vendor: Vendor;
    settings: string;
}

export interface SessionRow {
    id: string;
    client: string;
    cwd: string;
    workspace_id: number | null;
    task_id: number | null;
    transcript_path: string | null;
    client_pid: number | null;
    started_at: string;
    last_seen_at: string;
    ended_at: string | null;
}

export interface VendorLinkRow {
    task_id: number;
    vendor: Vendor;
    remote_id: string;
    remote_url: string | null;
    remote_state: string | null;
    labels: string | null;
    remote_updated_at: string | null;
    last_pushed_rev: number | null;
    /** Last title seen on, or pushed to, the vendor: the human-wins baseline (spec §8.6). */
    remote_title: string | null;
    /** Set when the vendor item was deleted or moved away; the task stays local (spec §8.5). */
    broken_at: string | null;
    /** The push in flight, written just before the vendor call: a newer vendor item matching it is ours, not a person's edit. */
    intent_title: string | null;
    intent_phase: Phase | null;
    intent_rev: number | null;
}
