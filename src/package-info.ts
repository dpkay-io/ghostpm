import * as fs from 'fs';
import * as path from 'path';

/** package.json of the copy that is running: src/ (tests) and dist/ (installs) both sit one level below it. */
export const PACKAGE_JSON_PATH = path.join(__dirname, '..', 'package.json');

export interface PackageInfo {
    name: string;
    version: string;
    dependencies: { [name: string]: string };
}

let cached: PackageInfo | undefined;

export function packageInfo(): PackageInfo {
    if (cached === undefined) cached = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as PackageInfo;
    return cached;
}

/** The single version source: plugin.json, marketplace.json and the lockfile are checked against it by tests. */
export function packageVersion(): string {
    return packageInfo().version;
}
