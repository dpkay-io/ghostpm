import { CliArg, CliError, RunOptions, Runner, freeText, runCli } from '../cli';
import { PhaseStateMap } from '../ledger/settings';
import { vendorStateToPhase } from '../ledger/legacy-import';
import { PHASES, Phase } from '../ledger/types';
import { SYNC_COMMAND } from './schedule';
import {
    DesiredState, GoneError, LinkState, PermanentError, RemoteItem, SyncPausedError, VENDOR_CALL_TIMEOUT_MS, VendorAdapter, linkStateOf,
    stripMarkers,
} from './vendor';

const nullableStrip = (text: string | null): string | null => (text === null ? null : stripMarkers(text));

const AZ = 'az';
const JSON_OUTPUT: CliArg[] = ['-o', 'json'];
const ORG_FLAG = '--org';
const FIELD = {
    id: 'System.Id', title: 'System.Title', state: 'System.State', assignedTo: 'System.AssignedTo',
    changed: 'System.ChangedDate', tags: 'System.Tags', iteration: 'System.IterationPath',
    description: 'System.Description', project: 'System.TeamProject', history: 'System.History',
    createdBy: 'System.CreatedBy', createdDate: 'System.CreatedDate', type: 'System.WorkItemType',
};
/** WIQL's macro for the signed-in user. */
const ME_MACRO = '@Me';
/** WIQL's macro for the current date; `@Today - n` is n days back. */
const TODAY_MACRO = '@Today';
/** How far back a retried create looks for the work item its earlier attempt made. */
const ADOPT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const QUERY_FIELDS = [FIELD.id, FIELD.title, FIELD.state, FIELD.assignedTo, FIELD.changed, FIELD.tags, FIELD.iteration, FIELD.description, FIELD.project];
/** A process sample reads no descriptions: months of them would be most of the answer. */
const SAMPLE_FIELDS = [FIELD.id, FIELD.state, FIELD.type];
/** WIQL compares dates, not times, unless the REST call asks for time precision, which az cannot. */
const WIQL_DATE_LENGTH = 10;
/** WIQL date literals are read in the user's time zone, so the bound starts a day before the UTC date of `since`; a pull de-dupes by baseline. */
const WIQL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const WIQL_QUOTE = /'/g;
const WIQL_ESCAPED_QUOTE = "''";
/** Verified with az 2.85 while logged out: "...you need to run the login command(az login if using AAD/MSA identity else az devops login ...". */
const LOGGED_OUT = /az login|az devops login/i;
const GONE = /TF401232|does not exist/i;
/** Expired or missing credentials, or a sign-in only a person can complete. */
const NOT_AUTHENTICATED = /HTTP 401|HTTP 403|TF400813|AADSTS|Interactive authentication is needed/i;
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
const TIMED: RunOptions = { timeoutMs: VENDOR_CALL_TIMEOUT_MS };

const wiqlText = (text: string): string => `'${text.replace(WIQL_QUOTE, WIQL_ESCAPED_QUOTE)}'`;
/** A WIQL date bound at or before `ms`, whatever time zone WIQL reads it in. */
const wiqlDateFrom = (ms: number): string => wiqlText(new Date(ms - WIQL_LOOKBACK_MS).toISOString().slice(0, WIQL_DATE_LENGTH));

/**
 * How an az failure is worded: the work item type the call named (none for a process sample, which filters by no
 * type) and the command a person runs once it is fixed.
 */
interface Advice {
    workItemType: string | null;
    retry: string;
}

const SYNC_RETRY = `ghostpm ${SYNC_COMMAND}`;
const azMissing = (retry: string): string => `Azure CLI (az) was not found. Install it, or set GHOSTPM_AZ to its path, then run \`${retry}\`.`;
const azLoggedOut = (retry: string): string => `Azure CLI is not logged in to Azure DevOps. Run \`az login\` (or \`az devops login\`), then \`${retry}\`.`;
export const AZ_MISSING = azMissing(SYNC_RETRY);
export const AZ_LOGGED_OUT = azLoggedOut(SYNC_RETRY);
const azNotAuthenticated = (detail: string, retry: string): string =>
    `Azure DevOps refused the Azure CLI's credentials (${detail}). Run \`az login\` (or \`az devops login\`), then \`${retry}\`.`;
