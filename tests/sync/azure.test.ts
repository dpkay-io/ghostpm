import { CliArg, CliError, RunOptions, Runner, freeText } from '../../src/cli';
import { AzureAdapter, AzureTypeState, isLossyCopy, phaseStateMapFromCategories, AZ_LOGGED_OUT, AZ_MISSING } from '../../src/sync/azure';
import { GoneError, PermanentError, SyncPausedError, VENDOR_CALL_TIMEOUT_MS } from '../../src/sync/vendor';
import { PhaseStateMap } from '../../src/ledger/settings';
import { Phase } from '../../src/ledger/types';

interface Call { command: string; args: CliArg[]; input?: string }
type Reply = string | Error;

const ORG = 'https://dev.azure.com/acme';
const PROJECT = "Widgets 'Next'";
const TYPE = 'Product Backlog Item';
const STATES: PhaseStateMap = { brainstorming: 'New', planned: 'New', in_progress: 'Committed', in_review: 'Committed', done: 'Done', dropped: 'Removed' };
/** Verified with az 2.85 on this machine while logged out of Azure DevOps. */
const LOGGED_OUT_STDERR = 'ERROR: Before you can run Azure DevOps commands, you need to run the login command(az login if using AAD/MSA identity else az devops login if using PAT token) to setup credentials.';

/** Answers az by the first two words of each call (or three, when a reply is keyed by the verb too), and records every call. */
function fakeAz(replies: { [words: string]: Reply } = {}): { run: Runner; calls: Call[] } {
    const calls: Call[] = [];
    const run: Runner = async (command: string, args: CliArg[], options?: RunOptions) => {
        calls.push({ command, args, input: options?.input });
        const words = args.slice(0, 2).map(arg => (typeof arg === 'string' ? arg : arg.freeText)).join(' ');
        const verb = typeof args[2] === 'string' ? args[2] : '';
        const reply = replies[`${words} ${verb}`.trim()] ?? replies[words] ?? '';
        if (reply instanceof Error) throw reply;
        return reply;
    };
    return { run, calls };
}

const workItem = (fields: { [name: string]: unknown } = {}, id = 42): string => JSON.stringify({
    id,
    fields: {
        'System.Title': 'Login fix', 'System.State': 'New', 'System.ChangedDate': '2026-09-20T10:00:00.123Z',
        'System.AssignedTo': { displayName: 'Octo Cat', uniqueName: 'octo@acme.test' },
        'System.Tags': 'backend; urgent', 'System.IterationPath': 'Widgets\\Sprint 3',
        'System.Description': 'Tracked by GhostPM as T1.', 'System.TeamProject': PROJECT,
        ...fields,
    },
});

const adapter = (run: Runner, states: PhaseStateMap = STATES): AzureAdapter => new AzureAdapter(ORG, PROJECT, TYPE, states, run);
const azFailure = (stderr: string): CliError => new CliError('az failed (exit 1)', 1, stderr, false, false);

