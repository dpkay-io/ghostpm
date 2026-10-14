#!/usr/bin/env node
'use strict';
// Proves the published artifact the way Claude Code installs it and the way a first plugin
// session runs it. Needs a fresh `npm run build`, Node.js at package.json's engines minimum or
// newer, and the network (the npm registry, and the better-sqlite3 prebuilt binary the bootstrap
// downloads). Every process it starts gets a scratch folder for its home, its temporary folder,
// LOCALAPPDATA and XDG_CACHE_HOME (where node-gyp would keep headers), an empty npm cache and
// empty npm config: ~/.ghostpm, ~/.claude, the user's caches and ~/.npmrc are never touched.
// Anything still running from the scratch folder at the end, such as the detached bootstrap, is
// stopped, pass or fail. Nothing is published.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { stageRelease, SHRINKWRAP } = require('./stage-release');

const ROOT = path.join(__dirname, '..');
// The bootstrap's own npm runner: one command line, absolute npm path, every argument checked first.
const { runNpm } = require(path.join(ROOT, 'dist', 'bootstrap.js'));

/** Claude Code kills the plugin dependency install at 60 s (plugins loading reference). */
const CLAUDE_CODE_INSTALL_LIMIT_MS = 60 * 1000;
/** Half of Claude Code's limit, as margin. */
const DEPENDENCY_BUDGET_MS = CLAUDE_CODE_INSTALL_LIMIT_MS / 2;
/** `npm ci` is stopped where Claude Code would stop it. ponytail: on Windows that ends cmd.exe; npm may outlive it. */
const NPM_CI_TIMEOUT_MS = CLAUDE_CODE_INSTALL_LIMIT_MS;
const BOOTSTRAP_TIMEOUT_MS = 5 * 60 * 1000;
/** Ample for one hook, CLI command or process listing (Claude Code gives a hook 5 s); a hung one fails its check instead. */
const COMMAND_TIMEOUT_MS = 30 * 1000;
/** Packing the staged files touches no network. */
const NPM_PACK_TIMEOUT_MS = COMMAND_TIMEOUT_MS;
const POLL_MS = 1000;
const WORK_PREFIX = 'ghostpm-verify-';
const WINDOWS = 'win32';
/** Every process with its command line. CIM, because wmic is gone from current Windows. */
const LIST_WINDOWS_PROCESSES = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }';
const MANIFEST = 'package.json';
const RELEASE_DIR = 'release';
const EXTRACT_DIR = 'extract';
/** npm pack puts every file under package/. */
const PACKAGE_DIR = 'package';
const TARBALL_EXTENSION = '.tgz';
const PLUGIN_COMPONENTS = [
    'package.json', 'npm-shrinkwrap.json', 'README.md', 'LICENSE', '.mcp.json', '.claude-plugin/plugin.json',
    'hooks/hooks.json', 'skills/ghostpm/SKILL.md', 'dist/cli-main.js', 'dist/hook.js', 'dist/mcp-server.js',
];
const NEVER_SHIPPED = ['src/', 'tests/', 'scripts/', 'docs/', 'bin/', 'node_modules/', 'package-lock.json'];
/** An installed plugin needs only its manifest from here; the marketplace files stay in the repository. */
const PLUGIN_META_DIR = '.claude-plugin/';
const PLUGIN_MANIFEST = `${PLUGIN_META_DIR}plugin.json`;
/** Claude Code installs only registry packages downloaded over https (plugins loading reference, dependency install limits). */
const HTTPS = 'https://';
const DEV_ONLY_PROBE = 'jest';
const REQUIRED_TOOLS = ['track_work', 'get_project_state', 'timeline'];
const TASK_TITLE = 'Release smoke task';
const TASK_INTENT = 'implement';
const TASK_CREATED = /^Created T\d+/;
const SESSION_ID = 'verify-release';
const STANDUP_WINDOW = '1h';
const DASHBOARD_HEADING = 'LIVE SESSIONS';
const STATUS_LABEL = 'Workspace:';
const DOCTOR_CLEAN = 'No problems found.';
const ESCAPE = '\u001b[';
/** `npm run` exports the user's cache and config paths as these; none may reach the npm calls made here. */
const NPM_CONFIG_ENV = /^npm_config_/i;

const results = [];

