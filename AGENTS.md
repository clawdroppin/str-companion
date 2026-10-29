# AGENTS.md: guide for AI agents and contributors

STR Companion is an Electron desktop app for **Windows and Linux (Proton/Steam Deck)**. It manages a user's **real Skyrim Special Edition install** for Skyrim Together Reborn (STR) co-op. Mistakes here can break someone's game or campaign saves, so the safety rules below are hard requirements.

## Commands

```bash
npm install
npm test                      # node:test suite in test/, uses fake game folders in the temp dir
npm start                     # run the app
npm run dist                  # Windows portable exe -> dist/STR-Companion-<version>.exe
npm run dist:linux            # Linux AppImage + tar.gz (run on Linux; CI does this)
node test/fixtures.js <dir>   # create a fake Proton-style install, prints its game folder

# Headless UI check: screenshots every page into <dir> plus report.json, then quits.
# Uses a throwaway profile, so it works even while the real app is open.
STRC_SHOTS=<dir> npm start
STRC_COMPARE_CODE=<STR2-…> STRC_SHOTS=<dir> npm start   # the Friends compare and Quick Setup steps use this code instead of your own
STRC_GAME_DIR=<fake game> STRC_SHOTS=<dir> npm start        # against a fixture instead of the real game
xvfb-run -a npx electron . --no-sandbox                     # (Linux CI) with the two env vars above
```

Before you finish any change: run `npm test` and `node scripts/ui-check.js` (add `--real "<game dir>"` locally). The runner opens the app as several kinds of user (fresh, free Nexus account, Premium account with a different host via the test-only `STRC_NEXUS_MOCK` stand-in), clicks every page and tab, runs a full Quick Setup in the Premium scenario, and fails on any broken page or hidden programming error (`window.__errors`). Then run the `STRC_SHOTS` check and confirm `report.json` shows the right `h1` and `"error": null` for every page. Look at the PNGs for layout problems. Screenshot mode renders offscreen, so frames are always current. CI (`.github/workflows/ci.yml`) runs the tests on Windows and Ubuntu, runs the Linux UI check against a fixture, and on a published release builds and attaches the downloads for both platforms.

## Cross-platform rules

- **Never hard-code path casing.** Linux file systems are case-sensitive, and tools disagree ("Plugins.txt" vs "plugins.txt"). Build game paths with `util.resolveCI(base, ...segments)`, or use the fields already resolved in `game.gamePaths()`.
- On Linux, Documents and LocalAppData are inside the **Proton prefix**: `<library>/steamapps/compatdata/489830/pfx/drive_c/users/steamuser/…`. `gamePaths()` handles this, including older Proton folder names. Don't use `app.getPath('documents')` on Linux.
- Process checks go through `util.runningProcesses()`. On Linux it parses `ps` output, where Proton programs keep their `.exe` names. Add names to `launch.PROCS` for both platforms.
- Windows `.exe` files run on Linux through `protontricks-launch --appid 489830` (native or Flatpak). The server may also use a native Linux binary or Wine. See `launch.js`.
- Guard Windows-only tools (`reg`, `tasklist`, `taskkill`, `cmd`) with `process.platform === 'win32'`.
- Vortex and MO2 don't exist on Linux, so their code paths must simply find nothing there.
- **Steam config files** (`localconfig.vdf`, `shortcuts.vdf`) are only written while Steam is closed (`closeSteam` in main.js, refused in Gaming Mode), always backed up to `_STRCompanion_Backup/steam-config/` first, and edited for every account in `userdata/`. The Play wrapper must keep the user's own launch options (`withWrapper`/`withoutWrapper` are idempotent).
- The wrapper is plain POSIX `sh` (SteamOS has no Node at launch time). Its save snapshots use the app's snapshot format; the app prunes them on start. Test it with the Linux-only wrapper test.
- Release asset names are fixed (`STR-Companion-SteamDeck.tar.gz`, `install-steamdeck.sh`, `SHA256SUMS.txt`): the installer and self-update download them via `releases/latest/download/…`. CI's `checksums` job writes SHA256SUMS after both builds.

## Layout

