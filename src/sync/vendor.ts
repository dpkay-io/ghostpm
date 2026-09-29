import { Phase } from '../ledger/types';

/** One shape for a GitHub issue and an Azure Boards work item. */
export interface RemoteItem {
    remoteId: string;
    url: string | null;
    title: string;
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
    comment(remoteId: string, text: string): Promise<RemoteItem>;
    closeDuplicate(remoteId: string, ofRemoteId: string): Promise<RemoteItem>;
    /** Items changed at or after `since` in every state, oldest change first; at most `limit` where the vendor pages. */
    listChangedSince(since: string, limit: number): Promise<RemoteItem[]>;
    /** null when the item was deleted or moved out of this repository or project. */
    fetch(remoteId: string): Promise<RemoteItem | null>;
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
