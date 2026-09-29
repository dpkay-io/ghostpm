import { CliArg, CliError, Runner, freeText, runCli } from '../cli';
import { PhaseStateMap } from '../ledger/settings';
import { vendorStateToPhase } from '../ledger/legacy-import';
import { PHASES, Phase } from '../ledger/types';
import { DesiredState, GoneError, LinkState, PermanentError, RemoteItem, SyncPausedError, VendorAdapter, linkStateOf } from './vendor';

const AZ = 'az';
const JSON_OUTPUT: CliArg[] = ['-o', 'json'];
const ORG_FLAG = '--org';
const FIELD = {
    id: 'System.Id', title: 'System.Title', state: 'System.State', assignedTo: 'System.AssignedTo',
    changed: 'System.ChangedDate', tags: 'System.Tags', iteration: 'System.IterationPath',
    description: 'System.Description', project: 'System.TeamProject',
};
const QUERY_FIELDS = [FIELD.id, FIELD.title, FIELD.state, FIELD.assignedTo, FIELD.changed, FIELD.tags, FIELD.iteration, FIELD.description, FIELD.project];
/** WIQL compares dates, not times, unless the REST call asks for time precision, which az cannot. */
const WIQL_DATE_LENGTH = 10;
const WIQL_QUOTE = /'/g;
const WIQL_ESCAPED_QUOTE = "''";
/** Verified with az 2.85 while logged out: "...you need to run the login command(az login if using AAD/MSA identity else az devops login ...". */
const LOGGED_OUT = /az login|az devops login/i;
const GONE = /TF401232|does not exist/i;
const PULL_REQUEST_ID = /\/pullrequest\/(\d+)/i;
const PR_COMPLETED = 'completed';
const TAG_SEPARATOR = /;\s*/;
const EDIT_PATH = '_workitems/edit';
const TRAILING_SLASHES = /\/+$/;
const URL_SEPARATOR = '/';
const ASCII_LIMIT = 0x80;
/** What az's first pass strips from the end of a one-level argument file (`rstrip(os.linesep)`), and the batch fallback's ANSI decode leaves for a character it could not encode. */
const TRAILING_LINE_BREAKS = /[\r\n]+$/;
const REPLACEMENT_CHAR = '�';

export const AZ_MISSING = 'Azure CLI (az) was not found. Install it, or set GHOSTPM_AZ to its path, then run `ghostpm sync`.';
export const AZ_LOGGED_OUT = 'Azure CLI is not logged in to Azure DevOps. Run `az login` (or `az devops login`), then `ghostpm sync`.';
const azRefused = (detail: string): string => `GhostPM will not run az this way (${detail}). Fix that, then run \`ghostpm sync\`.`;
const noState = (phase: Phase): string =>
    `No Azure DevOps state is set for phase ${phase}. Run: ghostpm config set phase_state_map ${phase}=<State> --workspace <repo folder>`;

interface AzWorkItem {
    id: number;
    fields?: { [name: string]: unknown };
}

function classify(error: unknown): unknown {
    if (!(error instanceof CliError)) return error;
    if (error.refused) return new SyncPausedError(azRefused(error.message));
    if (error.notFound) return new SyncPausedError(AZ_MISSING);
    if (LOGGED_OUT.test(error.stderr)) return new SyncPausedError(AZ_LOGGED_OUT);
    if (GONE.test(error.stderr)) return new GoneError(error.message);
    return error;
}

/**
 * az on Windows may write stdout in the ANSI code page (batch fallback; verified az 2.85, cp1252): a character it
 * cannot encode is dropped, or comes back as U+FFFD after the UTF-8 decode. And az strips trailing line breaks
 * from the free text it reads. None of that is an edit: `received` is `known` minus some non-ASCII characters
 * (each possibly replaced by one U+FFFD) and minus trailing CR/LF.
 */
export function isLossyCopy(received: string, known: string): boolean {
    const got = Array.from(received);
    let at = 0;
    for (const char of Array.from(known.replace(TRAILING_LINE_BREAKS, ''))) {
        if (at < got.length && got[at] === char) {
            at++;
        } else if (char.charCodeAt(0) < ASCII_LIMIT) {
            return false;
        } else if (at < got.length && got[at] === REPLACEMENT_CHAR) {
            at++;
        }
    }
    return at === got.length;
}

export class AzureAdapter implements VendorAdapter {
    constructor(
        private readonly org: string,
        private readonly project: string,
        private readonly workItemType: string,
        private readonly stateMap: PhaseStateMap,
        private readonly run: Runner = runCli,
    ) {}

    private async azText(args: CliArg[]): Promise<string> {
        try {
            return await this.run(AZ, [...args, ...JSON_OUTPUT]);
        } catch (error) {
            throw classify(error);
        }
    }

    private async az<T>(args: CliArg[]): Promise<T> {
        return JSON.parse(await this.azText(args)) as T;
    }

    private orgArgs(): CliArg[] {
        return [ORG_FLAG, freeText(this.org)];
    }

    /** The organisation URL with exactly one trailing slash: `acme/` never matches `acmecorp/`. */
    private orgPrefix(): string {
        return `${this.org.replace(TRAILING_SLASHES, '')}${URL_SEPARATOR}`;
    }

