import * as fs from 'fs';
import * as path from 'path';
import { PACKAGE_JSON_PATH, packageVersion } from '../src/package-info';
import { SERVER_VERSION } from '../src/mcp-server';

const MANIFEST_PATH = path.join(__dirname, '..', 'package.json');
const MANIFEST = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as { version: string };

describe('package version', () => {
    it('comes from the package.json of the running copy', () => {
        expect(path.resolve(PACKAGE_JSON_PATH)).toBe(path.resolve(MANIFEST_PATH));
        expect(packageVersion()).toBe(MANIFEST.version);
    });

    it('is the version the MCP server announces', () => {
        expect(SERVER_VERSION).toBe(MANIFEST.version);
    });
});
