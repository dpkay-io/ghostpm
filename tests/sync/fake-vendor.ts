import { Phase } from '../../src/ledger/types';
import { githubPhaseOf, phaseLabel, PHASE_LABEL_PREFIX } from '../../src/sync/github';
import { isLossyCopy } from '../../src/sync/azure';
import { DesiredState, GoneError, LinkState, RemoteItem, VendorAdapter, stripMarkers } from '../../src/sync/vendor';

const TICK_MS = 1000;
const CLOSED_STATE: Partial<Record<Phase, string>> = { done: 'closed:completed', dropped: 'closed:not_planned' };
const OPEN = 'open';
const DUPLICATE_STATE = 'closed:duplicate';
const REPO_URL = 'https://github.com/acme/widgets/issues/';

export interface FakeCall {
    op: string;
    remoteId?: string;
    title?: string;
    phase?: Phase;
    text?: string;
    body?: string;
}

/** What the adapter answers: its own copy, markers stripped from the body like the real adapters do. */
const copy = (item: RemoteItem): RemoteItem =>
    ({ ...item, body: item.body === null ? null : stripMarkers(item.body), labels: item.labels.slice() });

/** An in-memory, GitHub-like vendor: phases are `ghostpm:` labels, done/dropped are closed states. */
export class FakeVendor implements VendorAdapter {
    readonly items = new Map<string, RemoteItem>();
    readonly calls: FakeCall[] = [];
    /** PR url → merge time. */
    readonly prs = new Map<string, string>();
    user = 'octocat';
    /** Comments posted, per item. */
    readonly comments = new Map<string, string[]>();
    /** Thrown by the next vendor call, then cleared. */
    failNext: Error | null = null;
    /** Thrown by the next write (create, syncState, comment, closeDuplicate) after it took effect, then cleared: the answer lost, the change made. */
    failAfterApply: Error | null = null;
    /** While set, syncState waits on it: lets a test act while a push is out. */
    hold: Promise<void> | null = null;
    /** Compare titles the way the Azure DevOps adapter does. */
    lossyTitles = false;
    /** Lists by page, as GitHub does; false answers every match, as Azure DevOps does. */
    pages = true;
    private next = 1;
    /** Every vendor change is a second after the previous one, starting now: later than any pull begun before it. */
    private clock = Date.now();

    private tick(): string {
        this.clock += TICK_MS;
        return new Date(this.clock).toISOString();
    }

    private guard(): void {
        const failure = this.failNext;
        this.failNext = null;
        if (failure !== null) throw failure;
    }

    /** The write's answer, unless it is the one set to be lost. */
    private answer<T>(result: T): T {
        const failure = this.failAfterApply;
        this.failAfterApply = null;
        if (failure !== null) throw failure;
        return result;
    }

    private item(remoteId: string): RemoteItem {
        const item = this.items.get(remoteId);
        if (item === undefined) throw new GoneError(`#${remoteId} is gone`);
        return item;
    }

    private apply(item: RemoteItem, desired: DesiredState): void {
        item.title = desired.title;
        item.state = CLOSED_STATE[desired.phase] ?? OPEN;
        item.labels = item.labels.filter(label => !label.startsWith(PHASE_LABEL_PREFIX));
        if (CLOSED_STATE[desired.phase] === undefined) item.labels.push(phaseLabel(desired.phase));
        item.updatedAt = this.tick();
    }

    /** An item a person created on the vendor. */
    seed(fields: Partial<RemoteItem> & { title: string }): RemoteItem {
        const remoteId = String(this.next++);
        const item: RemoteItem = {
            remoteId, url: `${REPO_URL}${remoteId}`, body: null, state: OPEN, labels: [], assignee: null, milestone: null,
            ...fields, updatedAt: this.tick(),
        };
        this.items.set(remoteId, item);
        return copy(item);
    }

    /** A person editing the item on the vendor's side. */
    humanEdit(remoteId: string, change: Partial<Pick<RemoteItem, 'title' | 'body' | 'state' | 'labels' | 'assignee'>>): void {
        Object.assign(this.item(remoteId), change, { updatedAt: this.tick() });
    }

    async create(desired: DesiredState, body: string): Promise<RemoteItem> {
        this.guard();
        const item = this.seed({ title: desired.title, body });
        this.apply(this.item(item.remoteId), desired);
        this.calls.push({ op: 'create', remoteId: item.remoteId, title: desired.title, phase: desired.phase, body });
        return this.answer(copy(this.item(item.remoteId)));
    }

    async syncState(link: LinkState, desired: DesiredState): Promise<RemoteItem> {
        this.guard();
        if (this.hold !== null) await this.hold;
        const item = this.item(link.remoteId);
        this.apply(item, desired);
        this.calls.push({ op: 'syncState', remoteId: link.remoteId, title: desired.title, phase: desired.phase });
        return this.answer(copy(item));
    }

    async comment(remoteId: string, text: string): Promise<RemoteItem | null> {
        this.guard();
        const item = this.item(remoteId);
        item.updatedAt = this.tick();
        this.comments.set(remoteId, (this.comments.get(remoteId) ?? []).concat(text));
        this.calls.push({ op: 'comment', remoteId, text });
        return this.answer(copy(item));
    }

    async closeDuplicate(remoteId: string, ofRemoteId: string): Promise<RemoteItem> {
        this.guard();
        const item = this.item(remoteId);
        item.state = DUPLICATE_STATE;
        item.updatedAt = this.tick();
        this.calls.push({ op: 'closeDuplicate', remoteId, text: ofRemoteId });
        return this.answer(copy(item));
    }

    async findCreated(marker: string, title: string): Promise<RemoteItem | null> {
        this.guard();
        this.calls.push({ op: 'findCreated', title, text: marker });
        const found = Array.from(this.items.values()).find(item => (item.body ?? '').indexOf(marker) >= 0);
        return found === undefined ? null : copy(found);
    }

    async hasComment(remoteId: string, marker: string): Promise<boolean> {
        this.guard();
        this.calls.push({ op: 'hasComment', remoteId, text: marker });
        return (this.comments.get(remoteId) ?? []).some(text => text.indexOf(marker) >= 0);
    }

    async listChangedSince(since: string, limit: number): Promise<RemoteItem[]> {
        this.guard();
        this.calls.push({ op: 'list', text: since });
        return Array.from(this.items.values())
            .filter(item => Date.parse(item.updatedAt) >= Date.parse(since))
            .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
            .slice(0, this.pages ? limit : undefined)
            .map(copy);
    }

    async fetch(remoteId: string): Promise<RemoteItem | null> {
        this.guard();
        this.calls.push({ op: 'fetch', remoteId });
        const item = this.items.get(remoteId);
        return item === undefined ? null : copy(item);
    }

    async mergedAt(prUrl: string): Promise<string | null> {
        this.calls.push({ op: 'mergedAt', text: prUrl });
        return this.prs.get(prUrl) ?? null;
    }

    async currentUser(): Promise<string> {
        this.guard();
        this.calls.push({ op: 'currentUser' });
        return this.user;
    }

    phaseOf(state: string, labels: string[], localPhase: Phase): Phase {
        return githubPhaseOf(state, labels, localPhase);
    }

    titlesMatch(received: string, known: string): boolean {
        return received === known || (this.lossyTitles && isLossyCopy(received, known));
    }
}