describe('AzureAdapter', () => {
    it('creates a work item of the configured type with --org, --project and every value as free text', async () => {
        const az = fakeAz({ 'boards work-item create': workItem() });
        const item = await adapter(az.run).create({ title: 'Fix a&b %PATH%', phase: 'planned' }, 'Tracked by GhostPM as T1.');
        expect(az.calls[0].args).toEqual([
            'boards', 'work-item', 'create', '--org', freeText(ORG), '--project', freeText(PROJECT),
            '--type', freeText(TYPE), '--title', freeText('Fix a&b %PATH%'), '--description', freeText('Tracked by GhostPM as T1.'),
            '-o', 'json',
        ]);
        expect(az.calls).toHaveLength(1);
        expect(item).toEqual({
            remoteId: '42', url: `${ORG}/Widgets%20'Next'/_workitems/edit/42`, title: 'Login fix',
            body: 'Tracked by GhostPM as T1.', state: 'New', labels: ['backend', 'urgent'], assignee: 'octo@acme.test',
            milestone: 'Widgets\\Sprint 3', updatedAt: '2026-09-20T10:00:00.123Z',
        });
    });

    it('moves a new item on to the mapped state when it starts past the first one', async () => {
        const az = fakeAz({ 'boards work-item create': workItem(), 'boards work-item update': workItem({ 'System.State': 'Committed' }) });
        const item = await adapter(az.run).create({ title: 'Login fix', phase: 'in_progress' }, 'body');
        expect(az.calls.map(call => call.args[2])).toEqual(['create', 'update']);
        expect(item.state).toBe('Committed');
    });

    it('keeps the id of a created work item whose move to the mapped state failed, instead of throwing', async () => {
        const az = fakeAz({ 'boards work-item create': workItem(), 'boards work-item update': azFailure('ERROR: TF401320: rule error') });
        const item = await adapter(az.run).create({ title: 'Login fix', phase: 'in_progress' }, 'body');
        expect(item.remoteId).toBe('42');
        expect(item.state).toBe('New');
        expect(az.calls.map(call => call.args[2])).toEqual(['create', 'update']);
    });

    it('sets title and mapped state in one update, naming the org', async () => {
        const az = fakeAz({ 'boards work-item update': workItem({ 'System.State': 'Done' }) });
        await adapter(az.run).syncState({ remoteId: '42', state: 'Committed', labels: [] }, { title: 'Renamed', phase: 'done' });
        expect(az.calls[0].args).toEqual([
            'boards', 'work-item', 'update', '--org', freeText(ORG), '--id', '42',
            '--title', freeText('Renamed'), '--state', freeText('Done'), '-o', 'json',
        ]);
    });

    it('fails a phase with no mapped state for good, naming the commands that fix it', async () => {
        const az = fakeAz();
        const error = await adapter(az.run, { planned: 'New' }).syncState({ remoteId: '42', state: 'New', labels: [] }, { title: 'x', phase: 'in_review' })
            .catch((e: unknown) => e) as PermanentError;
        expect(error).toBeInstanceOf(PermanentError);
        expect(error.message).toContain('ghostpm config set phase_state_map in_review=');
        // Init fills the phases a saved map leaves out from the project's own states.
        expect(error.message).toContain('`ghostpm init`');
        // A sync run by hand retries the failed push (seen live).
        expect(error.message).toContain('then `ghostpm sync`');
        expect(az.calls).toEqual([]);
    });

    it('comments through --discussion and answers the item as it is afterwards', async () => {
        const az = fakeAz({ 'boards work-item update': workItem() });
        const item = await adapter(az.run).comment('42', 'Phase: planned → in_progress');
        expect(az.calls[0].args).toEqual([
            'boards', 'work-item', 'update', '--org', freeText(ORG), '--id', '42', '--discussion', freeText('Phase: planned → in_progress'), '-o', 'json',
        ]);
        expect(item?.remoteId).toBe('42');
    });

    it('answers null, and does not throw, when a comment was posted but az answered nothing readable', async () => {
        const az = fakeAz({ 'boards work-item update': 'WARNING: not json' });
        expect(await adapter(az.run).comment('42', 'note')).toBeNull();
        expect(az.calls).toHaveLength(1);
    });

    it('still fails a comment az refused to post', async () => {
        const az = fakeAz({ 'boards work-item update': azFailure('ERROR: boom') });
        await expect(adapter(az.run).comment('42', 'note')).rejects.toBeInstanceOf(CliError);
    });

    it('closes a duplicate in the dropped state with a note naming the kept item', async () => {
        const az = fakeAz({ 'boards work-item update': workItem({ 'System.State': 'Removed' }, 51) });
        await adapter(az.run).closeDuplicate('51', '50');
        expect(az.calls[0].args).toEqual([
            'boards', 'work-item', 'update', '--org', freeText(ORG), '--id', '51',
            '--state', freeText('Removed'), '--discussion', freeText('Duplicate of #50'), '-o', 'json',
        ]);
    });

    it('queries changes with WIQL scoped to the project, by day, oldest first', async () => {
        const az = fakeAz({ 'boards query': `[${workItem()}]` });
        const items = await adapter(az.run).listChangedSince('2026-09-20T10:00:00.000Z', 500);
        const wiql = (az.calls[0].args[7] as { freeText: string }).freeText;
        expect(az.calls[0].args.slice(0, 7)).toEqual(['boards', 'query', '--org', freeText(ORG), '--project', freeText(PROJECT), '--wiql']);
        expect(wiql).toContain("[System.TeamProject] = 'Widgets ''Next'''");
        expect(wiql).toContain("[System.ChangedDate] >= '2026-09-19'");
        expect(wiql).toContain('ORDER BY [System.ChangedDate] ASC');
        expect(items.map(item => item.remoteId)).toEqual(['42']);
    });

    it('reads the day before since as the lower bound, also just after UTC midnight and across a month', async () => {
        const bound = async (since: string): Promise<string> => {
            const az = fakeAz({ 'boards query': '[]' });
            await adapter(az.run).listChangedSince(since, 1);
            return (az.calls[0].args[7] as { freeText: string }).freeText.match(/ChangedDate\] >= '([^']+)'/)![1];
        };
        expect(await bound('2026-09-20T00:00:01.000Z')).toBe('2026-09-19');
        expect(await bound('2026-10-01T23:59:59.000Z')).toBe('2026-09-30');
    });

    it('answers null for a deleted item, or one moved to another project', async () => {
        const deleted = azFailure('ERROR: TF401232: Work item 42 does not exist, or you do not have permissions to read it.');
        expect(await adapter(fakeAz({ 'boards work-item': deleted }).run).fetch('42')).toBeNull();
        expect(await adapter(fakeAz({ 'boards work-item': workItem({ 'System.TeamProject': 'Other' }) }).run).fetch('42')).toBeNull();
    });

    it('pauses on the az login message, when az is missing, and when GhostPM refuses to run az', async () => {
        const cases: [CliError, string | RegExp][] = [
            [azFailure(LOGGED_OUT_STDERR), AZ_LOGGED_OUT],
            [new CliError('az: missing', null, '', true, false), AZ_MISSING],
            [new CliError('refusing to pass "x" to az', null, '', false, true), /will not run az this way \(refusing to pass "x" to az\)/],
        ];
        for (const [error, reason] of cases) {
            const thrown = await adapter(fakeAz({ 'boards query': error }).run).listChangedSince('2026-09-20T00:00:00.000Z', 1)
                .catch((e: unknown) => e) as SyncPausedError;
            expect(thrown).toBeInstanceOf(SyncPausedError);
            if (typeof reason === 'string') expect(thrown.reason).toBe(reason);
            else expect(thrown.reason).toMatch(reason);
        }
    });

    it('pauses on a project or type Azure DevOps does not know, but only a work item is gone', async () => {
        const missing = azFailure('ERROR: TF401232: Work item 42 does not exist, or you do not have permissions to read it.');
        const outcome = (call: (a: AzureAdapter) => Promise<unknown>): Promise<unknown> =>
            call(adapter(fakeAz({ 'boards work-item': missing, 'boards query': missing }).run)).catch((e: unknown) => e);
        const projectLevel = [
            (a: AzureAdapter) => a.create({ title: 'x', phase: 'planned' }, 'b'),
            (a: AzureAdapter) => a.listChangedSince('2026-09-20T00:00:00.000Z', 1),
        ];
        for (const call of projectLevel) {
            const thrown = await outcome(call) as SyncPausedError;
            expect(thrown).toBeInstanceOf(SyncPausedError);
            expect(thrown.reason).toContain(PROJECT);
            expect(thrown.reason).toContain(TYPE);
            expect(thrown.reason).toContain('ghostpm config set ado_work_item_type');
        }
        const itemLevel = [
            (a: AzureAdapter) => a.syncState({ remoteId: '42', state: 'New', labels: [] }, { title: 'x', phase: 'done' }),
            (a: AzureAdapter) => a.comment('42', 'n'),
            (a: AzureAdapter) => a.closeDuplicate('42', '1'),
        ];
        for (const call of itemLevel) expect(await outcome(call)).toBeInstanceOf(GoneError);
    });

    it.each([
        'ERROR: (HTTP 401) Unauthorized',
        'ERROR: TF400813: The user is not authorized to access this resource.',
        'ERROR: AADSTS70043: The refresh token has expired',
        'ERROR: Interactive authentication is needed. Please run: az login',
        'ERROR: HTTP 403 Forbidden',
    ])('pauses on the auth failure %s, while an unrelated failure stays a CliError', async stderr => {
        const since = '2026-09-20T00:00:00.000Z';
        const thrown = await adapter(fakeAz({ 'boards query': azFailure(stderr) }).run).listChangedSince(since, 1)
            .catch((e: unknown) => e) as SyncPausedError;
        expect(thrown).toBeInstanceOf(SyncPausedError);
        expect(thrown.reason).toMatch(/az login/);
        const other = await adapter(fakeAz({ 'boards query': azFailure('ERROR: something else broke') }).run).listChangedSince(since, 1)
            .catch((e: unknown) => e);
        expect(other).toBeInstanceOf(CliError);
    });

    it('answers an unknown current user, never a pause, when az account show fails (a PAT-only login has no account)', async () => {
        for (const failure of [azFailure(LOGGED_OUT_STDERR), azFailure("ERROR: Please run 'az login' to setup account."), azFailure('ERROR: HTTP 401')]) {
            expect(await adapter(fakeAz({ 'account show': failure }).run).currentUser()).toBeNull();
        }
        expect(await adapter(fakeAz({ 'account show': '\n' }).run).currentUser()).toBeNull();
    });

    it('reads no items, not a JSON error, from the empty output az prints for a query with no rows', async () => {
        const az = fakeAz({ 'boards query': '' });
        expect(await adapter(az.run).listChangedSince('2026-09-20T00:00:00.000Z', 1)).toEqual([]);
        expect(await adapter(az.run).sampleProcess(90, 'ghostpm init')).toEqual({ states: [], workItemTypes: [], typeStates: [] });
    });

    it('reports a completed pull request of this organisation, and no other, not even a longer name', async () => {
        const az = fakeAz({ 'repos pr': JSON.stringify({ status: 'completed', closedDate: '2026-09-21T08:00:00Z' }) });
        expect(await adapter(az.run).mergedAt(`${ORG}/Widgets/_git/web/pullrequest/12`)).toBe('2026-09-21T08:00:00Z');
        expect(az.calls[0].args).toEqual(['repos', 'pr', 'show', '--org', freeText(ORG), '--id', '12', '-o', 'json']);
        expect(await adapter(az.run).mergedAt('https://dev.azure.com/other/x/_git/web/pullrequest/12')).toBeNull();
        expect(await adapter(az.run).mergedAt('https://dev.azure.com/acmecorp/Widgets/_git/web/pullrequest/12')).toBeNull();
        expect(await adapter(az.run).mergedAt('https://github.com/acme/widgets/pull/12')).toBeNull();
        expect(az.calls).toHaveLength(1);
    });

    it('answers null for a pull request that has not completed', async () => {
        const az = fakeAz({ 'repos pr': JSON.stringify({ status: 'active' }) });
        expect(await adapter(az.run).mergedAt(`${ORG}/Widgets/_git/web/pullrequest/12`)).toBeNull();
    });

    it('answers a pull request Azure DevOps no longer has as gone (F5)', async () => {
        // az 2.85's stderr for `az repos pr show --id 999999` on dev.azure.com (2026-10-16).
        const az = fakeAz({ 'repos pr': azFailure('ERROR: TF401180: The requested pull request was not found.') });
        await expect(adapter(az.run).mergedAt(`${ORG}/Widgets/_git/web/pullrequest/12`)).rejects.toBeInstanceOf(GoneError);
    });

    it('does not list by page: a query answers every match, whatever the limit (F6)', () => {
        expect(adapter(fakeAz().run).pages).toBe(false);
    });

    it('reads the current user', async () => {
        const az = fakeAz({ 'account show': 'octo@acme.test\n' });
        expect(await adapter(az.run).currentUser()).toBe('octo@acme.test');
        expect(az.calls[0].args).toEqual(['account', 'show', '--query', 'user.name', '-o', 'tsv']);
    });

    it.each([
        ['Committed', 'in_review', 'in_review'],
        ['Committed', 'planned', 'in_progress'],
        ['New', 'brainstorming', 'brainstorming'],
        ['done', 'in_review', 'done'],
        ['Resolved', 'planned', 'in_review'],
        ['Mystery', 'in_progress', 'planned'],
    ] as [string, Phase, Phase][])('reads %s over local %s as %s', (state, local, expected) => {
        expect(adapter(fakeAz().run).phaseOf(state, [], local)).toBe(expected);
    });

    it('treats a title az dropped characters from as the same title', () => {
        const titles = adapter(fakeAz().run);
        expect(titles.titlesMatch('Déjà vu  ', 'Déjà vu — ✓')).toBe(true);
        expect(titles.titlesMatch('Fix login', 'Fix login')).toBe(true);
        expect(titles.titlesMatch('Fix logon', 'Fix login')).toBe(false);
        expect(isLossyCopy('Fix login ', 'Fix login ✓')).toBe(true);
        expect(isLossyCopy('Fix login!', 'Fix login')).toBe(false);
        expect(isLossyCopy('Fix', 'Fix login')).toBe(false);
    });
});