const azNotFound = (project: string, advice: Advice): string => (advice.workItemType === null
    ? `Azure DevOps does not know project "${project}". Check the git remote, then run \`${advice.retry}\`.`
    : `Azure DevOps does not know project "${project}" or work item type "${advice.workItemType}". Check the remote and run: `
        + `ghostpm config set ado_work_item_type <Type> --workspace <repo folder>, then \`${advice.retry}\`.`);
const azRefused = (detail: string, retry: string): string => `GhostPM will not run az this way (${detail}). Fix that, then run \`${retry}\`.`;
const noState = (phase: Phase): string =>
    `No Azure DevOps state is set for phase ${phase}. Run: ghostpm config set phase_state_map ${phase}=<State> --workspace <repo folder>`;

interface AzWorkItem {
    id: number;
    fields?: { [name: string]: unknown };
}

/** What a project's recent work items say about its process template. */
export interface AzureProcess {
    /** Distinct (ignoring case), most recently changed first. */
    states: string[];
    /** Most frequent first. */
    workItemTypes: string[];
}

/** `itemLevel` calls name one work item or PR: "does not exist" there means it is gone. Anywhere else it means the project or type is wrong. */
function classify(error: unknown, itemLevel: boolean, project: string, advice: Advice): unknown {
    if (!(error instanceof CliError)) return error;
    if (error.refused) return new SyncPausedError(azRefused(error.message, advice.retry));
    if (error.notFound) return new SyncPausedError(azMissing(advice.retry));
    if (LOGGED_OUT.test(error.stderr)) return new SyncPausedError(azLoggedOut(advice.retry));
    if (NOT_AUTHENTICATED.test(error.stderr)) return new SyncPausedError(azNotAuthenticated(error.message, advice.retry));
    if (GONE.test(error.stderr)) return itemLevel ? new GoneError(error.message) : new SyncPausedError(azNotFound(project, advice));
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
    /** `az boards query` answers every match: WIQL has no row limit and the command no --top (az 2.85 help). */
    readonly pages = false;

    constructor(
        private readonly org: string,
        private readonly project: string,
        private readonly workItemType: string,
        private readonly stateMap: PhaseStateMap,
        private readonly run: Runner = runCli,
    ) {}

    /** How the sync calls word an az failure. */
    private readonly advice: Advice = { workItemType: this.workItemType, retry: SYNC_RETRY };

    private async azText(args: CliArg[], itemLevel = false, advice: Advice = this.advice): Promise<string> {
        try {
            return await this.run(AZ, [...args, ...JSON_OUTPUT], TIMED);
        } catch (error) {
            throw classify(error, itemLevel, this.project, advice);
        }
    }

    private async az<T>(args: CliArg[], itemLevel = false, advice: Advice = this.advice): Promise<T> {
        return JSON.parse(await this.azText(args, itemLevel, advice)) as T;
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
            body: nullableStrip(text(FIELD.description)),
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
        return this.toItem(await this.az<AzWorkItem>(this.updateArgs(remoteId, fields), true));
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
        const output = await this.azText(this.updateArgs(remoteId, ['--discussion', freeText(text)]), true);
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

    /** This project's work items matching every condition. */
    private async query(
        conditions: string[], orderBy: string, fields: readonly string[] = QUERY_FIELDS, advice: Advice = this.advice,
    ): Promise<AzWorkItem[]> {
        const wiql = `SELECT ${fields.map(field => `[${field}]`).join(', ')} FROM workitems`
            + ` WHERE ${[`[${FIELD.project}] = ${wiqlText(this.project)}`, ...conditions].join(' AND ')}`
            + ` ORDER BY ${orderBy}`;
        const output = await this.azText([
            'boards', 'query', ...this.orgArgs(), '--project', freeText(this.project), '--wiql', freeText(wiql),
        ], false, advice);
        // Verified with az 2.85: a query with no rows prints nothing at all, not `[]`.
        if (output.trim() === '') return [];
        const result = JSON.parse(output) as AzWorkItem[] | { items?: AzWorkItem[] };
        return Array.isArray(result) ? result : result.items ?? [];
    }

    private show(remoteId: string): Promise<AzWorkItem> {
        return this.az<AzWorkItem>(['boards', 'work-item', 'show', ...this.orgArgs(), '--id', remoteId], true);
    }

    /**
     * The states and work item types of the items changed in the last `days` days, for `ghostpm init`. Throws when az
     * fails, worded to run `retry` once that is fixed.
     */
    async sampleProcess(days: number, retry: string): Promise<AzureProcess> {
        const items = await this.query(
            [`[${FIELD.changed}] >= ${TODAY_MACRO} - ${days}`], `[${FIELD.changed}] DESC`, SAMPLE_FIELDS, { workItemType: null, retry },
        );
        const states: string[] = [];
        const typeCounts = new Map<string, number>();
        for (const item of items) {
            const state = item.fields?.[FIELD.state];
            if (typeof state === 'string' && !states.some(known => known.toLowerCase() === state.toLowerCase())) states.push(state);
            const type = item.fields?.[FIELD.type];
            if (typeof type === 'string') typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
        }
        // A stable sort: equally frequent types keep the order they were first seen in.
        const workItemTypes = Array.from(typeCounts.keys()).sort((a, b) => typeCounts.get(b)! - typeCounts.get(a)!);
        return { states, workItemTypes };
    }

    /** Every match, whatever `_limit` says (`pages` is false). */
    async listChangedSince(since: string, _limit: number): Promise<RemoteItem[]> {
        const items = await this.query([`[${FIELD.changed}] >= ${wiqlDateFrom(Date.parse(since))}`], `[${FIELD.changed}] ASC`);
        return items.map(item => this.toItem(item));
    }

    /** Narrowed by exact title, creator and creation date, then confirmed by the marker in the description. */
    async findCreated(marker: string, title: string): Promise<RemoteItem | null> {
        const items = await this.query([
            `[${FIELD.title}] = ${wiqlText(title)}`,
            `[${FIELD.createdBy}] = ${ME_MACRO}`,
            `[${FIELD.createdDate}] >= ${wiqlDateFrom(Date.now() - ADOPT_LOOKBACK_MS)}`,
        ], `[${FIELD.createdDate}] DESC`);
        const found = items.find(item => String(item.fields?.[FIELD.description] ?? '').indexOf(marker) >= 0);
        return found === undefined ? null : this.toItem(found);
    }

    /** The latest System.History entry: a comment posted since hides an earlier one (a rare duplicate, never a loss). */
    async hasComment(remoteId: string, marker: string): Promise<boolean> {
        return String((await this.show(remoteId)).fields?.[FIELD.history] ?? '').indexOf(marker) >= 0;
    }

    async fetch(remoteId: string): Promise<RemoteItem | null> {
        let raw: AzWorkItem;
        try {
            raw = await this.show(remoteId);
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
        const pr = await this.az<{ status?: string; closedDate?: string }>(['repos', 'pr', 'show', ...this.orgArgs(), '--id', id[1]], true);
        return pr.status === PR_COMPLETED && pr.closedDate ? pr.closedDate : null;
    }

    /**
     * `az account show` is the Azure login, which a PAT-only user (`az devops login`) does not have although every
     * boards call works. So any failure means "unknown", never a pause: a real auth failure surfaces on the boards calls.
     */
    async currentUser(): Promise<string | null> {
        try {
            return (await this.run(AZ, ['account', 'show', '--query', 'user.name', '-o', 'tsv'], TIMED)).trim() || null;
        } catch {
            return null;
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
