import { CliArg, CliError, Runner, freeText, runCli } from '../cli';
import { CLOSED_PHASES, Phase, isPhase } from '../ledger/types';
import { REOPEN_PHASE } from '../ledger/work';
import { DesiredState, GoneError, LinkState, RemoteItem, SyncPausedError, VendorAdapter, linkStateOf } from './vendor';

const GH = 'gh';
export const PHASE_LABEL_PREFIX = 'ghostpm:';
const ISSUE_FIELDS = 'number,title,body,state,stateReason,labels,assignees,milestone,updatedAt,url';
const PR_FIELDS = 'state,mergedAt';
const JSON_FLAG = '--json';
const REPO_FLAG = '--repo';
const STDIN_FILE = '-';
const CLOSED = 'closed';
const REASON_SEPARATOR = ':';
const NOT_PLANNED = 'not_planned';
const DUPLICATE = 'duplicate';
const MERGED = 'MERGED';
/** `gh help exit-codes`: "If a command requires authentication, the exit code will be 4". */
const AUTH_REQUIRED_EXIT = 4;
const GONE = /Could not resolve to an issue|HTTP 404|HTTP 410/i;
const CREATED_ISSUE = /\/issues\/(\d+)\s*$/;
const LEADING_NUMBER = /^\d+/;
const CLOSE_REASON: Partial<Record<Phase, string>> = { done: 'completed', dropped: 'not planned' };

export const GH_MISSING = 'GitHub CLI (gh) was not found. Install it, or set GHOSTPM_GH to its path, then run `ghostpm sync`.';
export const GH_LOGGED_OUT = 'GitHub CLI is not logged in. Run `gh auth login`, then `ghostpm sync`.';
const ghRefused = (detail: string): string => `GhostPM will not run gh this way (${detail}). Fix that, then run \`ghostpm sync\`.`;

interface GhIssue {
    number: number;
    title: string;
    body?: string | null;
    state: string;
    stateReason?: string | null;
    labels?: { name: string }[];
    assignees?: { login: string }[];
    milestone?: { title: string } | null;
    updatedAt: string;
    url?: string;
}

/** Created once per repo per process: `gh label create --force` before first use (spec §8.3). */
const ensuredLabels = new Set<string>();

export const phaseLabel = (phase: Phase): string => `${PHASE_LABEL_PREFIX}${phase}`;

function labelledPhase(labels: string[]): Phase | null {
    for (const label of labels) {
        const name = label.startsWith(PHASE_LABEL_PREFIX) ? label.slice(PHASE_LABEL_PREFIX.length) : '';
        if (isPhase(name) && !CLOSED_PHASES.has(name)) return name;
    }
    return null;
}

/** GitHub knows open/closed and our phase label; everything else is the local phase's to say. */
export function githubPhaseOf(state: string, labels: string[], localPhase: Phase): Phase {
    const [base, reason] = state.split(REASON_SEPARATOR);
    if (base === CLOSED) return reason === NOT_PLANNED || reason === DUPLICATE ? 'dropped' : 'done';
    const labelled = labelledPhase(labels);
    if (labelled !== null) return labelled;
    return CLOSED_PHASES.has(localPhase) ? REOPEN_PHASE : localPhase;
}

function toItem(issue: GhIssue): RemoteItem {
    const state = issue.state.toLowerCase();
    const reason = (issue.stateReason ?? '').toLowerCase();
    return {
        remoteId: String(issue.number),
        url: issue.url ?? null,
        title: issue.title,
        body: issue.body ?? null,
        state: state === CLOSED && reason.length > 0 ? `${state}${REASON_SEPARATOR}${reason}` : state,
        labels: (issue.labels ?? []).map(label => label.name),
        assignee: issue.assignees && issue.assignees.length > 0 ? issue.assignees[0].login : null,
        milestone: issue.milestone ? issue.milestone.title : null,
        updatedAt: issue.updatedAt,
    };
}

function classify(error: unknown): unknown {
    if (!(error instanceof CliError)) return error;
    if (error.refused) return new SyncPausedError(ghRefused(error.message));
    if (error.notFound) return new SyncPausedError(GH_MISSING);
    if (error.exitCode === AUTH_REQUIRED_EXIT) return new SyncPausedError(GH_LOGGED_OUT);
    if (GONE.test(error.stderr)) return new GoneError(error.message);
    return error;
}

export class GitHubAdapter implements VendorAdapter {
    constructor(private readonly repo: string, private readonly run: Runner = runCli) {}

    private async gh(args: CliArg[], input?: string): Promise<string> {
        try {
            return await this.run(GH, args, { input });
        } catch (error) {
            throw classify(error);
        }
    }

    private repoArgs(): CliArg[] {
        return [REPO_FLAG, freeText(this.repo)];
    }