function check(name, ok, detail) {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Points everything a started process could reach outside `work` inside it. It changes this process's own
 * environment, so every child inherits it: npm, tar, the hooks, the detached bootstrap and its npm, and the
 * MCP server, whose start-up sweep reads the temporary folder.
 */
function isolate(work) {
    const home = path.join(work, 'home');
    const tmp = path.join(work, 'tmp');
    // Two files: npm refuses to load one file as both its user and its global config.
    const userNpmrc = path.join(work, 'user.npmrc');
    const globalNpmrc = path.join(work, 'global.npmrc');
    const localAppData = path.join(work, 'local-app-data');
    const xdgCache = path.join(work, 'xdg-cache');
    [home, tmp, localAppData, xdgCache].forEach(dir => fs.mkdirSync(dir));
    [userNpmrc, globalNpmrc].forEach(file => fs.writeFileSync(file, ''));
    Object.keys(process.env).filter(key => NPM_CONFIG_ENV.test(key)).forEach(key => { delete process.env[key]; });
    // The MCP server would take it as its workspace.
    delete process.env.CLAUDE_PROJECT_DIR;
    Object.assign(process.env, {
        // The node running this script first, as a user's PATH has one node for Claude Code, npm and the hooks: the
        // bootstrap's npm then fetches the addon for the node that loads it.
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
        HOME: home,
        USERPROFILE: home,
        GHOSTPM_HOME: path.join(home, '.ghostpm'),
        TEMP: tmp,
        TMP: tmp,
        TMPDIR: tmp,
        // node-gyp's header cache, should a prebuilt be missing: env-paths puts it under these.
        LOCALAPPDATA: localAppData,
        XDG_CACHE_HOME: xdgCache,
        npm_config_cache: path.join(work, 'npm-cache'),
        npm_config_userconfig: userNpmrc,
        npm_config_globalconfig: globalNpmrc,
    });
    return process.env.GHOSTPM_HOME;
}

/** Relative paths with forward slashes, the way npm lists a package's files. */
function filesUnder(dir) {
    return fs.readdirSync(dir, { recursive: true })
        .filter(file => fs.statSync(path.join(dir, file)).isFile())
        .map(file => file.split(path.sep).join('/'));
}

/**
 * Stops every process whose command line names the scratch folder, with everything it started: the hook starts
 * `<cli> bootstrap` detached and keeps no handle on it. Matches on the folder's own name, which mkdtemp makes unique
 * and ASCII. Answers how many it stopped.
 */
function stopLeftovers(work) {
    const marker = path.basename(work);
    const listing = process.platform === WINDOWS
        ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_WINDOWS_PROCESSES], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, windowsHide: true })
        : spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS });
    if (listing.error || listing.status !== 0) {
        const reason = listing.error ? listing.error.message : `exit ${listing.status}: ${String(listing.stderr || '').trim()}`;
        console.log(`WARNING: could not list processes (${reason}), so nothing was stopped. Look for processes still running from ${work}.`);
        return 0;
    }
    const pids = String(listing.stdout || '').split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.indexOf(marker) >= 0)
        .map(line => Number(line.split(' ')[0]))
        .filter(pid => pid !== process.pid);
    pids.forEach(pid => {
        if (process.platform === WINDOWS) {
            spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: COMMAND_TIMEOUT_MS, windowsHide: true });
            return;
        }
        try {
            // Detached made it a process group leader: the group takes npm and the compiler with it.
            process.kill(-pid, 'SIGKILL');
        } catch (error) {
            try { process.kill(pid, 'SIGKILL'); } catch (gone) { /* already exited */ }
        }
    });
    return pids.length;
}

/** The MCP SDK passes only a few variables on unless given the whole environment, as strings. */
function stringEnv() {
    const env = {};
    Object.keys(process.env).forEach(key => { if (process.env[key] !== undefined) env[key] = process.env[key]; });
    return env;
}

