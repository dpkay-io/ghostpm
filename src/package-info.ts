import * as fs from 'fs';
import * as path from 'path';

/** package.json of the copy that is running: src/ (tests) and dist/ (installs) both sit one level below it. */
export const PACKAGE_JSON_PATH = path.join(__dirname, '..', 'package.json');

/** The MCP server's name: also what 1.4.0's `claude mcp add` registered. A leaf module so doctor need not load the MCP SDK. */
export const SERVER_NAME = 'ghostpm';

export interface PackageInfo {
    name: string;
    version: string;
    engines: { node: string };
    dependencies: { [name: string]: string };
}

/** engines.node as package.json writes it: `>=<major>`. */
const ENGINES_NODE = /^>=(\d+)$/;

let cached: PackageInfo | undefined;

export function packageInfo(): PackageInfo {
    if (cached === undefined) cached = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as PackageInfo;
    return cached;
}

/** The single version source: plugin.json, marketplace.json and the lockfile are checked against it by tests. */
export function packageVersion(): string {
    return packageInfo().version;
}

/** The oldest Node.js major this copy supports. package.json's engines is the one source; help, doctor and bootstrap say it. */
export function minimumNodeMajor(): number {
    const range = packageInfo().engines.node;
    const match = ENGINES_NODE.exec(range);
    if (match === null) throw new Error(`Unexpected engines.node "${range}" in ${PACKAGE_JSON_PATH}.`);
    return Number(match[1]);
}
