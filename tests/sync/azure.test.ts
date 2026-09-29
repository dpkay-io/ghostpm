import { CliArg, CliError, RunOptions, Runner, freeText } from '../../src/cli';
import { AzureAdapter, isLossyCopy, AZ_LOGGED_OUT, AZ_MISSING } from '../../src/sync/azure';
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

    it('fails a phase with no mapped state for good, naming the command that fixes it', async () => {
        const az = fakeAz();
        const error = await adapter(az.run, { planned: 'New' }).syncState({ remoteId: '42', state: 'New', labels: [] }, { title: 'x', phase: 'in_review' })
            .catch((e: unknown) => e) as PermanentError;
        expect(error).toBeInstanceOf(PermanentError);
        expect(error.message).toContain('ghostpm config set phase_state_map in_review=');
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
            call(adapter(fakeAz({ 'boards work-item': missing, 'boards query': missing, 'account show': missing }).run)).catch((e: unknown) => e);
        const projectLevel = [
            (a: AzureAdapter) => a.create({ title: 'x', phase: 'planned' }, 'b'),
            (a: AzureAdapter) => a.listChangedSince('2026-09-20T00:00:00.000Z', 1),
            (a: AzureAdapter) => a.currentUser(),
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

    it('pauses when the current user is asked for while logged out', async () => {
        const thrown = await adapter(fakeAz({ 'account show': azFailure(LOGGED_OUT_STDERR) }).run).currentUser().catch((e: unknown) => e) as SyncPausedError;
        expect(thrown).toBeInstanceOf(SyncPausedError);
        expect(thrown.reason).toBe(AZ_LOGGED_OUT);
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
