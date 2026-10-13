import { CliArg, CliError, RunOptions, Runner, freeText } from '../../src/cli';
import { GitHubAdapter, githubPhaseOf, GH_LOGGED_OUT, GH_MISSING } from '../../src/sync/github';
import { GoneError, SyncPausedError, VENDOR_CALL_TIMEOUT_MS } from '../../src/sync/vendor';
import { LEASE_TTL_MS } from '../../src/sync/lease';
import { Phase } from '../../src/ledger/types';

interface Call { command: string; args: CliArg[]; input?: string }
type Reply = string | Error;

/** Answers gh by the first two words of each call, and records every call. */
function fakeGh(replies: { [words: string]: Reply } = {}): { run: Runner; calls: Call[] } {
    const calls: Call[] = [];
    const run: Runner = async (command: string, args: CliArg[], options?: RunOptions) => {
        calls.push({ command, args, input: options?.input });
        const words = args.slice(0, 2).map(arg => (typeof arg === 'string' ? arg : arg.freeText)).join(' ');
        const reply = replies[words] ?? '';
        if (reply instanceof Error) throw reply;
        return reply;
    };
    return { run, calls };
}

let repoCounter = 0;
/** Ensured labels are remembered per repo for the life of the process: one repo per test. */
const freshRepo = (): string => `acme/widgets-${++repoCounter}`;
const ISSUE_FIELDS = 'number,title,body,state,stateReason,labels,assignees,milestone,updatedAt,url';

interface IssueOverrides { number?: number; title?: string; state?: string; stateReason?: string | null; labels?: string[]; url?: string }
const issueJson = (repo: string, overrides: IssueOverrides = {}): string => JSON.stringify({
    number: overrides.number ?? 12,
    title: overrides.title ?? 'Login fix',
    body: 'Tracked by GhostPM as T1.',
    state: overrides.state ?? 'OPEN',
    stateReason: overrides.stateReason ?? null,
    labels: (overrides.labels ?? ['ghostpm:planned']).map(name => ({ name })),
    assignees: [{ login: 'octocat' }],
    milestone: { title: 'Sprint 3' },
    updatedAt: '2026-09-20T10:00:00Z',
    url: overrides.url ?? `https://github.com/${repo}/issues/${overrides.number ?? 12}`,
});

