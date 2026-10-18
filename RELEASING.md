# Releasing GhostPM

There is one artifact: the npm package `ghostpm`.
- `npm install -g ghostpm` installs it.
- The Claude Code marketplace (`.claude-plugin/marketplace.json` on `master`) installs the same package as a plugin, through an `npm` source.

The repository root is `private`. What gets published is the staged `release/` folder: a manifest without devDependencies, plus a production `npm-shrinkwrap.json`. Claude Code runs `npm ci --ignore-scripts` on that lockfile and stops it after 60 seconds.

Pack and publish with npm 10 or 11: check `npm -v` first. `npm pack`, `npm run verify-release` and `npm publish` all need it, because npm 12 leaves `npm-shrinkwrap.json` out of the tarball (`npm run verify-release` stops and says so). `verify-release` packs and installs with the npm that runs it, so on npm 12 `npx -y npm@11 run verify-release` checks an npm 11 pack.

Developing on npm 12: the root `package.json` `allowScripts` pins `better-sqlite3@<version>`, so `npm ci` builds the addon and `npm test` works. When that dependency's locked version changes, update the pin (a test fails until you do). `npm run stage` strips the field from the published manifest.

The commands below are PowerShell, run from the repository root unless a step says otherwise. Where a step says `ghostpm`, use the 2.0 CLI: `node dist/cli-main.js` from this checkout, or `ghostpm` once 2.0 is installed globally.

## 1. Before publishing (maintainer or agent)

