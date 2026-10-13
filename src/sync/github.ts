import { CliArg, CliError, Runner, freeText, runCli } from '../cli';
import { CLOSED_PHASES, Phase, isPhase } from '../ledger/types';
import { REOPEN_PHASE } from '../ledger/work';
import {
    DesiredState, GoneError, LinkState, RemoteItem, SyncPausedError, VENDOR_CALL_TIMEOUT_MS, VendorAdapter, linkStateOf, stripMarkers,
} from './vendor';

const GH = 'gh';
export const PHASE_LABEL_PREFIX = 'ghostpm:';
const ISSUE_FIELDS = 'number,title,body,state,stateReason,labels,assignees,milestone,updatedAt,url';
const PR_FIELDS = 'state,mergedAt';
const REPO_FIELDS = 'nameWithOwner';
const COMMENT_FIELDS = 'comments';
/** How many of the newest issues a retried create looks through for the one its earlier attempt made. */
const ADOPT_SCAN_LIMIT = 30;
const JSON_FLAG = '--json';
const REPO_FLAG = '--repo';
const STDIN_FILE = '-';
const CLOSED = 'closed';
const OPEN = 'open';
const REASON_SEPARATOR = ':';
const NOT_PLANNED = 'not_planned';
const DUPLICATE = 'duplicate';
const MERGED = 'MERGED';
/** `gh help exit-codes`: "If a command requires authentication, the exit code will be 4". */
const AUTH_REQUIRED_EXIT = 4;
/** An issue, or a pull request (`gh pr view` of one deleted or never there: ruling F5), that is not there. */
const GONE = /Could not resolve to an issue|Could not resolve to a PullRequest|HTTP 404|HTTP 410/i;
const REPO_UNRESOLVED = /Could not resolve to a Repository/i;
const REPO_NOT_FOUND = /HTTP 404|HTTP 410/i;
const NOT_AUTHENTICATED = /HTTP 401|Bad credentials|gh auth login/i;
const MISSING_SCOPE = /HTTP 403[\s\S]*scope|scope[\s\S]*HTTP 403/i;
const REFRESH_SCOPE = /gh auth refresh -s (\S+)/;
const REFRESH_COMMAND = 'gh auth refresh';
const SCOPE_FLAG = '-s';
const CREATED_ISSUE = /\/issues\/(\d+)\s*$/;
const PULL_URL = /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i;
const CLOSE_REASON: Partial<Record<Phase, string>> = { done: 'completed', dropped: 'not planned' };

export const GH_MISSING = 'GitHub CLI (gh) was not found. Install it, or set GHOSTPM_GH to its path, then run `ghostpm sync`.';
export const GH_LOGGED_OUT = 'GitHub CLI is not logged in. Run `gh auth login`, then `ghostpm sync`.';
export const ghRepoMissing = (repo: string): string => `GitHub repo ${repo} not found or no access — check the remote, then run \`ghostpm sync\`.`;
export const ghScopeMissing = (fix: string): string => `The GitHub token lacks a required scope. Run \`${fix}\`, then \`ghostpm sync\`.`;
const ghRefused = (detail: string): string => `GhostPM will not run gh this way (${detail}). Fix that, then run \`ghostpm sync\`.`;

const repoKey = (repo: string): string => repo.toLowerCase();

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
/** Canonical owner/name per repo (lower-cased), resolved once per process: a renamed repo's issues answer under the new name. */
const canonicalNames = new Map<string, string>();

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
        body: issue.body === undefined || issue.body === null ? null : stripMarkers(issue.body),
        state: state === CLOSED && reason.length > 0 ? `${state}${REASON_SEPARATOR}${reason}` : state,
        labels: (issue.labels ?? []).map(label => label.name),
        assignee: issue.assignees && issue.assignees.length > 0 ? issue.assignees[0].login : null,
        milestone: issue.milestone ? issue.milestone.title : null,
        updatedAt: issue.updatedAt,
    };
}

/** `itemLevel` calls name one issue or PR: a 404 there means that item is gone. Anywhere else it means the repo is wrong. */
function classify(error: unknown, repo: string, itemLevel: boolean): unknown {
    if (!(error instanceof CliError)) return error;
    if (error.refused) return new SyncPausedError(ghRefused(error.message));
    if (error.notFound) return new SyncPausedError(GH_MISSING);
    if (error.exitCode === AUTH_REQUIRED_EXIT || NOT_AUTHENTICATED.test(error.stderr)) return new SyncPausedError(GH_LOGGED_OUT);
    if (MISSING_SCOPE.test(error.stderr)) {
        const fix = error.stderr.match(REFRESH_SCOPE);
        return new SyncPausedError(ghScopeMissing(fix ? `${REFRESH_COMMAND} ${SCOPE_FLAG} ${fix[1]}` : REFRESH_COMMAND));
    }
    if (REPO_UNRESOLVED.test(error.stderr) || (!itemLevel && REPO_NOT_FOUND.test(error.stderr))) return new SyncPausedError(ghRepoMissing(repo));
    if (itemLevel && GONE.test(error.stderr)) return new GoneError(error.message);
    return error;
}

export class GitHubAdapter implements VendorAdapter {
    /** `gh issue list --limit`. */
    readonly pages = true;

    constructor(private readonly repo: string, private readonly run: Runner = runCli) {}