describe('GitHubAdapter', () => {
    it('creates an issue with its phase label, the body on stdin and an explicit repo', async () => {
        const repo = freshRepo();
        const gh = fakeGh({ 'issue create': `https://github.com/${repo}/issues/12\n`, 'issue view': issueJson(repo) });
        const item = await new GitHubAdapter(repo, gh.run).create({ title: 'Fix a&b "q"', phase: 'planned' }, 'Tracked by GhostPM as T1.');
        expect(gh.calls).toEqual([
            { command: 'gh', args: ['label', 'create', 'ghostpm:planned', '--repo', freeText(repo), '--force'], input: undefined },
            {
                command: 'gh',
                args: ['issue', 'create', '--repo', freeText(repo), '--title', freeText('Fix a&b "q"'), '--label', 'ghostpm:planned', '--body-file', '-'],
                input: 'Tracked by GhostPM as T1.',
            },
            { command: 'gh', args: ['issue', 'view', '12', '--repo', freeText(repo), '--json', ISSUE_FIELDS], input: undefined },
        ]);
        expect(item).toEqual({
            remoteId: '12', url: `https://github.com/${repo}/issues/12`, title: 'Login fix', body: 'Tracked by GhostPM as T1.',
            state: 'open', labels: ['ghostpm:planned'], assignee: 'octocat', milestone: 'Sprint 3', updatedAt: '2026-09-20T10:00:00Z',
        });
    });

    it('creates each label once per repo', async () => {
        const repo = freshRepo();
        const gh = fakeGh({ 'issue create': `https://github.com/${repo}/issues/12\n`, 'issue view': issueJson(repo) });
        const adapter = new GitHubAdapter(repo, gh.run);
        await adapter.create({ title: 'One', phase: 'planned' }, 'body');
        await adapter.create({ title: 'Two', phase: 'planned' }, 'body');
        expect(gh.calls.filter(call => call.args[0] === 'label')).toHaveLength(1);
    });

    it('swaps the phase label and sets the title in one edit', async () => {
        const repo = freshRepo();
        const gh = fakeGh({ 'issue view': issueJson(repo, { labels: ['bug', 'ghostpm:in_progress'] }) });
        await new GitHubAdapter(repo, gh.run).syncState(
            { remoteId: '12', state: 'open', labels: ['bug', 'ghostpm:planned'] },
            { title: 'Renamed', phase: 'in_progress' },
        );
        expect(gh.calls.map(call => call.args)).toEqual([
            ['label', 'create', 'ghostpm:in_progress', '--repo', freeText(repo), '--force'],
            ['issue', 'edit', '12', '--repo', freeText(repo), '--title', freeText('Renamed'),
                '--remove-label', freeText('ghostpm:planned'), '--add-label', 'ghostpm:in_progress'],
            ['issue', 'view', '12', '--repo', freeText(repo), '--json', ISSUE_FIELDS],
        ]);
    });

    it.each([
        ['done', 'completed'],
        ['dropped', 'not planned'],
    ] as [Phase, string][])('closes an issue moved to %s with --reason %s', async (phase, reason) => {
        const repo = freshRepo();
        const gh = fakeGh({ 'issue view': issueJson(repo, { state: 'CLOSED' }) });
        await new GitHubAdapter(repo, gh.run).syncState({ remoteId: '12', state: 'open', labels: ['ghostpm:in_review'] }, { title: 'Login fix', phase });
        expect(gh.calls.map(call => call.args)).toContainEqual(['issue', 'close', '12', '--repo', freeText(repo), '--reason', freeText(reason)]);
        expect(gh.calls.some(call => call.args[0] === 'label')).toBe(false);
    });

    it('reopens a closed issue that moved back to an open phase', async () => {
        const repo = freshRepo();
        const gh = fakeGh({ 'issue view': issueJson(repo, { labels: ['ghostpm:in_progress'] }) });
        await new GitHubAdapter(repo, gh.run).syncState(
            { remoteId: '12', state: 'closed:completed', labels: ['ghostpm:in_review'] },
            { title: 'Login fix', phase: 'in_progress' },
        );
        const verbs = gh.calls.map(call => `${call.args[0]} ${call.args[1]}`);
        expect(verbs).toEqual(['label create', 'issue reopen', 'issue edit', 'issue view']);
        expect(gh.calls[1].args).toEqual(['issue', 'reopen', '12', '--repo', freeText(repo)]);
    });

    it('closes a merged duplicate with --reason duplicate and --duplicate-of', async () => {
        const repo = freshRepo();
        const gh = fakeGh({ 'issue view': issueJson(repo, { number: 51, state: 'CLOSED', stateReason: 'DUPLICATE' }) });
        const item = await new GitHubAdapter(repo, gh.run).closeDuplicate('51', '50');
        expect(gh.calls[0].args).toEqual(['issue', 'close', '51', '--repo', freeText(repo), '--reason', 'duplicate', '--duplicate-of', '50']);
        expect(item.state).toBe('closed:duplicate');
    });

    it('comments with the text on stdin', async () => {
        const repo = freshRepo();
        const gh = fakeGh({ 'issue view': issueJson(repo) });
        await new GitHubAdapter(repo, gh.run).comment('12', 'Phase: planned → in_progress · 1 commit');
        expect(gh.calls[0]).toEqual({
            command: 'gh', args: ['issue', 'comment', '12', '--repo', freeText(repo), '--body-file', '-'],
            input: 'Phase: planned → in_progress · 1 commit',
        });
    });

    it('lists issues in every state changed since a time, oldest change first', async () => {
        const repo = freshRepo();
        const gh = fakeGh({ 'issue list': `[${issueJson(repo, { state: 'CLOSED', stateReason: 'NOT_PLANNED' })}]` });
        const items = await new GitHubAdapter(repo, gh.run).listChangedSince('2026-09-20T10:00:00.000Z', 500);
        expect(gh.calls[0].args).toEqual([
            'issue', 'list', '--repo', freeText(repo), '--state', 'all', '--limit', '500',
            '--search', freeText('updated:>=2026-09-20T10:00:00.000Z sort:updated-asc'), '--json', ISSUE_FIELDS,
        ]);
        expect(items.map(item => item.state)).toEqual(['closed:not_planned']);
    });

    it('answers null for an issue that is gone, or that now answers from another repo', async () => {
        const repo = freshRepo();
        const gone = new CliError('gh failed (exit 1)', 1, 'GraphQL: Could not resolve to an issue or pull request with the number of 12.', false, false);
        expect(await new GitHubAdapter(repo, fakeGh({ 'issue view': gone }).run).fetch('12')).toBeNull();
        const moved = fakeGh({ 'issue view': issueJson(repo, { url: 'https://github.com/elsewhere/other/issues/3' }), 'repo view': JSON.stringify({ nameWithOwner: repo }) });
        expect(await new GitHubAdapter(repo, moved.run).fetch('12')).toBeNull();
    });

    it('pauses on exit code 4 (not logged in), a missing gh, or a gh GhostPM will not run', async () => {
        const cases: [CliError, string][] = [
            [new CliError('gh failed (exit 4)', 4, 'To get started with GitHub CLI, please run:  gh auth login', false, false), GH_LOGGED_OUT],
            [new CliError('gh: C:\\missing\\gh.exe does not exist', null, '', true, false), GH_MISSING],
        ];
        for (const [error, reason] of cases) {
            const adapter = new GitHubAdapter(freshRepo(), fakeGh({ 'api user': error }).run);
            const thrown = await adapter.currentUser().catch((e: unknown) => e) as SyncPausedError;
            expect(thrown).toBeInstanceOf(SyncPausedError);
            expect(thrown.reason).toBe(reason);
        }
        const refused = new CliError('gh resolves to the batch file C:\\tools\\gh.cmd', null, '', false, true);
        const thrown = await new GitHubAdapter(freshRepo(), fakeGh({ 'api user': refused }).run).currentUser().catch((e: unknown) => e) as SyncPausedError;
        expect(thrown.reason).toContain('GhostPM will not run gh this way');
    });

    it('reports when a PR of this repo merged, and ignores PRs of other repos', async () => {
        const repo = freshRepo();
        const gh = fakeGh({ 'pr view': JSON.stringify({ state: 'MERGED', mergedAt: '2026-09-21T08:00:00Z' }), 'repo view': JSON.stringify({ nameWithOwner: repo }) });
        const adapter = new GitHubAdapter(repo, gh.run);
        expect(await adapter.mergedAt(`https://github.com/${repo}/pull/7`)).toBe('2026-09-21T08:00:00Z');
        expect(gh.calls[0].args).toEqual(['pr', 'view', '7', '--repo', freeText(repo), '--json', 'state,mergedAt']);
        expect(await adapter.mergedAt('https://github.com/elsewhere/other/pull/7')).toBeNull();
        expect(gh.calls.map(call => call.args[0])).toEqual(['pr', 'repo']);
    });

    it('renames a closed duplicate as it is, never reopening it to close it again as not planned (F12)', async () => {
        const repo = freshRepo();
        const gh = fakeGh({ 'issue view': issueJson(repo, { number: 51, state: 'CLOSED', stateReason: 'DUPLICATE', labels: [] }) });
        await new GitHubAdapter(repo, gh.run).syncState({ remoteId: '51', state: 'closed:duplicate', labels: [] }, { title: 'Renamed', phase: 'dropped' });
        expect(gh.calls.map(call => call.args)).toEqual([
            ['issue', 'edit', '51', '--repo', freeText(repo), '--title', freeText('Renamed')],
            ['issue', 'view', '51', '--repo', freeText(repo), '--json', ISSUE_FIELDS],
        ]);
    });

    it('still closes a duplicate again as completed when its task is done', async () => {
        const repo = freshRepo();
        const gh = fakeGh({ 'issue view': issueJson(repo, { number: 51, state: 'CLOSED', stateReason: 'COMPLETED', labels: [] }) });
        await new GitHubAdapter(repo, gh.run).syncState({ remoteId: '51', state: 'closed:duplicate', labels: [] }, { title: 'Done after all', phase: 'done' });
        expect(gh.calls.map(call => `${call.args[0]} ${call.args[1]}`)).toEqual(['issue reopen', 'issue edit', 'issue close', 'issue view']);
        expect(gh.calls[2].args).toContainEqual(freeText('completed'));
    });

    it('answers a pull request GitHub cannot resolve as gone (F5)', async () => {
        const repo = freshRepo();
        const missing = new CliError('gh failed (exit 1)', 1, 'GraphQL: Could not resolve to a PullRequest with the number of 9. (repository.pullRequest)', false, false);
        const adapter = new GitHubAdapter(repo, fakeGh({ 'pr view': missing }).run);
        await expect(adapter.mergedAt(`https://github.com/${repo}/pull/9`)).rejects.toBeInstanceOf(GoneError);
    });

    it('lists by page: no more than the limit asked for (F6)', () => {
        expect(new GitHubAdapter(freshRepo(), fakeGh().run).pages).toBe(true);
    });

    it('reads the current user', async () => {
        const gh = fakeGh({ 'api user': 'octocat\n' });
        expect(await new GitHubAdapter(freshRepo(), gh.run).currentUser()).toBe('octocat');
        expect(gh.calls[0].args).toEqual(['api', 'user', '--jq', '.login']);
    });
});

