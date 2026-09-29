import { parseRemote, identityOf } from '../../src/sync/identity';
import { WorkspaceRow } from '../../src/ledger/types';

describe('vendor identity from the git remote', () => {
    it.each([
        ['https://github.com/acme/widgets.git', 'acme/widgets'],
        ['https://github.com/acme/widgets', 'acme/widgets'],
        ['https://github.com/acme/widgets/', 'acme/widgets'],
        ['https://token:x-oauth@github.com/acme/widgets.git', 'acme/widgets'],
        ['git@github.com:acme/widgets.git', 'acme/widgets'],
        ['ssh://git@github.com/acme/widgets.git', 'acme/widgets'],
        ['ssh://git@github.com:22/acme/widgets.git', 'acme/widgets'],
        ['https://github.com/acme/my.dotted.repo.git', 'acme/my.dotted.repo'],
    ])('reads GitHub %s as %s', (remote, repo) => {
        expect(parseRemote('github', remote)).toEqual({ vendor: 'github', repo });
    });

    it.each([
        ['https://dev.azure.com/acme/Widgets/_git/widgets', 'https://dev.azure.com/acme', 'Widgets'],
        ['https://acme@dev.azure.com/acme/My%20Project/_git/web', 'https://dev.azure.com/acme', 'My Project'],
        ['https://dev.azure.com/acme/_git/Widgets', 'https://dev.azure.com/acme', 'Widgets'],
        ['https://dev.azure.com/org/proj/_git/repo?version=GBmain', 'https://dev.azure.com/org', 'proj'],
        ['git@ssh.dev.azure.com:v3/acme/Widgets/widgets', 'https://dev.azure.com/acme', 'Widgets'],
        ['https://acme.visualstudio.com/Widgets/_git/widgets', 'https://acme.visualstudio.com', 'Widgets'],
        ['https://acme.visualstudio.com/DefaultCollection/Widgets/_git/widgets', 'https://acme.visualstudio.com', 'Widgets'],
        ['acme@vs-ssh.visualstudio.com:v3/acme/Widgets/widgets', 'https://acme.visualstudio.com', 'Widgets'],
    ])('reads Azure DevOps %s as %s / %s', (remote, org, project) => {
        expect(parseRemote('azure_devops', remote)).toEqual({ vendor: 'azure_devops', org, project });
    });

    it.each([
        ['github', null],
        ['github', 'https://github.com/just-an-owner'],
        ['github', 'https://gitlab.com/acme/widgets.git'],
        ['azure_devops', 'https://dev.azure.com/acme'],
        ['azure_devops', 'https://github.com/acme/widgets.git'],
        ['none', 'https://github.com/acme/widgets.git'],
    ] as const)('returns null for remotes it cannot read (%s, %s)', (vendor, remote) => {
        expect(parseRemote(vendor, remote)).toBeNull();
    });

    it('reads a workspace row', () => {
        const workspace: WorkspaceRow = { id: 1, path: 'c:\\ws\\widgets', git_remote: 'git@github.com:acme/widgets.git', vendor: 'github', settings: '{}' };
        expect(identityOf(workspace)).toEqual({ vendor: 'github', repo: 'acme/widgets' });
    });
});