    private async gh(args: CliArg[], input?: string, itemLevel = false): Promise<string> {
        try {
            return await this.run(GH, args, { input, timeoutMs: VENDOR_CALL_TIMEOUT_MS });
        } catch (error) {
            throw classify(error, this.repo, itemLevel);
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

    private async canonicalName(): Promise<string> {
        const key = repoKey(this.repo);
        let name = canonicalNames.get(key);
        if (name === undefined) {
            const view = JSON.parse(await this.gh(['repo', 'view', this.repo, JSON_FLAG, REPO_FIELDS])) as { nameWithOwner: string };
            name = repoKey(view.nameWithOwner);
            canonicalNames.set(key, name);
        }
        return name;
    }

    /** Whether `url` lies under this repo, or under the name it was renamed or transferred to. */
    private async owns(url: string): Promise<boolean> {
        const lower = url.toLowerCase();
        const under = (name: string): boolean => lower.indexOf(`github.com/${name}/`) >= 0;
        return under(repoKey(this.repo)) || under(await this.canonicalName());
    }

    private async mustFetch(remoteId: string): Promise<RemoteItem> {
        const item = await this.fetch(remoteId);
        if (item === null) throw new GoneError(`Issue #${remoteId} is no longer in ${this.repo}`);
        return item;
    }

    async fetch(remoteId: string): Promise<RemoteItem | null> {
        let output: string;
        try {
            output = await this.gh(['issue', 'view', remoteId, ...this.repoArgs(), JSON_FLAG, ISSUE_FIELDS], undefined, true);
        } catch (error) {
            if (error instanceof GoneError) return null;
            throw error;
        }
        const item = toItem(JSON.parse(output) as GhIssue);
        // A transferred issue answers from its new repository (how gh reports it is unverified).
        return item.url !== null && !(await this.owns(item.url)) ? null : item;
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
        // The issue exists now: whatever fails next must not lose its number, or a retry files a duplicate.
        try {
            const item = await this.mustFetch(created[1]);
            return CLOSED_PHASES.has(desired.phase) ? await this.syncState(linkStateOf(item), desired) : item;
        } catch {
            return {
                remoteId: created[1], url: printed.trim(), title: desired.title, body: stripMarkers(body), state: OPEN,
                labels: CLOSED_PHASES.has(desired.phase) ? [] : [phaseLabel(desired.phase)],
                assignee: null, milestone: null, updatedAt: new Date().toISOString(),
            };
        }
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
        }
        // `gh issue close` on a closed issue changes nothing, so a done <-> dropped move reopens first. A close that already
        // means the phase stays: a duplicate is dropped, and closing it again as not planned would lose that (ruling F12).
        const needsClose = reason !== undefined && (!wasClosed || githubPhaseOf(link.state ?? '', link.labels, desired.phase) !== desired.phase);
        if (wasClosed && (reason === undefined || needsClose)) await this.gh(['issue', 'reopen', link.remoteId, ...this.repoArgs()], undefined, true);
        await this.gh(edit, undefined, true);
        if (needsClose) {
            await this.gh(['issue', 'close', link.remoteId, ...this.repoArgs(), '--reason', freeText(reason)], undefined, true);
        }
        return this.mustFetch(link.remoteId);
    }

    async comment(remoteId: string, text: string): Promise<RemoteItem | null> {
        await this.gh(['issue', 'comment', remoteId, ...this.repoArgs(), '--body-file', STDIN_FILE], text, true);
        // Posted: a failed re-fetch must not read as a failed comment, or a retry posts it twice.
        return this.mustFetch(remoteId).catch(() => null);
    }
    async closeDuplicate(remoteId: string, ofRemoteId: string): Promise<RemoteItem> {
        await this.gh(['issue', 'close', remoteId, ...this.repoArgs(), '--reason', DUPLICATE, '--duplicate-of', ofRemoteId], undefined, true);
        return this.mustFetch(remoteId);
    }

    /** A plain listing, newest first (no search: its index lags behind a create that just happened). */
    async findCreated(marker: string, _title: string): Promise<RemoteItem | null> {
        const output = await this.gh(['issue', 'list', ...this.repoArgs(), '--state', 'all', '--limit', String(ADOPT_SCAN_LIMIT), JSON_FLAG, ISSUE_FIELDS]);
        const found = (JSON.parse(output || '[]') as GhIssue[]).find(issue => (issue.body ?? '').indexOf(marker) >= 0);
        return found === undefined ? null : toItem(found);
    }

    async hasComment(remoteId: string, marker: string): Promise<boolean> {
        const output = await this.gh(['issue', 'view', remoteId, ...this.repoArgs(), JSON_FLAG, COMMENT_FIELDS], undefined, true);
        return ((JSON.parse(output) as { comments?: { body: string }[] }).comments ?? []).some(comment => comment.body.indexOf(marker) >= 0);
    }

    async listChangedSince(since: string, limit: number): Promise<RemoteItem[]> {
        const output = await this.gh([
            'issue', 'list', ...this.repoArgs(), '--state', 'all', '--limit', String(limit),
            '--search', freeText(`updated:>=${since} sort:updated-asc`), JSON_FLAG, ISSUE_FIELDS,
        ]);
        return (JSON.parse(output || '[]') as GhIssue[]).map(toItem);
    }

    async mergedAt(prUrl: string): Promise<string | null> {
        const found = prUrl.match(PULL_URL);
        if (found === null || !(await this.owns(prUrl))) return null;
        const pr = JSON.parse(await this.gh(['pr', 'view', found[1], ...this.repoArgs(), JSON_FLAG, PR_FIELDS], undefined, true)) as
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