describe('githubPhaseOf', () => {
    it.each([
        ['closed:completed', [], 'in_review', 'done'],
        ['closed', [], 'in_review', 'done'],
        ['closed:not_planned', [], 'in_progress', 'dropped'],
        ['closed:duplicate', [], 'planned', 'dropped'],
        ['open', ['bug', 'ghostpm:in_review'], 'planned', 'in_review'],
        ['open', ['bug'], 'in_progress', 'in_progress'],
        ['open', [], 'done', 'in_progress'],
        ['open', ['ghostpm:done'], 'planned', 'planned'],
    ] as [string, string[], Phase, Phase][])('%s with %j over local %s reads as %s', (state, labels, local, expected) => {
        expect(githubPhaseOf(state, labels, local)).toBe(expected);
    });
});

const cliFailure = (stderr: string, exitCode = 1): CliError => new CliError(`gh failed (exit ${exitCode})`, exitCode, stderr, false, false);
const pausedBy = async (promise: Promise<unknown>): Promise<SyncPausedError> => {
    const thrown = await promise.catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(SyncPausedError);
    return thrown as SyncPausedError;
};
const verbsOf = (calls: Call[]): string[] => calls.map(call => `${call.args[0]} ${call.args[1]}`);

describe('GitHubAdapter retry safety', () => {
    it('still returns the new issue when the fetch after create fails', async () => {
        const repo = freshRepo();
        const gh = fakeGh({ 'issue create': `https://github.com/${repo}/issues/77\n`, 'issue view': new Error('network down') });
        const item = await new GitHubAdapter(repo, gh.run).create({ title: 'Fix it', phase: 'planned' }, 'body');
        expect(item).toMatchObject({ remoteId: '77', url: `https://github.com/${repo}/issues/77`, title: 'Fix it', state: 'open', labels: ['ghostpm:planned'] });
    });

    it('posts a comment once and resolves null when only the re-fetch fails', async () => {
        const repo = freshRepo();
        const gh = fakeGh({ 'issue view': new Error('network down') });
        const item = await new GitHubAdapter(repo, gh.run).comment('12', 'hello');
        expect(item).toBeNull();
        expect(gh.calls.filter(call => call.args[0] === 'issue' && call.args[1] === 'comment')).toHaveLength(1);
    });
});