```
src/core/       Pure Node modules that touch the game. No Electron imports. Unit-tested, cross-platform.
  util.js       fs helpers, PE version reader, process list, moveFile
  ini.js        IniDoc: layout-, comment- and line-ending-preserving INI/TOML editor
  game.js       paths, Steam library detection, SKSE/Address Library/STR detection, Vortex manifests
  plugins.js    TES4 header parsing, Plugins.txt/loadorder.txt, effective load order, master checks
  cleanup.js    Creation Club report, plugin report, known-incompatible list
  backup.js     BackupStore: move-to-backup batches + manifest, restore, delete, save snapshots (async, auto-pruned), config snapshots
  installer.js  archive extraction (7-Zip), layout detection (Data vs game root vs FOMOD), registry
  fomod.js      runs FOMOD installers (ModuleConfig.xml, UTF-8/16) non-interactively with recommended options
  setup.js      Quick Setup: plan from a host's code, exact-version Nexus file picking, nxm:// link parsing
  vdf.js        Steam's text VDF (localconfig.vdf) and binary VDF (shortcuts.vdf), CRC-32 shortcut ids
  steamdeck.js  Deck/Gaming Mode detection, the strc-launch.sh Play wrapper, launch options, non-Steam shortcuts
  upnp.js       router discovery (SSDP), UDP port mapping, CGNAT / double-NAT classification
  report.js     bug-report zip (passwords stripped by sanitizeIni)
  selfupdate.js release asset choice, SHA256SUMS parsing, Windows swap script
  configs.js    config file registry, load (with metadata), save, presets
  health.js     snapshot() gathers state; checks() turns it into the dashboard list with fixes
  mods.js       catalog + Vortex + registry merge, Nexus update checks
  nexus.js      Nexus Mods v1 API client, downloads
  logs.js       server session parsing, client log problems, SKSE plugin load results, crash-report summaries
  launch.js     process status, launching client/server, Steam auto-update setting
  share.js      STR2- setup codes (deflate + base64url JSON, STR1- still parsed), comparison, load-order match plans
src/main/       Electron main process. main.js = IPC handlers (`handle('channel', fn)`), preload.js = bridge
src/renderer/   UI: index.html, styles.css, app.js (vanilla JS, one async function per page)
data/           catalog.json (mods), config-meta.json (friendly labels/types), presets.json
test/           core.test.js, fixtures.js (fake installs, also a CLI for CI)
scripts/        make-icon.js (renders build/icon.png), package-deck.sh (CI: Steam Deck tarball), install-steamdeck.sh (release asset: one-line installer)
build/          packaging resources (icon)
```

The renderer talks to the main process only through `api.call(channel, ...args)`. Handlers return `{ok, data}` or `{ok:false, error}`, and `call()` turns errors into toasts. Add new channels in `main.js` next to related ones. The renderer has no Node access (`contextIsolation`, `sandbox`).

## Safety rules (do not break)

1. **Never delete user files.** Anything removed from the game folder goes through `BackupStore.backup()` (a move plus a manifest entry). Uninstall is also a backup. The only `rmSync` calls are on the app's own temp and empty batch folders.
2. **Protected files:** `plugins.PROTECTED` (base masters, `_ResourcePack.esl`, STR plugins) and `plugins.FREE_CC` (the four free Creation Club masters that USSEP requires) must never be offered for removal. `_ResourcePack.esl` is listed in `Skyrim.ccc` but is base-game content.
3. **Preserve file identity and format:**
   - Write configs in place with `fs.writeFileSync(existingPath)`, never write-temp-and-rename. Vortex deploys with **hard links**, and replacing the inode would silently diverge from Vortex's staging copy.
   - Keep CRLF line endings. `IniDoc` round-trips byte for byte, and new files default to CRLF.
   - Before overwriting a file that isn't the app's own, **move** it to backup first. That breaks the hard link, so Vortex's copy is never modified.