/** Runs every check in `work`; answers how long the dependency install took. */
async function verify(work) {
    const version = readJson(path.join(ROOT, MANIFEST)).version;
    const ghostpmHome = isolate(work);
    console.log(`Verifying ghostpm ${version} in ${work}\n`);

    // 1. Stage and pack exactly what `npm publish ./release` would upload, then unpack it the way Claude Code's cache holds it.
    const staged = stageRelease(ROOT, path.join(work, RELEASE_DIR));
    runNpm(['pack', '--pack-destination', '..', '--loglevel=warn'], staged, NPM_PACK_TIMEOUT_MS);
    const tarball = fs.readdirSync(work).find(file => file.endsWith(TARBALL_EXTENSION));
    fs.mkdirSync(path.join(work, EXTRACT_DIR));
    // Relative paths: GNU tar would read "C:" in an absolute Windows path as a remote host.
    execFileSync('tar', ['-xzf', tarball, '-C', EXTRACT_DIR], { cwd: work, timeout: COMMAND_TIMEOUT_MS });
    const pkg = path.join(work, EXTRACT_DIR, PACKAGE_DIR);
    const shipped = filesUnder(pkg);
    const manifest = readJson(path.join(pkg, MANIFEST));
    PLUGIN_COMPONENTS.forEach(file => check(`tarball contains ${file}`, shipped.indexOf(file) >= 0));
    manifest.files.forEach(entry => check(`tarball contains files entry ${entry}`, shipped.some(file => file === entry || file.indexOf(`${entry}/`) === 0)));
    NEVER_SHIPPED.forEach(prefix => check(`tarball has no ${prefix}`, !shipped.some(file => file.indexOf(prefix) === 0)));
    const meta = shipped.filter(file => file.indexOf(PLUGIN_META_DIR) === 0);
    check(`tarball has nothing in ${PLUGIN_META_DIR} but ${PLUGIN_MANIFEST}`, meta.length === 1 && meta[0] === PLUGIN_MANIFEST, meta.join(', '));
    check('the shipped manifest can be published (not private)', manifest.private === undefined);

    // 2. Install with Claude Code's command, within the limits it sets.
    check('the shipped manifest sets no npm overrides', manifest.overrides === undefined);
    const locked = readJson(path.join(pkg, SHRINKWRAP)).packages;
    const fetched = Object.keys(locked).filter(key => key !== '');
    check('every locked package downloads over https', fetched.every(key => String(locked[key].resolved).indexOf(HTTPS) === 0), `${fetched.length} packages`);
    const started = Date.now();
    let installError = '';
    try {
        runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], pkg, NPM_CI_TIMEOUT_MS);
    } catch (error) {
        installError = error.code || error.message;
    }
    const installMs = Date.now() - started;
    check('npm ci --ignore-scripts succeeds on the shipped shrinkwrap', installError === '', installError);
    check(`the dependency install stays under ${DEPENDENCY_BUDGET_MS} ms`, installMs < DEPENDENCY_BUDGET_MS, `${installMs} ms with an empty cache`);
    Object.keys(manifest.dependencies).forEach(dependency =>
        check(`installed ${dependency}`, fs.existsSync(path.join(pkg, 'node_modules', dependency, MANIFEST))));
    check('installed no development-only package', !fs.existsSync(path.join(pkg, 'node_modules', DEV_ONLY_PROBE)));

    // 3. A first plugin session.
    const workspace = path.join(work, 'workspace');
    fs.mkdirSync(workspace);
    const cliJs = path.join(pkg, 'dist', 'cli-main.js');
    const hookJs = path.join(pkg, 'dist', 'hook.js');
    const run = (script, args, input) => spawnSync(process.execPath, [script].concat(args),
        { cwd: workspace, input: input || '', encoding: 'utf8', windowsHide: true, timeout: COMMAND_TIMEOUT_MS });

    const printed = run(cliJs, ['--version']).stdout.trim();
    check('--version prints the package version', printed === version, printed);

    const { BOOTSTRAP_NOTICE } = require(path.join(pkg, 'dist', 'hook', 'recover.js'));
    const { bootstrappedBindingPath } = require(path.join(pkg, 'dist', 'ledger', 'binding.js'));
    const { LEDGER_FILE } = require(path.join(pkg, 'dist', 'ledger', 'db.js'));
    const sessionStart = JSON.stringify({ hook_event_name: 'SessionStart', session_id: SESSION_ID, cwd: workspace });
    const first = run(hookJs, ['SessionStart'], sessionStart);
    check('the first SessionStart exits 0', first.status === 0);
    check('the first SessionStart says the addon is being built', first.stdout.indexOf(BOOTSTRAP_NOTICE) >= 0, first.stdout.trim());

    const addon = bootstrappedBindingPath(ghostpmHome);
    const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS;
    while (!fs.existsSync(addon) && Date.now() < deadline) await sleep(POLL_MS);
    // ponytail: one more poll lets the copy that created the file finish; watch the bootstrap's exit if this ever flakes.
    await sleep(POLL_MS);
    const built = fs.existsSync(addon);
    check('the background bootstrap built the addon', built, built ? addon
        : `none after ${BOOTSTRAP_TIMEOUT_MS} ms; it may still be running. Run ${cliJs} bootstrap with this environment to see npm's output`);

    const second = run(hookJs, ['SessionStart'], sessionStart);
    check('the next SessionStart records into the ledger', second.status === 0 && fs.existsSync(path.join(ghostpmHome, LEDGER_FILE)));

    // 4. The MCP server a plugin session starts, driven by the SDK client the package itself ships.
    const { Client } = require(require.resolve('@modelcontextprotocol/sdk/client/index.js', { paths: [pkg] }));
    const { StdioClientTransport } = require(require.resolve('@modelcontextprotocol/sdk/client/stdio.js', { paths: [pkg] }));
    const { REMOVED_TOOLS } = require(path.join(pkg, 'dist', 'doctor.js'));
    const client = new Client({ name: SESSION_ID, version });
    try {
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [cliJs, 'serve'], cwd: workspace, env: stringEnv() }));
        const tools = (await client.listTools()).tools.map(tool => tool.name);
        check('the server offers the 2.0 tools', REQUIRED_TOOLS.every(name => tools.indexOf(name) >= 0), tools.join(', '));
        check('the server offers none of the removed tools', REMOVED_TOOLS.every(name => tools.indexOf(name) < 0));
        const created = (await client.callTool({ name: 'track_work', arguments: { title: TASK_TITLE, intent: TASK_INTENT } })).content[0].text;
        check('track_work creates a task', TASK_CREATED.test(created), created);
        const dashboard = (await client.callTool({ name: 'get_project_state', arguments: { all_workspaces: true } })).content[0].text;
        check('get_project_state with all_workspaces returns the dashboard', dashboard.indexOf(DASHBOARD_HEADING) >= 0 && dashboard.indexOf(TASK_TITLE) >= 0);
    } catch (error) {
        check('the MCP server answers', false, error.message);
    } finally {
        // Ends the server: the SDK closes its stdin, then terminates it if it lingers.
        await client.close();
    }

    // 5. The terminal commands, on the ledger that session wrote.
    const dash = run(cliJs, ['dashboard']);
    check('dashboard prints one plain snapshot without a terminal', dash.status === 0 && dash.stdout.indexOf(TASK_TITLE) >= 0 && dash.stdout.indexOf(ESCAPE) < 0);
    const standup = run(cliJs, ['standup', '--since', STANDUP_WINDOW]);
    check('standup reports the task', standup.status === 0 && standup.stdout.indexOf(TASK_TITLE) >= 0);
    const tasks = run(cliJs, ['tasks']);
    check('tasks lists it', tasks.status === 0 && tasks.stdout.indexOf(TASK_TITLE) >= 0);
    const status = run(cliJs, ['status']);
    check('status reads the workspace', status.status === 0 && status.stdout.indexOf(STATUS_LABEL) >= 0);
    const doctor = run(cliJs, ['doctor']);
    check('doctor finds nothing to fix in a clean home', doctor.status === 0 && doctor.stdout.trim() === DOCTOR_CLEAN, doctor.stdout.trim());
    return installMs;
}

async function main() {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), WORK_PREFIX));
    let installMs;
    try {
        installMs = await verify(work);
    } finally {
        // Pass, fail or throw: nothing the run started may outlive it.
        const stopped = stopLeftovers(work);
        if (stopped > 0) console.log(`Stopped ${stopped} process(es) still running from ${work}.`);
    }

    const failed = results.filter(ok => !ok).length;
    if (failed > 0) {
        console.log(`\n${failed} of ${results.length} checks failed. Left ${work} for inspection.`);
        process.exitCode = 1;
        return;
    }
    try {
        fs.rmSync(work, { recursive: true, force: true });
    } catch (error) {
        console.log(`(Could not remove ${work}: ${error.message})`);
    }
    console.log(`\nAll ${results.length} checks passed. The dependency install took ${installMs} ms.`);
}

module.exports = { stopLeftovers };

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