describe('GitHubAdapter closed to closed', () => {
    const move = async (state: string, phase: Phase): Promise<Call[]> => {
        const repo = freshRepo();
        const gh = fakeGh({ 'issue view': issueJson(repo, { state: 'CLOSED' }) });
        await new GitHubAdapter(repo, gh.run).syncState({ remoteId: '12', state, labels: [] }, { title: 'Login fix', phase });
        return gh.calls;
    };

    it('reopens, then closes with the new reason for done to dropped', async () => {
        const calls = await move('closed:completed', 'dropped');
        expect(verbsOf(calls)).toEqual(['issue reopen', 'issue edit', 'issue close', 'issue view']);
        expect(calls[2].args.slice(-2)).toEqual(['--reason', freeText('not planned')]);
    });

    it('reopens, then closes with the new reason for dropped to done', async () => {
        const calls = await move('closed:not_planned', 'done');
        expect(verbsOf(calls)).toEqual(['issue reopen', 'issue edit', 'issue close', 'issue view']);
        expect(calls[2].args.slice(-2)).toEqual(['--reason', freeText('completed')]);
    });

    it('does not reopen or close when the reason already matches', async () => {
        expect(verbsOf(await move('closed:completed', 'done'))).toEqual(['issue edit', 'issue view']);
        expect(verbsOf(await move('closed:not_planned', 'dropped'))).toEqual(['issue edit', 'issue view']);
    });
});