describe('AzureAdapter retry lookups', () => {
    const marker = '<!-- ghostpm:0123456789abcdef -->';

    it('finds the work item an earlier create made: exact title, created by me, recently, marker in the description', async () => {
        const listing = JSON.stringify([
            JSON.parse(workItem({ 'System.Description': 'Same title, someone else' }, 41)),
            JSON.parse(workItem({ 'System.Description': `Tracked by GhostPM as T1.\n\n${marker}` }, 42)),
        ]);
        const az = fakeAz({ 'boards query': listing });
        expect((await adapter(az.run).findCreated(marker, "Fix 'x'"))?.remoteId).toBe('42');
        const wiql = (az.calls[0].args[7] as { freeText: string }).freeText;
        expect(wiql).toContain("[System.TeamProject] = 'Widgets ''Next'''");
        expect(wiql).toContain("[System.Title] = 'Fix ''x'''");
        expect(wiql).toContain('[System.CreatedBy] = @Me');
        expect(wiql).toMatch(/\[System\.CreatedDate\] >= '\d{4}-\d{2}-\d{2}'/);
        expect(await adapter(az.run).findCreated('<!-- ghostpm:ffffffffffffffff -->', "Fix 'x'")).toBeNull();
    });

    // Verified against real az 2.85: Azure strips the comment form and rewrites `display:none` to `display:none;`.
    const sanitised = '<span style="display:none;">ghostpm:0123456789abcdef</span>';

    it('writes the marker as a span in a created description and in a comment, leaving other text alone', async () => {
        const az = fakeAz({ 'boards work-item create': workItem(), 'boards work-item update': workItem() });
        await adapter(az.run).create({ title: 'Login fix', phase: 'planned' }, `body\n\n${marker}`);
        await adapter(az.run).comment('42', `progress\n\n${marker}`);
        const sent = (call: number, flag: string): string => {
            const args = az.calls[call].args;
            return (args[args.indexOf(flag) + 1] as { freeText: string }).freeText;
        };
        expect(sent(0, '--description')).toBe('body\n\n<span style="display:none">ghostpm:0123456789abcdef</span>');
        expect(sent(1, '--discussion')).toBe('progress\n\n<span style="display:none">ghostpm:0123456789abcdef</span>');
    });

    it('matches the sanitised, re-wrapped span in a description and in the history, and only its own nonce', async () => {
        const wrapped = `<div>Tracked by GhostPM as T1.</div><div><br></div><div>${sanitised}</div>`;
        const az = fakeAz({
            'boards query': JSON.stringify([JSON.parse(workItem({ 'System.Description': wrapped }, 42))]),
            'boards work-item show': workItem({ 'System.History': `progress<br><br>${sanitised}` }),
        });
        expect((await adapter(az.run).findCreated(marker, 'Login fix'))?.remoteId).toBe('42');
        expect(await adapter(az.run).findCreated('<!-- ghostpm:ffffffffffffffff -->', 'Login fix')).toBeNull();
        expect(await adapter(az.run).hasComment('42', marker)).toBe(true);
        expect(await adapter(az.run).hasComment('42', '<!-- ghostpm:ffffffffffffffff -->')).toBe(false);
    });

    it('never hands a span marker back, nor the whitespace before it', async () => {
        const az = fakeAz({ 'boards work-item show': workItem({ 'System.Description': `Tracked by GhostPM as T1.\n\n${sanitised}` }) });
        expect((await adapter(az.run).fetch('42'))!.body).toBe('Tracked by GhostPM as T1.');
    });

    it('never hands a marker back in a description it read', async () => {
        const az = fakeAz({ 'boards work-item show': workItem({ 'System.Description': `Tracked by GhostPM as T1.\n\n${marker}` }) });
        expect((await adapter(az.run).fetch('42'))!.body).toBe('Tracked by GhostPM as T1.');
    });

    it("reads the latest System.History for an earlier comment's marker", async () => {
        const az = fakeAz({ 'boards work-item show': workItem({ 'System.History': `progress<br><br>${marker}` }) });
        expect(await adapter(az.run).hasComment('42', marker)).toBe(true);
        expect(await adapter(az.run).hasComment('42', '<!-- ghostpm:ffffffffffffffff -->')).toBe(false);
        expect(az.calls[0].args.slice(0, 3)).toEqual(['boards', 'work-item', 'show']);
    });
});