4. **Snapshot before editing configs** (`backups.snapshotConfig`). INI edits are refused while Skyrim runs (`assertGameClosed`), because the game rewrites them on exit.
5. **Secrets:** the Nexus API key is stored only via `safeStorage` and only sent to `api.nexusmods.com`. Never return it to the renderer. `settings:set` returns only whitelisted fields.
6. **External links:** `shell:external` uses an allowlist regex. Keep it tight.
7. **Escape everything** rendered with `innerHTML` through `esc()`. Mod names, log lines, INI values and friends' setup codes are untrusted.
8. **nxm:// links can come from any website.** Only install from one without asking when the Quick Setup run is waiting for that exact mod id (`nxmWaiters`); otherwise the renderer must confirm (`nxm:incoming`).
9. **Contain paths.** Any relative path from the renderer, a manifest or an archive goes through `util.isInside(gameDir, …)` before files are moved or written.
10. **Don't block the main process** with big file copies; use `fs.promises` (snapshots, installs). A blocked main process freezes the window.
12. **Return complete shapes from IPC handlers.** Every branch of a handler returns the same fields (use a `base` object and spread it), because pages read them without guards. Quick Setup once crashed on a missing `nxm` field in an early return.
13. **Errors:** programming errors are logged to `userData/logs/app.log` (main: `logError`, window: `app:logError`) and included in bug reports. Throw plain `Error`s with user-readable messages for expected failures.
11. **Dialogs:** use `confirmBox()` / `modal(html, onMount, onDismiss)`; dismissal (Esc, backdrop, Cancel) must resolve the caller.

## Domain facts the code relies on

- Load order = base masters → `Skyrim.ccc` entries that exist on disk → active `Plugins.txt` entries (ESM-flagged first). See `effectiveLoadOrder`.
- Skyrim Together syncs by load order. **Every player needs identical plugins in identical order.** SKSE DLLs and loose assets only affect the local player.
- SKSE plugin DLLs are game-version specific. `logs.sksePluginResults` reads `Documents/My Games/Skyrim Special Edition/SKSE/skse64.log` to report what actually loaded.
- Vortex records Data mods in `Data/vortex.deployment.json` and root mods (SKSE) in `<game>/vortex.deployment.*.json`. Folder names encode the Nexus id and version (`game.parseModFolderName`).
- `SkyrimTogether.exe` has no version resource. The STR version comes from Vortex, or from `STServerOut.log`.
- `STServerOut.log` keeps the last session's players after the server exits, so only show players while the server process runs.
- `tp_client.log` spans several launches. Only the part after the last "Installing SKSE … startup hooks" line counts. `BehaviorVar` warnings are expected noise.
- Steam's `appmanifest_489830.acf` field `AutoUpdateBehavior` (1 = only update on launch) can only be edited while Steam is closed.
- Free Nexus accounts can't get download links from the API on their own. With the app registered for `nxm://` links (Quick Setup toggle; HKCU on Windows, an xdg `.desktop` file on Linux), a "Mod Manager Download" click delivers a one-time `key`/`expires` that `Nexus.downloadLinks(mod, file, nxm)` accepts. Without the handler, the app opens the page and watches the Downloads folder.
- Setup codes (STR2) carry `m`: every installed Nexus mod with its version and archive-name hint, so `setup.pickFile` can fetch the host's exact file (old versions included).

## Editing data files

- **catalog.json:** each mod has `id` (Nexus id), `category`, `desc`, `compat` (`safe` | `likely` | `test`), optional `detect` globs (relative to the game folder), `dll` (for load-status checks) and `versionLocked`. Only mark a mod `safe` with a source, such as the Tilted Online FAQ or the STR mod-compat tracker.
- **config-meta.json:** keyed by config id, then `"Section/key"`. Types are `bool` (true/false), `bool01` (1/0), `int`, `float`, `enum` (`options`: values or `[value, label]`), `secret` and `string`.
- **presets.json:** values are `"Section/key": "string value"`. Values must use the file's native format (`true`/`false` for STServer, `1`/`0` for Skyrim INIs).

## Style

Plain CommonJS and vanilla JS. Match the surrounding code: small functions, short comments that explain *why*, no frameworks. Add a test in `test/core.test.js` for any core behavior you change. Tests must only touch temp folders.
