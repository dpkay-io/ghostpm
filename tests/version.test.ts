import * as fs from 'fs';
import * as path from 'path';
import { PLUGIN_ID } from '../src/help';

const ROOT = path.join(__dirname, '..');
const readJson = (file: string): any => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const MANIFEST = readJson('package.json');
const NPM_SOURCE = 'npm';
/** The marketplace a release publishes. RELEASING.md copies it over .claude-plugin/marketplace.json once `npm publish` succeeded. */
const RELEASE_MARKETPLACE = '.claude-plugin/marketplace.release.json';

/** package.json is the single version source; everything else is held to it here. */
describe('one version everywhere', () => {
    it('plugin.json', () => {
        expect(readJson('.claude-plugin/plugin.json').version).toBe(MANIFEST.version);
    });

    it('the lockfile', () => {
        const lock = readJson('package-lock.json');
        expect(lock.version).toBe(MANIFEST.version);
        expect(lock.packages[''].version).toBe(MANIFEST.version);
    });

    it('the release marketplace installs exactly this version of this package from npm', () => {
        const [entry] = readJson(RELEASE_MARKETPLACE).plugins;
        expect(entry.source).toEqual({ source: NPM_SOURCE, package: MANIFEST.name, version: MANIFEST.version });
    });
});

describe('the release marketplace', () => {
    it('lists exactly this plugin, under the name in plugin.json', () => {
        expect(readJson(RELEASE_MARKETPLACE).plugins.map((plugin: { name: string }) => plugin.name)).toEqual([readJson('.claude-plugin/plugin.json').name]);
    });

    it('names the plugin the way help and doctor refer to it', () => {
        const marketplace = readJson(RELEASE_MARKETPLACE);
        expect(`${marketplace.plugins[0].name}@${marketplace.name}`).toBe(PLUGIN_ID);
    });
});