- [ ] `git status` is clean, and the release branch is merged into `master`.
- [ ] A clean install, the compiler and the whole suite, with no built-`dist/` suite skipped:

  ```powershell
  npm ci; npx tsc --noEmit; npm run build
  $result = Join-Path $env:TEMP 'ghostpm-jest.json'
  npx jest --json --outputFile $result
  # The built suites, derived rather than listed: every test file that skips itself when dist/ is missing.
  $built = Get-ChildItem -Recurse tests -Filter *.test.ts | Select-String -Pattern '\? describe : describe\.skip' -List | ForEach-Object Path
  $ran = (Get-Content $result -Raw | ConvertFrom-Json).testResults | Where-Object { $built -contains $_.name }
  "$($built.Count) built suites, $($ran.Count) ran"
  $ran.assertionResults | Where-Object status -ne 'passed' | ForEach-Object fullName
  ```

  Expected: jest reports every suite passed, the two counts are equal, and the last command prints nothing. The only skipped tests are platform-only ones (`itOnWindows`, `itOnPosix`, and doctor's PowerShell round trip where `pwsh` is missing).
- [ ] The hook stays cheap (spec §7.2, §15): `tests/hook/import-chain.test.ts` is one of the built suites above and passed. It runs real events through the built hook and fails if the MCP SDK, zod, js-yaml, a vendor adapter, the sync runner, `dist/surfaces/` or the statusline gets loaded.
- [ ] `npm run verify-release` prints `All N checks passed`, and the dependency install stays under 30 s. Run it twice: once with Node.js 22 first on `PATH` and once with Node.js 24 (with nvm: `nvm use <version>`). It reads the public npm registry into an empty scratch cache, works in a temporary home and publishes nothing.
- [ ] The versions agree: `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`, the npm source in `.claude-plugin/marketplace.release.json`, and the top `CHANGELOG.md` heading. `tests/version.test.ts` enforces this, for `(unreleased)` and for a dated heading alike; to bump, run `npm version <x.y.z> --no-git-tag-version` and edit the other three. The date itself is section 3's first step.

### Release gates an agent cannot check (you)

They need another OS, a real terminal, Azure DevOps, Claude Code itself or your consent. Record what you saw for each one.

- [ ] **POSIX: detached vendor calls, process-group kill, Ctrl+C.** On Linux or macOS, run `npm run build; npx jest tests/cli.test.ts` (its POSIX-only tests are skipped on Windows). Then, from the checkout, put a `gh` that hangs first on `PATH` and time a sync out. The fake `gh` never reaches GitHub, and the home is a scratch folder:

  ```sh
  GP="$PWD/dist/cli-main.js"
  F7=$(mktemp -d); mkdir -p "$F7/bin" "$F7/home" "$F7/repo"
  printf '#!/bin/sh\nsleep 600 &\nsleep 600\n' > "$F7/bin/gh"; chmod +x "$F7/bin/gh"
  export PATH="$F7/bin:$PATH" GHOSTPM_HOME="$F7/home" HOME="$F7/home" TMPDIR="$F7/home"
  cd "$F7/repo" && git init -q && git remote add origin https://github.com/example/ghostpm-f7.git
  node "$GP" config set sync_policy auto --workspace .
  node "$GP" sync                                         # ends once the 45 s vendor-call timeout fires
  ps -eo pid,pgid,args | grep 'sleep 600' | grep -v grep  # expected: nothing, the whole group was killed
  node "$GP" sync                                         # press Ctrl+C after a few seconds
  ps -eo pid,pgid,args | grep 'sleep 600' | grep -v grep  # record what is left (Phase 3 noted the in-flight call may survive)
  ```

- [ ] **Azure DevOps: the deleted-PR error and the `az repos pr create` output.** In a throwaway Azure DevOps project:
  - `az repos pr show --org https://dev.azure.com/<org> --id 999999` must fail with text containing `TF401232` or `does not exist`. That is how a pull is told a PR is gone rather than broken (`GONE` in `src/sync/azure.ts`).
  - In a Claude Code session with the plugin, have Claude run `az repos pr create …`. The printed output must contain the PR's web link, `https://…/pullrequest/<id>`, and `ghostpm standup --since 1h` must then list that PR. The hook records only that form (`PR_URL` in `src/hook/handlers.ts`).
- [ ] **Azure DevOps: GhostPM's markers survive.** In a workspace with sync on and a throwaway Azure DevOps remote, create a task and run `ghostpm sync`, then add a comment to it and sync again. `az boards work-item show --org https://dev.azure.com/<org> --id <id>` must still show the marker, `ghostpm:<16 hex digits>` inside a hidden `<span style="display:none">` (Azure DevOps strips HTML comments and may rewrite the style), in `System.Description` and, after the comment, in `System.History`. Without them, a retried create or comment is posted twice.
- [ ] **No console window flashes on Windows.** Watch the first session in section 2 start (it starts the detached addon build), and a session start in a workspace with sync on (it starts `ghostpm sync --background`, for example in the throwaway repo below). No console window may appear. Check from Windows Terminal and from VS Code.
- [ ] **Hook p95 under 150 ms on a populated ledger, on a quiet machine, on Node.js 22 and on Node.js 24** (spec §7.2, §15). Close other heavy programs. In a new PowerShell window in this checkout, put the Node.js to measure first on `PATH` (with nvm: `nvm use <version>`), run `npm ci; npm run build` with it (the SQLite addon must match that Node.js), then:

  ```powershell
  # These variables point GhostPM at a scratch home for this window only. Close the window afterwards.
  $p95 = Join-Path $env:TEMP 'ghostpm-p95'
  New-Item -ItemType Directory -Force $p95 | Out-Null
  $env:GHOSTPM_HOME = $p95; $env:HOME = $p95; $env:USERPROFILE = $p95
  # 5,000 tasks and their events, written through the built ledger code.
  node -e "const d = m => require('./dist/' + m); const db = d('ledger/db.js').openLedger(); const ws = d('ledger/workspaces.js').ensureWorkspace(db, process.env.GHOSTPM_HOME); for (let i = 0; i < 5000; i++) d('ledger/work.js').trackWork(db, { sessionId: 'seed-' + (i % 100), source: 'seed', workspaceId: ws.id, title: 'Seeded task ' + i, intent: 'implement' }); db.close();"
  $payload = @{ hook_event_name = 'UserPromptSubmit'; session_id = 'p95'; cwd = $p95; prompt = 'hi' } | ConvertTo-Json -Compress
  $ms = 1..200 | ForEach-Object { (Measure-Command { $payload | node dist/hook.js UserPromptSubmit | Out-Null }).TotalMilliseconds } | Sort-Object
  'p95: {0:N0} ms' -f $ms[189]
  Remove-Item -Recurse -Force $p95
  ```

  Afterwards, switch back to your everyday Node.js and run `npm ci; npm run build` again: a checkout whose plugin hooks load this `dist/` and `node_modules` cannot load an addon built for another Node.js.

- [ ] **End to end against a throwaway GitHub repository.** Only with the account owner's consent: it creates and deletes a real repository. The clone goes to a scratch folder outside this checkout, so run the 2.0 CLI by its full path (`node <checkout>\dist\cli-main.js`) unless 2.0 is installed globally.

  ```powershell
  $e2e = '<owner>/ghostpm-e2e'      # a repository you may create and delete
  $scratch = Join-Path $env:TEMP 'ghostpm-e2e-clone'
  New-Item -ItemType Directory -Force $scratch | Out-Null
  Set-Location $scratch
  gh repo create $e2e --private --clone
  Set-Location ghostpm-e2e
  ghostpm init                      # registers the folder and turns sync on (sync_policy auto)
  claude                            # "let's fix the login bug", then "mark it done", then exit
  ghostpm sync
  gh issue list --repo $e2e --state all --json number,title,state,labels
  ```

  Expected: the task became an issue, its phase label (`ghostpm:<phase>`) followed the phase, and "done" closed it. Rename the issue on GitHub, run `ghostpm sync`, and `ghostpm tasks --all` shows the new title. Clean up with `ghostpm unregister . --yes`, then `Set-Location $env:TEMP`, `Remove-Item -Recurse -Force $scratch` and `gh repo delete $e2e --yes`.
- [ ] **`ghostpm dashboard` in a real terminal**, in Windows Terminal: section 2's last check (resize, Ctrl+C, a new session within about a second, a task change shown within about a second), plus `ghostpm dashboard --once`, which prints one snapshot and exits.
- [ ] **A real `az boards query` with `@Today - 90`**, the query `ghostpm init` uses to learn an Azure DevOps process:

  ```powershell
  $org = 'https://dev.azure.com/<org>'; $project = '<project>'
  az boards query --org $org --project $project --wiql "SELECT [System.Id], [System.State], [System.WorkItemType] FROM workitems WHERE [System.TeamProject] = '$project' AND [System.ChangedDate] >= @Today - 90 ORDER BY [System.ChangedDate] DESC"
  ```

  Expected: a JSON list (empty is fine) and no error. Then `ghostpm init` in a clone of that project's repository learns `phase_state_map` (`ghostpm config get phase_state_map`), or says no work items changed in the last 90 days.
- [ ] **Claude Code loads the plugin's skill as `ghostpm:ghostpm`**, in the section 2 session and again after section 4's install.
- [ ] **`npm run verify-release` on Node.js 22 and on Node.js 24**: the bullet in the list above.

### Turning sync on for this machine's pinned workspaces, and back

On the development machine, the four GitHub workspaces imported from 1.4.0 are pinned to `sync_policy` `off`, so the live development hooks sync nothing. None of the gates above needs them. To include them in a deliberate end-to-end run, turn them on, and pin them again afterwards. Turning them on lets the live plugin write to those repositories' real trackers: `linked-only` touches only items that are already linked, `auto` creates an issue for every task.

```powershell
$pinned = '<repo folder 1>', '<repo folder 2>', '<repo folder 3>', '<repo folder 4>'
foreach ($repo in $pinned) { ghostpm config get sync_policy --workspace $repo }                 # expected: off
foreach ($repo in $pinned) { ghostpm config set sync_policy linked-only --workspace $repo }     # or auto
# … the end-to-end run …
foreach ($repo in $pinned) { ghostpm config set sync_policy off --workspace $repo }
```

Go back with `set … off`, not `ghostpm config unset sync_policy --workspace <path>`. These are 1.4.0 repositories: while no global `sync_policy` is stored, the next server start stamps an unset value with `linked-only` again, which syncs their linked items.

## 2. Try the exact tarball in Claude Code before publishing (you)

An agent cannot run these. They load the tarball as an inline plugin, with its dependencies installed the way Claude Code installs them. Replace `2.0.0` with the release version.

```powershell
npm run stage
$check = Join-Path $env:TEMP 'ghostpm-plugin-check'
if (Test-Path $check) { Remove-Item -Recurse -Force $check }
New-Item -ItemType Directory $check | Out-Null
npm pack ./release --pack-destination $check
tar -xzf (Join-Path $check 'ghostpm-2.0.0.tgz') -C $check
Push-Location (Join-Path $check 'package'); npm ci --ignore-scripts; Pop-Location
claude --plugin-dir (Join-Path $check 'package')
```

In that session:
- [ ] If `~/.ghostpm/native` did not exist yet, the first prompt shows "GhostPM is compiling its SQLite addon in the background…". Wait about a minute, then start a new session.
- [ ] `/mcp` shows the plugin's `ghostpm` server connected. Its tools include `track_work`, not `start_task`.
- [ ] The plugin's skill is loaded as `ghostpm:ghostpm`.
- [ ] "let's fix the login bug" makes Claude call `track_work`.
- [ ] "show the GhostPM dashboard" makes Claude call `get_project_state` with `all_workspaces` and show the dashboard.
- [ ] "what did I do in the last hour?" makes Claude call `timeline` with a `since`.
- [ ] Exit, then run `node (Join-Path $check 'package\dist\cli-main.js') dashboard` in Windows Terminal. The task shows, a new session appears within about a second, resizing redraws cleanly, and Ctrl+C gives the terminal back with the cursor visible.

## 3. Publish (maintainer)

npm goes first, because the marketplace entry on `master` names an npm version. The changelog is dated before staging, because `CHANGELOG.md` ships in the package. Replace `2.0.0` with the release version.

1. Date the release: in `CHANGELOG.md`, replace `(unreleased)` with the day you publish (for example `## 2.0.0 (2026-10-20)`). Then `npx jest tests/version.test.ts` and commit the release:

   ```powershell
   git add CHANGELOG.md
   git commit -m "Release GhostPM 2.0.0"
   ```

2. `npm login` if needed. Then `npm run stage`, which builds and stages the dated `CHANGELOG.md`.
3. `npm publish ./release` (npm asks for your 2FA code).
4. `npm view ghostpm@2.0.0 version` prints `2.0.0`, and `npm pack ghostpm@2.0.0 --dry-run` lists `CHANGELOG.md`, `npm-shrinkwrap.json`, `.claude-plugin/plugin.json`, `hooks/hooks.json` and `skills/ghostpm/SKILL.md`.
5. Point the marketplace at the published package, and commit:

   ```powershell
   Copy-Item .claude-plugin\marketplace.release.json .claude-plugin\marketplace.json -Force
   npx jest tests/version.test.ts
   git add .claude-plugin/marketplace.json
   git commit -m "Install GhostPM 2.0.0 from npm through the marketplace"
   ```

   From now on the repository's marketplace is the released one (`ghostpm`, npm source). A machine that installed the plugin from the development marketplace (`ghostpm-local`) switches over in section 4.
6. `git tag -a v2.0.0 -m "GhostPM 2.0.0"`, then `git push origin master v2.0.0`.
7. Optional: save the 2.0.0 section of `CHANGELOG.md` to `notes.md`, then `gh release create v2.0.0 --title "GhostPM 2.0.0" --notes-file notes.md`.

## 4. After publishing, install it the way a user would (you)

```powershell
# Only on a machine that used the development marketplace:
claude plugin uninstall ghostpm@ghostpm-local
claude plugin marketplace remove ghostpm-local

claude plugin marketplace add dpkay-io/ghostpm
# On npm 12 first: $env:npm_config_allow_remote='all' (Claude Code's `npm pack <url>` is refused otherwise)
claude plugin install ghostpm@ghostpm
claude plugin list
Test-Path (Join-Path $HOME '.claude\plugins\cache\ghostpm\ghostpm\2.0.0\node_modules\@modelcontextprotocol\sdk\package.json')
npm install -g ghostpm@2.0.0
ghostpm --version
ghostpm doctor
```

- [ ] `claude plugin list` shows `ghostpm@ghostpm` at 2.0.0, enabled.
- [ ] `Test-Path` prints `True`, which means Claude Code installed the dependencies from `npm-shrinkwrap.json`. If it prints `False`, use the contingency below.
- [ ] A new session behaves as in section 2, including the skill loaded as `ghostpm:ghostpm`.
- [ ] `ghostpm doctor` lists your 1.4.0 leftovers. Run the fixes you agree with. Afterwards, `ghostpm doctor` prints `No problems found.`

For later releases, users run `claude plugin marketplace update ghostpm`, then `claude plugin update ghostpm@ghostpm`.

## Contingency: the npm source installed no dependencies

Serve the same staged files from a git tag instead. For a git source too, Claude Code runs `npm ci --ignore-scripts` when `package.json` and `npm-shrinkwrap.json` sit at the plugin root.

```powershell
$repo = (Get-Location).Path
npm run stage
git worktree add --detach ..\ghostpm-plugin-build
Push-Location ..\ghostpm-plugin-build
git switch --orphan plugin-v2.0.0
Copy-Item -Recurse -Force (Join-Path $repo 'release\*') .
git add -A
git commit -m "Publish the GhostPM 2.0.0 plugin build"
git tag v2.0.0-plugin
git push origin v2.0.0-plugin
Pop-Location
git worktree remove ..\ghostpm-plugin-build --force
```

Then change the entry's `source` to `{ "source": "github", "repo": "dpkay-io/ghostpm", "ref": "v2.0.0-plugin" }` in `.claude-plugin/marketplace.json` and in `.claude-plugin/marketplace.release.json`. Change `tests/version.test.ts` to expect that source, commit, push `master`, and repeat section 4, starting with `claude plugin marketplace update ghostpm`.