    private toItem(raw: AzWorkItem): RemoteItem {
        const fields = raw.fields ?? {};
        const text = (name: string): string | null => (typeof fields[name] === 'string' ? fields[name] as string : null);
        const assigned = fields[FIELD.assignedTo];
        return {
            remoteId: String(raw.id),
            url: `${this.orgPrefix()}${encodeURIComponent(this.project)}/${EDIT_PATH}/${raw.id}`,
            title: text(FIELD.title) ?? '',
            body: text(FIELD.description),
            state: text(FIELD.state) ?? '',
            labels: (text(FIELD.tags) ?? '').split(TAG_SEPARATOR).filter(tag => tag.length > 0),
            assignee: typeof assigned === 'string'
                ? assigned
                : typeof assigned === 'object' && assigned !== null ? (assigned as { uniqueName?: string }).uniqueName ?? null : null,
            milestone: text(FIELD.iteration),
            updatedAt: text(FIELD.changed) ?? '',
        };
    }

    private stateFor(phase: Phase): string {
        const state = this.stateMap[phase];
        if (state === undefined) throw new PermanentError(noState(phase));
        return state;
    }

    private updateArgs(remoteId: string, fields: CliArg[]): CliArg[] {
        return ['boards', 'work-item', 'update', ...this.orgArgs(), '--id', remoteId, ...fields];
    }

    private async update(remoteId: string, fields: CliArg[]): Promise<RemoteItem> {
        return this.toItem(await this.az<AzWorkItem>(this.updateArgs(remoteId, fields)));
    }

    async create(desired: DesiredState, body: string): Promise<RemoteItem> {
        const created = this.toItem(await this.az<AzWorkItem>([
            'boards', 'work-item', 'create', ...this.orgArgs(), '--project', freeText(this.project),
            '--type', freeText(this.workItemType), '--title', freeText(desired.title), '--description', freeText(body),
        ]));
        // `create` has no --state (az 2.85 help): a later phase takes one more update.
        const state = this.stateMap[desired.phase];
        if (state === undefined || state.toLowerCase() === created.state.toLowerCase()) return created;
        // The work item exists now: a failed move must not lose its id, or a retry files a duplicate.
        // The link is stored as created; the next push moves it to the desired state.
        return this.syncState(linkStateOf(created), desired).catch(() => created);
    }

    async syncState(link: LinkState, desired: DesiredState): Promise<RemoteItem> {
        const state = this.stateFor(desired.phase);
        return this.update(link.remoteId, ['--title', freeText(desired.title), '--state', freeText(state)]);
    }

    async comment(remoteId: string, text: string): Promise<RemoteItem | null> {
        const output = await this.azText(this.updateArgs(remoteId, ['--discussion', freeText(text)]));
        // Posted: an unreadable answer must not read as a failed comment, or a retry posts it twice.
        try {
            return this.toItem(JSON.parse(output) as AzWorkItem);
        } catch {
            return null;
        }
    }

    /** No template-independent "duplicate" in Azure Boards: the dropped state plus a note. */
    async closeDuplicate(remoteId: string, ofRemoteId: string): Promise<RemoteItem> {
        const state = this.stateFor('dropped');
        return this.update(remoteId, ['--state', freeText(state), '--discussion', freeText(`Duplicate of #${ofRemoteId}`)]);
    }

    /** Every match, whatever `_limit` says: WIQL has no row limit and `az boards query` has no --top (az 2.85 help). */
    async listChangedSince(since: string, _limit: number): Promise<RemoteItem[]> {
        const project = this.project.replace(WIQL_QUOTE, WIQL_ESCAPED_QUOTE);
        const wiql = `SELECT ${QUERY_FIELDS.map(field => `[${field}]`).join(', ')} FROM workitems`
            + ` WHERE [${FIELD.project}] = '${project}' AND [${FIELD.changed}] >= '${since.slice(0, WIQL_DATE_LENGTH)}'`
            + ` ORDER BY [${FIELD.changed}] ASC`;
        const result = await this.az<AzWorkItem[] | { items?: AzWorkItem[] }>([
            'boards', 'query', ...this.orgArgs(), '--project', freeText(this.project), '--wiql', freeText(wiql),
        ]);
        return (Array.isArray(result) ? result : result.items ?? []).map(item => this.toItem(item));
    }

    async fetch(remoteId: string): Promise<RemoteItem | null> {
        let raw: AzWorkItem;
        try {
            raw = await this.az<AzWorkItem>(['boards', 'work-item', 'show', ...this.orgArgs(), '--id', remoteId]);
        } catch (error) {
            if (error instanceof GoneError) return null;
            throw error;
        }
        const project = raw.fields?.[FIELD.project];
        // Moved to another project: out of this workspace's reach.
        if (typeof project === 'string' && project.toLowerCase() !== this.project.toLowerCase()) return null;
        return this.toItem(raw);
    }

    async mergedAt(prUrl: string): Promise<string | null> {
        if (!prUrl.toLowerCase().startsWith(this.orgPrefix().toLowerCase())) return null;
        const id = prUrl.match(PULL_REQUEST_ID);
        if (!id) return null;
        const pr = await this.az<{ status?: string; closedDate?: string }>(['repos', 'pr', 'show', ...this.orgArgs(), '--id', id[1]]);
        return pr.status === PR_COMPLETED && pr.closedDate ? pr.closedDate : null;
    }

    async currentUser(): Promise<string> {
        try {
            return (await this.run(AZ, ['account', 'show', '--query', 'user.name', '-o', 'tsv'])).trim();
        } catch (error) {
            throw classify(error);
        }
    }

    phaseOf(state: string, _labels: string[], localPhase: Phase): Phase {
        const same = (mapped: string | undefined): boolean => mapped !== undefined && mapped.toLowerCase() === state.toLowerCase();
        if (same(this.stateMap[localPhase])) return localPhase;
        const mapped = PHASES.filter(phase => same(this.stateMap[phase]));
        return mapped.length > 0 ? mapped[0] : vendorStateToPhase(state);
    }

    titlesMatch(received: string, known: string): boolean {
        return received === known || isLossyCopy(received, known);
    }
}
