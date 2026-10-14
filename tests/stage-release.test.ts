// tests/stage-release.test.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { removeTempDir } from './temp-dir';

interface StageModule {
    stageRelease(root: string, out: string): string;
    productionLock(lock: unknown, manifest: unknown): { packages: { [key: string]: { version?: string; devDependencies?: unknown } } };
    SHRINKWRAP: string;
}
// Plain JavaScript that node runs at release time, so it is required rather than imported.
const { stageRelease, productionLock, SHRINKWRAP } = require('../scripts/stage-release') as StageModule;

function writeFile(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
}

describe('stageRelease', () => {
    let root: string;
    let out: string;

    const manifest = () => ({
        name: 'ghostpm', version: '9.9.9', private: true, bin: { ghostpm: './dist/cli-main.js' },
        files: ['dist', '.claude-plugin/plugin.json', 'hooks', SHRINKWRAP],
        scripts: { build: 'tsc' },
        engines: { node: '>=22' },
        dependencies: { 'runtime-dep': '^1.0.0' },
        devDependencies: { 'dev-dep': '^2.0.0' },
    });

    const lock = () => ({
        name: 'ghostpm', version: '9.9.9', lockfileVersion: 3, requires: true,
        packages: {
            '': { name: 'ghostpm', version: '9.9.9', dependencies: { 'runtime-dep': '^1.0.0' }, devDependencies: { 'dev-dep': '^2.0.0' } },
            'node_modules/runtime-dep': { version: '1.2.3', resolved: 'https://registry.npmjs.org/runtime-dep/-/runtime-dep-1.2.3.tgz', integrity: 'sha512-x' },
            'node_modules/dev-dep': { version: '2.0.0', dev: true },
        },
    });

    const readOut = (file: string): any => JSON.parse(fs.readFileSync(path.join(out, file), 'utf8'));

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-stage-'));
        out = path.join(root, 'release');
        writeFile(path.join(root, 'package.json'), JSON.stringify(manifest()));
        writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock()));
        writeFile(path.join(root, 'dist', 'cli-main.js'), '// built');
        writeFile(path.join(root, '.claude-plugin', 'plugin.json'), '{}');
        writeFile(path.join(root, '.claude-plugin', 'marketplace.json'), '{}');
        writeFile(path.join(root, 'hooks', 'hooks.json'), '{}');
        writeFile(path.join(root, 'README.md'), '# readme');
        writeFile(path.join(root, 'LICENSE'), 'MIT');
    });

    afterEach(() => {
        removeTempDir(root);
    });

    it('publishes a manifest without what only development needs', () => {
        stageRelease(root, out);

        const published = readOut('package.json');
        expect(published.devDependencies).toBeUndefined();
        expect(published.scripts).toBeUndefined();
        expect(published.private).toBeUndefined();
        expect(published).toMatchObject({ name: 'ghostpm', version: '9.9.9', bin: { ghostpm: './dist/cli-main.js' }, engines: { node: '>=22' } });
        expect(published.files).toEqual(manifest().files);
    });

    it('prunes the lockfile to production packages at the tested versions (npm ci refuses a mismatch)', () => {
        stageRelease(root, out);

        const shrinkwrap = readOut(SHRINKWRAP);
        expect(Object.keys(shrinkwrap.packages).sort()).toEqual(['', 'node_modules/runtime-dep']);
        expect(shrinkwrap.packages[''].devDependencies).toBeUndefined();
        expect(shrinkwrap.packages['node_modules/runtime-dep'].version).toBe('1.2.3');
    });

    it('copies the listed plugin files and never the marketplace', () => {
        stageRelease(root, out);

        ['dist/cli-main.js', '.claude-plugin/plugin.json', 'hooks/hooks.json', 'README.md', 'LICENSE'].forEach(file =>
            expect(fs.existsSync(path.join(out, file))).toBe(true));
        expect(fs.existsSync(path.join(out, '.claude-plugin', 'marketplace.json'))).toBe(false);
    });

    it('replaces an earlier staging instead of adding to it', () => {
        writeFile(path.join(out, 'stale.txt'), 'old');

        stageRelease(root, out);

        expect(fs.existsSync(path.join(out, 'stale.txt'))).toBe(false);
    });

    it('refuses to stage without a build', () => {
        fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });

        expect(() => stageRelease(root, out)).toThrow('npm run build');
    });
});

describe('the repository lockfile', () => {
    it('prunes to exactly the runtime dependencies', () => {
        const repo = path.join(__dirname, '..');
        const repoManifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
        const pruned = productionLock(JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8')), repoManifest);

        Object.keys(repoManifest.dependencies).forEach(dependency =>
            expect(pruned.packages[`node_modules/${dependency}`]).toBeDefined());
        Object.keys(repoManifest.devDependencies).forEach(dependency =>
            expect(pruned.packages[`node_modules/${dependency}`]).toBeUndefined());
    });
});

const REPO = path.join(__dirname, '..');
const BUILT = fs.existsSync(path.join(REPO, 'dist', 'cli-main.js')) ? describe : describe.skip;

/** Every ${CLAUDE_PLUGIN_ROOT}/<file> a hook command or the MCP registration names. */
function referencedPluginFiles(stage: string): string[] {
    const read = (file: string): string => fs.readFileSync(path.join(stage, file), 'utf8');
    const pattern = /\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+)/g;
    const files: string[] = [];
    [read('hooks/hooks.json'), read('.mcp.json')].forEach(text => {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) files.push(match[1]);
    });
    return files;
}

BUILT('the staged real package', () => {
    let out: string;

    beforeAll(() => {
        out = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpm-stage-real-'));
        stageRelease(REPO, path.join(out, 'release'));
    });

    afterAll(() => {
        removeTempDir(out);
    });

    it('carries the skill, the manifests and every file the hooks and MCP registration run', () => {
        const stage = path.join(out, 'release');
        const referenced = referencedPluginFiles(stage);
        expect(referenced).toEqual(expect.arrayContaining(['dist/hook.js', 'dist/cli-main.js']));
        ['skills/ghostpm/SKILL.md', '.claude-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', 'npm-shrinkwrap.json', 'README.md', 'LICENSE']
            .concat(referenced)
            .forEach(file => expect(fs.existsSync(path.join(stage, file))).toBe(true));
    });

    it('names the shrinkwrap root as package.json does: name, version and license', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
        const shrinkwrap = JSON.parse(fs.readFileSync(path.join(out, 'release', SHRINKWRAP), 'utf8'));
        const identity = { name: manifest.name, version: manifest.version };

        expect(shrinkwrap).toMatchObject(identity);
        expect(shrinkwrap.packages['']).toMatchObject({ ...identity, license: manifest.license });
    });

    it('leaves out development files and the marketplace', () => {
        const stage = path.join(out, 'release');
        ['src', 'tests', 'package-lock.json', 'tsconfig.json', '.claude-plugin/marketplace.json'].forEach(file =>
            expect(fs.existsSync(path.join(stage, file))).toBe(false));
    });
});
