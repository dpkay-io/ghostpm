import { CliArg, CliError, RunOptions, Runner, freeText } from '../../src/cli';
import { GitHubAdapter, githubPhaseOf, GH_LOGGED_OUT, GH_MISSING } from '../../src/sync/github';
import { SyncPausedError } from '../../src/sync/vendor';
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
        const moved = fakeGh({ 'issue view': issueJson(repo, { url: 'https://github.com/elsewhere/other/issues/3' }) });
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
        const gh = fakeGh({ 'pr view': JSON.stringify({ state: 'MERGED', mergedAt: '2026-09-21T08:00:00Z' }) });
        const adapter = new GitHubAdapter(repo, gh.run);
        expect(await adapter.mergedAt(`https://github.com/${repo}/pull/7`)).toBe('2026-09-21T08:00:00Z');
        expect(gh.calls[0].args).toEqual(['pr', 'view', '7', '--repo', freeText(repo), '--json', 'state,mergedAt']);
        expect(await adapter.mergedAt('https://github.com/elsewhere/other/pull/7')).toBeNull();
        expect(gh.calls).toHaveLength(1);
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