    private async ensureLabel(label: string): Promise<void> {
        const key = `${this.repo.toLowerCase()} ${label}`;
        if (ensuredLabels.has(key)) return;
        await this.gh(['label', 'create', label, ...this.repoArgs(), '--force']);
        ensuredLabels.add(key);
    }

    private owns(url: string): boolean {
        return url.toLowerCase().indexOf(`github.com/${this.repo.toLowerCase()}/`) >= 0;
    }

    private async mustFetch(remoteId: string): Promise<RemoteItem> {
        const item = await this.fetch(remoteId);
        if (item === null) throw new GoneError(`Issue #${remoteId} is no longer in ${this.repo}`);
        return item;
    }

    async fetch(remoteId: string): Promise<RemoteItem | null> {
        let output: string;
        try {
            output = await this.gh(['issue', 'view', remoteId, ...this.repoArgs(), JSON_FLAG, ISSUE_FIELDS]);
        } catch (error) {
            if (error instanceof GoneError) return null;
            throw error;
        }
        const item = toItem(JSON.parse(output) as GhIssue);
        // A transferred issue answers from its new repository (how gh reports it is unverified).
        return item.url !== null && !this.owns(item.url) ? null : item;
    }

    async create(desired: DesiredState, body: string): Promise<RemoteItem> {
        const args: CliArg[] = ['issue', 'create', ...this.repoArgs(), '--title', freeText(desired.title)];
        if (!CLOSED_PHASES.has(desired.phase)) {
            const label = phaseLabel(desired.phase);
            await this.ensureLabel(label);
            args.push('--label', label);
        }
        args.push('--body-file', STDIN_FILE);
        const printed = await this.gh(args, body);
        const created = printed.match(CREATED_ISSUE);
        if (!created) throw new Error(`gh issue create printed no issue URL: ${printed}`);
        const item = await this.mustFetch(created[1]);
        return CLOSED_PHASES.has(desired.phase) ? this.syncState(linkStateOf(item), desired) : item;
    }

    async syncState(link: LinkState, desired: DesiredState): Promise<RemoteItem> {
        const reason = CLOSE_REASON[desired.phase];
        const wasClosed = (link.state ?? '').split(REASON_SEPARATOR)[0] === CLOSED;
        const edit: CliArg[] = ['issue', 'edit', link.remoteId, ...this.repoArgs(), '--title', freeText(desired.title)];
        if (reason === undefined) {
            const label = phaseLabel(desired.phase);
            await this.ensureLabel(label);
            for (const old of link.labels) {
                if (old.startsWith(PHASE_LABEL_PREFIX) && old !== label) edit.push('--remove-label', freeText(old));
            }
            if (link.labels.indexOf(label) < 0) edit.push('--add-label', label);
            if (wasClosed) await this.gh(['issue', 'reopen', link.remoteId, ...this.repoArgs()]);
        }
        await this.gh(edit);
        if (reason !== undefined && !wasClosed) {
            await this.gh(['issue', 'close', link.remoteId, ...this.repoArgs(), '--reason', freeText(reason)]);
        }
        return this.mustFetch(link.remoteId);
    }

    async comment(remoteId: string, text: string): Promise<RemoteItem> {
        await this.gh(['issue', 'comment', remoteId, ...this.repoArgs(), '--body-file', STDIN_FILE], text);
        return this.mustFetch(remoteId);
    }

    async closeDuplicate(remoteId: string, ofRemoteId: string): Promise<RemoteItem> {
        await this.gh(['issue', 'close', remoteId, ...this.repoArgs(), '--reason', DUPLICATE, '--duplicate-of', ofRemoteId]);
        return this.mustFetch(remoteId);
    }

    async listChangedSince(since: string, limit: number): Promise<RemoteItem[]> {
        const output = await this.gh([
            'issue', 'list', ...this.repoArgs(), '--state', 'all', '--limit', String(limit),
            '--search', freeText(`updated:>=${since} sort:updated-asc`), JSON_FLAG, ISSUE_FIELDS,
        ]);
        return (JSON.parse(output || '[]') as GhIssue[]).map(toItem);
    }

    async mergedAt(prUrl: string): Promise<string | null> {
        const prefix = `github.com/${this.repo.toLowerCase()}/pull/`;
        const at = prUrl.toLowerCase().indexOf(prefix);
        const number = at < 0 ? null : prUrl.slice(at + prefix.length).match(LEADING_NUMBER);
        if (number === null) return null;
        const pr = JSON.parse(await this.gh(['pr', 'view', number[0], ...this.repoArgs(), JSON_FLAG, PR_FIELDS])) as
            { state: string; mergedAt: string | null };
        return pr.state === MERGED ? pr.mergedAt : null;
    }

    async currentUser(): Promise<string> {
        return (await this.gh(['api', 'user', '--jq', '.login'])).trim();
    }

    phaseOf(state: string, labels: string[], localPhase: Phase): Phase {
        return githubPhaseOf(state, labels, localPhase);
    }

    titlesMatch(received: string, known: string): boolean {
        return received === known;
    }
}