describe('AzureAdapter.sampleProcess', () => {
    const SAMPLE_DAYS = 90;
    /** The command its caller wants a person to run once az works. */
    const RETRY = 'ghostpm init';
    const sampled = (fields: { [name: string]: string }[]): string =>
        JSON.stringify(fields.map((item, index) => ({ id: index + 1, fields: item })));

    it('queries only this project, by recent change, with --org, --project and the WIQL as free text (spec §8.1)', async () => {
        const az = fakeAz({ 'boards query': '[]' });
        await adapter(az.run).sampleProcess(SAMPLE_DAYS, RETRY);

        const [call] = az.calls;
        expect(call.command).toBe('az');
        expect(call.args.slice(0, 7)).toEqual(['boards', 'query', '--org', freeText(ORG), '--project', freeText(PROJECT), '--wiql']);
        const wiql = (call.args[7] as { freeText: string }).freeText;
        expect(wiql).toContain("[System.TeamProject] = 'Widgets ''Next'''");
        expect(wiql).toContain(`[System.ChangedDate] >= @Today - ${SAMPLE_DAYS}`);
        expect(wiql).toContain('[System.WorkItemType]');
        expect(call.args).not.toContain('--top');
    });

    it('bounds the sample by the vendor timeout', async () => {
        const timeouts: (number | undefined)[] = [];
        await adapter(async (_command, _args, options) => { timeouts.push(options?.timeoutMs); return '[]'; }).sampleProcess(SAMPLE_DAYS, RETRY);
        expect(timeouts).toEqual([VENDOR_CALL_TIMEOUT_MS, VENDOR_CALL_TIMEOUT_MS]);
    });

    it('collects distinct states in sampled order and types by frequency', async () => {
        const az = fakeAz({
            'boards query': sampled([
                { 'System.State': 'New', 'System.WorkItemType': 'Bug' },
                { 'System.State': 'Active', 'System.WorkItemType': 'Task' },
                { 'System.State': 'active', 'System.WorkItemType': 'Task' },
                { 'System.State': 'Closed', 'System.WorkItemType': 'Task' },
            ]),
        });
        expect(await adapter(az.run).sampleProcess(SAMPLE_DAYS, RETRY)).toEqual({ states: ['New', 'Active', 'Closed'], workItemTypes: ['Task', 'Bug'], typeStates: [] });
    });

    const typeStates = (...states: [string, string][]): string => JSON.stringify({ count: states.length, value: states.map(([name, category]) => ({ name, category })) });

    it('also reads the real states of the dominant work item type, with their categories', async () => {
        const az = fakeAz({
            'boards query': sampled([{ 'System.State': 'New', 'System.WorkItemType': 'Bug' }, { 'System.State': 'New', 'System.WorkItemType': 'Task' }, { 'System.State': 'New', 'System.WorkItemType': 'Task' }]),
            'devops invoke': typeStates(['New', 'Proposed'], ['Active', 'InProgress'], ['Closed', 'Completed']),
        });
        const process = await adapter(az.run).sampleProcess(SAMPLE_DAYS, RETRY);
        expect(process.typeStates).toEqual([{ name: 'New', category: 'Proposed' }, { name: 'Active', category: 'InProgress' }, { name: 'Closed', category: 'Completed' }]);
        expect(az.calls[1].args).toEqual([
            'devops', 'invoke', '--area', 'wit', '--resource', 'workItemTypeStates',
            '--route-parameters', freeText(`project=${PROJECT}`), freeText('type=Task'), '--org', freeText(ORG), '--api-version', '7.1', '-o', 'json',
        ]);
    });

    it("reads the configured work item type's states when the sample names no type", async () => {
        const az = fakeAz({ 'boards query': '', 'devops invoke': typeStates(['New', 'Proposed']) });
        await adapter(az.run).sampleProcess(SAMPLE_DAYS, RETRY);
        expect(az.calls[1].args).toContainEqual(freeText(`type=${TYPE}`));
    });

    it.each([
        ['an az failure', azFailure('ERROR: boom')],
        ['unreadable output', 'WARNING: not json'],
        ['an answer without states', '{}'],
    ])('falls back to the sample alone on %s, never throwing', async (_name, reply) => {
        const az = fakeAz({ 'boards query': sampled([{ 'System.State': 'New', 'System.WorkItemType': 'Task' }]), 'devops invoke': reply });
        expect(await adapter(az.run).sampleProcess(SAMPLE_DAYS, RETRY)).toEqual({ states: ['New'], workItemTypes: ['Task'], typeStates: [] });
    });

    const sampleFailure = async (stderr: string): Promise<SyncPausedError> =>
        await adapter(fakeAz({ 'boards query': azFailure(stderr) }).run).sampleProcess(SAMPLE_DAYS, RETRY).catch((e: unknown) => e) as SyncPausedError;

    it('lets an az failure reach the caller, classified like every az failure but advising its own retry', async () => {
        const thrown = await sampleFailure(LOGGED_OUT_STDERR);
        expect(thrown).toBeInstanceOf(SyncPausedError);
        expect(thrown.reason).toContain('az login');
        expect(thrown.reason).toContain(`\`${RETRY}\``);
        expect(thrown.reason).not.toContain('ghostpm sync');
    });

    it('blames only the project for a sample az cannot find: the sample names no work item type', async () => {
        const thrown = await sampleFailure('ERROR: TF401232: Work item 42 does not exist, or you do not have permissions to read it.');
        expect(thrown).toBeInstanceOf(SyncPausedError);
        expect(thrown.reason).toContain(PROJECT);
        expect(thrown.reason).not.toContain(TYPE);
        expect(thrown.reason).not.toContain('ado_work_item_type');
        expect(thrown.reason).toContain(`\`${RETRY}\``);
    });
});

