import { Vendor, WorkspaceRow } from '../ledger/types';

export interface GitHubIdentity { vendor: 'github'; repo: string }
export interface AzureIdentity { vendor: 'azure_devops'; org: string; project: string }
export type VendorIdentity = GitHubIdentity | AzureIdentity;

const GITHUB = /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
/** `https://[user@]dev.azure.com/<org>/<project>/_git/<repo>`; the project is omitted when it names the repo. */
const DEV_AZURE_HTTPS = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/(?:([^/]+)\/)?_git\/([^/]+?)\/?$/i;
const DEV_AZURE_SSH = /^(?:ssh:\/\/)?[^@/]+@ssh\.dev\.azure\.com(?::22)?[:/]v3\/([^/]+)\/([^/]+)\/[^/]+?\/?$/i;
const VISUALSTUDIO_HTTPS = /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?(?:([^/]+)\/)?_git\/([^/]+?)\/?$/i;
const VISUALSTUDIO_SSH = /^(?:ssh:\/\/)?[^@/]+@vs-ssh\.visualstudio\.com(?::22)?[:/]v3\/([^/]+)\/([^/]+)\/[^/]+?\/?$/i;
/** `?version=GBmain` and the like are browser state, not part of the repository's address. */
const URL_SUFFIX = /[?#].*$/;
const devAzureOrg = (org: string): string => `https://dev.azure.com/${org}`;
const visualStudioOrg = (org: string): string => `https://${org}.visualstudio.com`;

function decode(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

const azure = (org: string, project: string): AzureIdentity => ({ vendor: 'azure_devops', org, project: decode(project) });

/** The owner/repo (GitHub) or org URL + project (Azure DevOps) every vendor call must name (spec §8.1). */
export function parseRemote(vendor: Vendor, remote: string | null): VendorIdentity | null {
    if (remote === null) return null;
    const url = remote.trim().replace(URL_SUFFIX, '');
    if (vendor === 'github') {
        const match = url.match(GITHUB);
        return match ? { vendor, repo: `${match[1]}/${match[2]}` } : null;
    }
    if (vendor !== 'azure_devops') return null;
    let match = url.match(DEV_AZURE_HTTPS);
    if (match) return azure(devAzureOrg(match[1]), match[2] ?? match[3]);
    match = url.match(DEV_AZURE_SSH);
    if (match) return azure(devAzureOrg(match[1]), match[2]);
    match = url.match(VISUALSTUDIO_HTTPS);
    if (match) return azure(visualStudioOrg(match[1]), match[2] ?? match[3]);
    match = url.match(VISUALSTUDIO_SSH);
    if (match) return azure(visualStudioOrg(match[1]), match[2]);
    return null;
}

export function identityOf(workspace: WorkspaceRow): VendorIdentity | null {
    return parseRemote(workspace.vendor, workspace.git_remote);
}