describe('GitHubAdapter not found', () => {
    const notFound = cliFailure('HTTP 404: Not Found (https://api.github.com/repos/acme/x/labels)');

    it('pauses naming the repo when the label, create or list call answers 404', async () => {
        for (const replies of [{ 'label create': notFound }, { 'issue create': notFound }] as { [words: string]: Reply }[]) {
            const repo = freshRepo();
            const paused = await pausedBy(new GitHubAdapter(repo, fakeGh(replies).run).create({ title: 'T', phase: 'planned' }, 'b'));
            expect(paused.reason).toContain(repo);
        }
        const repo = freshRepo();
        const paused = await pausedBy(new GitHubAdapter(repo, fakeGh({ 'issue list': notFound }).run).listChangedSince('2026-09-20T10:00:00Z', 10));
        expect(paused.reason).toContain(repo);
    });

    it('treats a 404 or 410 on an issue-level call as that item being gone', async () => {
        const repo = freshRepo();
        expect(await new GitHubAdapter(repo, fakeGh({ 'issue view': notFound }).run).fetch('12')).toBeNull();
        const gone = await new GitHubAdapter(repo, fakeGh({ 'issue comment': cliFailure('HTTP 410: Gone') }).run).comment('12', 'x').catch((e: unknown) => e);
        expect(gone).toBeInstanceOf(GoneError);
    });
});

describe('GitHubAdapter renamed repo', () => {
    it('owns issues under the repo canonical name, resolved once', async () => {
        const repo = freshRepo();
        const renamed = `acme/renamed-${repo}`;
        const gh = fakeGh({ 'issue view': issueJson(repo, { url: `https://github.com/${renamed}/issues/12` }), 'repo view': JSON.stringify({ nameWithOwner: renamed }) });
        const adapter = new GitHubAdapter(repo, gh.run);
        expect(await adapter.fetch('12')).not.toBeNull();
        expect(await adapter.fetch('12')).not.toBeNull();
        expect(gh.calls.filter(call => call.args[0] === 'repo')).toHaveLength(1);
        expect(gh.calls.find(call => call.args[0] === 'repo')?.args).toEqual(['repo', 'view', repo, '--json', 'nameWithOwner']);
    });

    it('still treats an issue from an unrelated repo as moved', async () => {
        const repo = freshRepo();
        const gh = fakeGh({ 'issue view': issueJson(repo, { url: 'https://github.com/elsewhere/other/issues/12' }), 'repo view': JSON.stringify({ nameWithOwner: `acme/renamed-${repo}` }) });
        expect(await new GitHubAdapter(repo, gh.run).fetch('12')).toBeNull();
    });
});