describe('AzureAdapter call timeout', () => {
    it('bounds every az call by the vendor timeout', async () => {
        const timeouts: (number | undefined)[] = [];
        const run: Runner = async (_command, args, options) => {
            timeouts.push(options?.timeoutMs);
            return args[0] === 'account' ? 'octo@acme.test' : workItem();
        };
        await adapter(run).currentUser();
        await adapter(run).fetch('42');
        expect(timeouts).toEqual([VENDOR_CALL_TIMEOUT_MS, VENDOR_CALL_TIMEOUT_MS]);
    });
});

describe('isLossyCopy', () => {
    it('reads U+FFFD as one non-ASCII character az could not encode', () => {
        expect(isLossyCopy('Caf� au lait', 'Café au lait')).toBe(true);
        expect(isLossyCopy('�� x', '日本 x')).toBe(true);
        expect(isLossyCopy('Caf� ', 'Café ✓')).toBe(true);
    });

    it('does not read U+FFFD as an ASCII character, or as one that was never there', () => {
        expect(isLossyCopy('Fi� login', 'Fix login')).toBe(false);
        expect(isLossyCopy('Caf��', 'Café')).toBe(false);
    });

    it('tolerates the trailing line breaks az strips from free text, and only those', () => {
        expect(isLossyCopy('Fix login', 'Fix login\n')).toBe(true);
        expect(isLossyCopy('Fix login', 'Fix login\r\n\r\n')).toBe(true);
        expect(isLossyCopy('Café', 'Café\r\n')).toBe(true);
        expect(isLossyCopy('Fix login', 'Fix\nlogin')).toBe(false);
        expect(isLossyCopy('Fix login', ' Fix login')).toBe(false);
    });
});

