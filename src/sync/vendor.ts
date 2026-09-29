import { Phase } from '../ledger/types';

/** Every vendor CLI call is killed after this: well inside the sync lease's 60 s TTL (lease.ts), so a hung gh/az cannot outlive the lease. */
export const VENDOR_CALL_TIMEOUT_MS = 45 * 1000;

/**
 * Idempotency marker, hidden at the end of a created item's body or a comment: a retry looks for it to tell
 * whether its earlier attempt landed. Never part of what a task shows locally.
 */
const MARKER_OPEN = '<!-- ghostpm:';
const MARKER_CLOSE = ' -->';
export const MARKER_NONCE_BYTES = 8;
const HEX_PER_BYTE = 2;
export const idempotencyMarker = (nonce: string): string => `${MARKER_OPEN}${nonce}${MARKER_CLOSE}`;
/** No leading `\s*`: with /g that retries from every whitespace character, quadratic on a long run of it. */
const MARKER = new RegExp(`${MARKER_OPEN}[0-9a-f]{${MARKER_NONCE_BYTES * HEX_PER_BYTE}}${MARKER_CLOSE}`, 'g');
const WHITESPACE = /\s/;

/**
 * The text without our markers, and without the whitespace we put before each one. Linear: the backward trim
 * never passes the text already kept.
 */
export function stripMarkers(text: string): string {
    let kept = '';
    let from = 0;
    MARKER.lastIndex = 0;
    for (let marker = MARKER.exec(text); marker !== null; marker = MARKER.exec(text)) {
        let cut = marker.index;
        while (cut > from && WHITESPACE.test(text[cut - 1])) cut--;
        kept += text.slice(from, cut);
        from = marker.index + marker[0].length;
    }
    return kept + text.slice(from);
}

/** One shape for a GitHub issue and an Azure Boards work item. */
export interface RemoteItem {
    remoteId: string;
    url: string | null;
    title: string;
    /** Without GhostPM's retry markers: adapters strip them as they read, so no ledger transaction ever has to. */
    body: string | null;
    /** Exactly what vendor_links.remote_state stores: GitHub `open`, `closed` or `closed:<reason>`; ADO System.State. */
    state: string;
    labels: string[];
    assignee: string | null;
    milestone: string | null;
    updatedAt: string;
}

export interface DesiredState {
    title: string;
    phase: Phase;
}

export interface LinkState {
    remoteId: string;
    state: string | null;
    labels: string[];
}

/** Every write resolves to the item as the vendor holds it afterwards: the new baseline (spec §8.6). */
export interface VendorAdapter {
    create(desired: DesiredState, body: string): Promise<RemoteItem>;
    syncState(link: LinkState, desired: DesiredState): Promise<RemoteItem>;
    /** null: the comment was posted but the item could not be re-read. Callers must not update any baseline from null. */
    comment(remoteId: string, text: string): Promise<RemoteItem | null>;
    closeDuplicate(remoteId: string, ofRemoteId: string): Promise<RemoteItem>;
    /** Items changed at or after `since` in every state, oldest change first; at most `limit` where the vendor pages. */
    listChangedSince(since: string, limit: number): Promise<RemoteItem[]>;
    /** null when the item was deleted or moved out of this repository or project. */
    fetch(remoteId: string): Promise<RemoteItem | null>;
    /**
     * The item an earlier attempt created, found by `marker` in its body among recent items; null if none.
     * `title` is the title that attempt sent (Azure DevOps narrows by it).
     */
    findCreated(marker: string, title: string): Promise<RemoteItem | null>;
    /** Whether an earlier attempt's comment carrying `marker` is on the item. */
    hasComment(remoteId: string, marker: string): Promise<boolean>;
    /** When the pull request merged; null if it has not, or if it is not this repository's. */
    mergedAt(prUrl: string): Promise<string | null>;
    currentUser(): Promise<string>;
    /** The phase a vendor state means; `localPhase` stands wherever the vendor has no opinion. */
    phaseOf(state: string, labels: string[], localPhase: Phase): Phase;
    /** Whether a title read back is the known one, allowing for the CLI's output encoding. */
    titlesMatch(received: string, known: string): boolean;
}

/** Nothing this workspace pushes can succeed until a person acts (log in, install, fix the remote). */
export class SyncPausedError extends Error {
    constructor(readonly reason: string) {
        super(reason);
        this.name = 'SyncPausedError';
    }
}

/** The item was deleted, or moved out of the repository or project. */
export class GoneError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GoneError';
    }
}

/** Retrying cannot help (for example a phase with no mapped Azure DevOps state). */
export class PermanentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PermanentError';
    }
}

export const linkStateOf = (item: RemoteItem): LinkState => ({ remoteId: item.remoteId, state: item.state, labels: item.labels });

/** vendor_links.labels is a JSON array; 1.4.0 Azure imports stored raw tag text, which reads as none. */
export function parseLabels(json: string | null): string[] {
    if (json === null) return [];
    try {
        const parsed: unknown = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.filter((label): label is string => typeof label === 'string') : [];
    } catch {
        return [];
    }
}
