#!/usr/bin/env node
'use strict';
// Builds the folder `npm publish` ships. The repository root is private: its package.json
// declares devDependencies, and `npm ci` (which Claude Code runs inside an installed plugin,
// with a 60 s limit) refuses a lockfile that lacks them. So the published copy gets a manifest
// without devDependencies and a lockfile pruned to match, with versions exactly as tested.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'release');
const MANIFEST = 'package.json';
const LOCKFILE = 'package-lock.json';
const SHRINKWRAP = 'npm-shrinkwrap.json';
/** npm ships these whatever `files` says; copied so the staged folder is the whole package. */
const ALWAYS_SHIPPED = ['README.md', 'LICENSE'];
const BUILD_ENTRY = path.join('dist', 'cli-main.js');
/** Only the development checkout needs these. */
const DEV_ONLY_FIELDS = ['devDependencies', 'scripts', 'private'];
const ROOT_PACKAGE = '';

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** The lockfile without anything only development installs. Versions stay exactly as tested. */
function productionLock(lock, manifest) {
    const packages = {};
    Object.keys(lock.packages).forEach(key => {
        if (!lock.packages[key].dev) packages[key] = lock.packages[key];
    });
    const root = Object.assign({}, packages[ROOT_PACKAGE], { version: manifest.version });
    delete root.devDependencies;
    packages[ROOT_PACKAGE] = root;
    return Object.assign({}, lock, { version: manifest.version, packages });
}

function stageRelease(root = ROOT, out = DEFAULT_OUT) {
    if (!fs.existsSync(path.join(root, BUILD_ENTRY))) {
        throw new Error(`No build at ${path.join(root, BUILD_ENTRY)}: run npm run build first.`);
    }
    const manifest = readJson(path.join(root, MANIFEST));
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    // The shrinkwrap is listed in `files` so npm packs it, but it is generated here, not copied.
    manifest.files.filter(entry => entry !== SHRINKWRAP).concat(ALWAYS_SHIPPED).forEach(entry => {
        fs.cpSync(path.join(root, entry), path.join(out, entry), { recursive: true });
    });
    const published = Object.assign({}, manifest);
    DEV_ONLY_FIELDS.forEach(field => { delete published[field]; });
    writeJson(path.join(out, MANIFEST), published);
    writeJson(path.join(out, SHRINKWRAP), productionLock(readJson(path.join(root, LOCKFILE)), manifest));
    return out;
}

module.exports = { stageRelease, productionLock, SHRINKWRAP };

if (require.main === module) {
    const out = stageRelease();
    console.log(`Staged ${out}\nInspect with: npm pack "${out}" --dry-run   (publishing is a manual step in RELEASING.md)`);
}