describe('phaseStateMapFromCategories', () => {
    const state = (name: string, category: string): AzureTypeState => ({ name, category });
    const AGILE = [state('New', 'Proposed'), state('Active', 'InProgress'), state('Resolved', 'Resolved'), state('Closed', 'Completed'), state('Removed', 'Removed')];

    it('maps an Agile type by category', () => {
        expect(phaseStateMapFromCategories(AGILE)).toEqual({
            brainstorming: 'New', planned: 'New', in_progress: 'Active', in_review: 'Resolved', done: 'Closed', dropped: 'Removed',
        });
    });

    // The `value` of workItemTypeStates for type Task in a new project of each stock process (dev.azure.com, api-version 7.1, 2026-10-16).
    const REAL_TASK_STATES = {
        Scrum: [
            { category: 'Proposed', color: 'b2b2b2', name: 'To Do' }, { category: 'InProgress', color: '007acc', name: 'In Progress' },
            { category: 'Completed', color: '339933', name: 'Done' }, { category: 'Removed', color: 'ffffff', name: 'Removed' },
        ],
        Basic: [
            { category: 'Proposed', color: 'b2b2b2', name: 'To Do' }, { category: 'InProgress', color: '007acc', name: 'Doing' },
            { category: 'Completed', color: '339933', name: 'Done' },
        ],
        CMMI: [
            { category: 'Proposed', color: 'b2b2b2', name: 'Proposed' }, { category: 'InProgress', color: '007acc', name: 'Active' },
            { category: 'InProgress', color: '007acc', name: 'Resolved' }, { category: 'Completed', color: '339933', name: 'Closed' },
        ],
    };

    it("maps Scrum's Task, which has no Resolved: in_review shares in_progress", () => {
        expect(phaseStateMapFromCategories(REAL_TASK_STATES.Scrum)).toEqual({
            brainstorming: 'To Do', planned: 'To Do', in_progress: 'In Progress', in_review: 'In Progress', done: 'Done', dropped: 'Removed',
        });
    });

    it("maps Basic's Task, which has no Removed: dropped shares done", () => {
        expect(phaseStateMapFromCategories(REAL_TASK_STATES.Basic)).toEqual({
            brainstorming: 'To Do', planned: 'To Do', in_progress: 'Doing', in_review: 'Doing', done: 'Done', dropped: 'Done',
        });
    });

    it("maps CMMI's Task, whose Resolved is an InProgress state: in_review takes the one in_progress did not", () => {
        expect(phaseStateMapFromCategories(REAL_TASK_STATES.CMMI)).toEqual({
            brainstorming: 'Proposed', planned: 'Proposed', in_progress: 'Active', in_review: 'Resolved', done: 'Closed', dropped: 'Closed',
        });
        // Only Active seen in use: in_progress keeps it, and in_review still gets a state of its own.
        expect(phaseStateMapFromCategories(REAL_TASK_STATES.CMMI, ['Active'])).toMatchObject({ in_progress: 'Active', in_review: 'Resolved' });
        // Only Resolved seen (seen live): a state in use must not pull in_progress past Active.
        expect(phaseStateMapFromCategories(REAL_TASK_STATES.CMMI, ['Resolved'])).toMatchObject({ in_progress: 'Active', in_review: 'Resolved' });
    });

    it('keeps workflow order in a category another phase falls back to, whatever was seen', () => {
        const completed = [state('New', 'Proposed'), state('Done', 'Completed'), state("Won't Fix", 'Completed')];
        expect(phaseStateMapFromCategories(completed, ["won't fix"])).toMatchObject({ done: 'Done', dropped: "Won't Fix" });
    });

    it('leaves a phase out when neither its category nor its fallback exists, and ignores unknown categories', () => {
        expect(phaseStateMapFromCategories([state('Weird', 'Whatever'), state('New', 'Proposed')])).toEqual({ brainstorming: 'New', planned: 'New' });
        expect(phaseStateMapFromCategories([])).toEqual({});
    });

    it('prefers a state of the category that was seen in use, else the first one the API lists', () => {
        const scrum = [state('New', 'Proposed'), state('Approved', 'Proposed')];
        expect(phaseStateMapFromCategories(scrum).planned).toBe('New');
        expect(phaseStateMapFromCategories(scrum, ['approved']).planned).toBe('Approved');
    });
});

describe('AzureAdapter.phaseOf with phases that share a state', () => {
    const shared = adapter(fakeAz().run, { brainstorming: 'New', planned: 'New', in_progress: 'Active', in_review: 'Active', done: 'Closed', dropped: 'Closed' });

    it.each([
        ['New', 'planned', 'planned'],
        ['New', 'brainstorming', 'brainstorming'],
        ['Closed', 'dropped', 'dropped'],
        ['Closed', 'done', 'done'],
        ['Active', 'in_review', 'in_review'],
    ] as [string, Phase, Phase][])('keeps remote %s over local %s as %s', (state, local, expected) => {
        expect(shared.phaseOf(state, [], local)).toBe(expected);
    });

    it.each([
        ['New', 'in_progress', 'planned'],
        ['new', 'in_progress', 'planned'],
        ['Active', 'planned', 'in_progress'],
        ['Closed', 'in_progress', 'done'],
        ['Closed', 'planned', 'done'],
        ['Mystery', 'in_progress', 'planned'],
    ] as [string, Phase, Phase][])('reads a remote move to shared %s over local %s as the sensible phase %s', (state, local, expected) => {
        expect(shared.phaseOf(state, [], local)).toBe(expected);
    });
});