describe('GitHubAdapter auth pause', () => {
    const pauseReason = async (stderr: string): Promise<string> => (await pausedBy(new GitHubAdapter(freshRepo(), fakeGh({ 'api user': cliFailure(stderr) }).run).currentUser())).reason;

    it('pauses on HTTP 401, bad credentials or a gh auth login hint', async () => {
        expect(await pauseReason('HTTP 401: Bad credentials (https://api.github.com/user)')).toBe(GH_LOGGED_OUT);
        expect(await pauseReason('Bad credentials')).toBe(GH_LOGGED_OUT);
        expect(await pauseReason('try running: gh auth login')).toBe(GH_LOGGED_OUT);
    });

    it('pauses on a 403 that names a missing scope, with the fix from the message', async () => {
        expect(await pauseReason('HTTP 403: missing required scopes [repo]. To request it, run: gh auth refresh -s repo')).toContain('`gh auth refresh -s repo`');
        expect(await pauseReason('HTTP 403: token is missing a scope')).toContain('`gh auth refresh`');
    });

    it('leaves a plain 403 as an ordinary error', async () => {
        const thrown = await new GitHubAdapter(freshRepo(), fakeGh({ 'api user': cliFailure('HTTP 403: API rate limit exceeded') }).run).currentUser().catch((e: unknown) => e);
        expect(thrown).toBeInstanceOf(CliError);
    });
});

describe('GitHubAdapter retry lookups', () => {
    const marker = '<!-- ghostpm:0123456789abcdef -->';
    const withBody = (repo: string, number: number, body: string): unknown => ({ ...JSON.parse(issueJson(repo, { number })), body });

    it('finds the issue an earlier create made by its marker, in a plain listing without search', async () => {
        const repo = freshRepo();
        const listing = JSON.stringify([withBody(repo, 13, 'Someone else'), withBody(repo, 12, `Tracked by GhostPM as T1.\n\n${marker}`)]);
        const gh = fakeGh({ 'issue list': listing });
        const adapter = new GitHubAdapter(repo, gh.run);
        expect((await adapter.findCreated(marker, 'Login fix'))?.remoteId).toBe('12');
        expect(gh.calls[0].args).toEqual(['issue', 'list', '--repo', freeText(repo), '--state', 'all', '--limit', '30', '--json', ISSUE_FIELDS]);
        expect(await adapter.findCreated('<!-- ghostpm:ffffffffffffffff -->', 'Login fix')).toBeNull();
    });

    it('never hands a marker back in a body it read', async () => {
        const repo = freshRepo();
        const gh = fakeGh({ 'issue view': JSON.stringify(withBody(repo, 12, `Tracked by GhostPM as T1.\n\n${marker}`)) });
        expect((await new GitHubAdapter(repo, gh.run).fetch('12'))!.body).toBe('Tracked by GhostPM as T1.');
    });

    it('tells whether an earlier comment carrying the marker is on the issue', async () => {
        const repo = freshRepo();
        const gh = fakeGh({ 'issue view': JSON.stringify({ comments: [{ body: 'first' }, { body: `progress\n\n${marker}` }] }) });
        const adapter = new GitHubAdapter(repo, gh.run);
        expect(await adapter.hasComment('12', marker)).toBe(true);
        expect(await adapter.hasComment('12', '<!-- ghostpm:ffffffffffffffff -->')).toBe(false);
        expect(gh.calls[0].args).toEqual(['issue', 'view', '12', '--repo', freeText(repo), '--json', 'comments']);
    });
});

describe('GitHubAdapter call timeout', () => {
    it('bounds every gh call by the vendor timeout, which ends inside the sync lease', async () => {
        const timeouts: (number | undefined)[] = [];
        const run: Runner = async (_command, _args, options) => {
            timeouts.push(options?.timeoutMs);
            return 'octocat';
        };
        await new GitHubAdapter(freshRepo(), run).currentUser();
        expect(timeouts).toEqual([VENDOR_CALL_TIMEOUT_MS]);
        expect(VENDOR_CALL_TIMEOUT_MS).toBeLessThan(LEASE_TTL_MS);
    });
});