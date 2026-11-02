'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

const util = require('../core/util');
const game = require('../core/game');
const plugins = require('../core/plugins');
const cleanup = require('../core/cleanup');
const configs = require('../core/configs');
const health = require('../core/health');
const logs = require('../core/logs');
const launch = require('../core/launch');
const share = require('../core/share');
const mods = require('../core/mods');
const { BackupStore } = require('../core/backup');
const { Installer, ARCHIVE_EXT } = require('../core/installer');
const { Nexus, modUrl, fileDownloadUrl, parseModRef, download, GAME } = require('../core/nexus');
const setup = require('../core/setup');
const steamdeck = require('../core/steamdeck');
const upnp = require('../core/upnp');
const report = require('../core/report');
const ai = require('../core/ai');
const aitools = require('../core/aitools');
const selfupdate = require('../core/selfupdate');
const { sevenZip } = require('../core/installer');
const { IniDoc } = require('../core/ini');

let win;
const appDataDir = () => app.getPath('userData');
const settingsFile = () => path.join(appDataDir(), 'settings.json');

const DEFAULT_SETTINGS = {
  gameDir: null, playerName: os.userInfo().username, customMods: [], checklist: {}, party: [],
  autoSnapshot: true, keepAutoSnapshots: 10, extraBackupDir: null, uiScale: 1,
};

function loadSettings() {
  const s = { ...DEFAULT_SETTINGS, ...util.readJson(settingsFile(), {}) };
  // Tests and CI point the app at a fake game folder without touching saved settings.
  if (process.env.STRC_GAME_DIR) s.gameDir = process.env.STRC_GAME_DIR;
  return s;
}
function saveSettings(s) {
  const out = { ...s };
  // Never persist the test override as the user's real game folder.
  if (process.env.STRC_GAME_DIR) out.gameDir = (util.readJson(settingsFile(), {}) || {}).gameDir || null;
  util.writeJson(settingsFile(), out);
}
function updateSettings(patch) {
  const s = { ...loadSettings(), ...patch };
  saveSettings(s);
  return s;
}

// Decrypting goes through the OS keyring, so keep the key in memory instead of decrypting per request.
let nexusKeyCache;
/**
 * Test-only stand-in for the Nexus API (STRC_NEXUS_MOCK=free|premium), so UI checks can exercise the
 * signed-in branches without a real key or network. Never active unless that variable is set.
 */
function mockNexus(kind) {
  const premium = kind === 'premium';
  return {
    apiKey: 'mock', configured: true,
    validate: async () => ({ name: 'Test account', is_premium: premium }),
    mod: async id => ({ name: `Mod ${id}`, version: '1.0', summary: 'Test mod', updated_time: new Date().toISOString() }),
    files: async () => ({ files: [{ file_id: 1, name: 'Main', file_name: 'Main-1-1-0-1700000000.7z', version: '1.0', category_name: 'MAIN', uploaded_timestamp: 1700000000 }] }),
    downloadLinks: async () => { throw new Error('Downloads are disabled in test mode'); },
  };
}
function makeNexus(key) {
  return process.env.STRC_NEXUS_MOCK ? mockNexus(process.env.STRC_NEXUS_MOCK) : new Nexus(key);
}

function nexusKey() {
  if (process.env.STRC_NEXUS_MOCK) return 'mock';
  if (nexusKeyCache !== undefined) return nexusKeyCache;
  const s = loadSettings();
  nexusKeyCache = null;
  if (s.nexusKeyEnc) {
    try { nexusKeyCache = safeStorage.decryptString(Buffer.from(s.nexusKeyEnc, 'base64')); } catch {}
  }
  return nexusKeyCache;
}

/** GET a small text resource with a timeout (public IP, GitHub release info). */
function fetchText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'STR-Companion', ...headers } }, res => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', d => { b += d; if (b.length > 1 << 20) req.destroy(new Error('Response too large')); });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Network request timed out')));
  });
}

function ctx() {
  const s = loadSettings();
  if (!s.gameDir || !game.isGameDir(s.gameDir)) throw new Error('NO_GAME');
  // On Linux the game's Documents folder is inside the Proton prefix, which gamePaths works out itself.
  const paths = game.gamePaths(s.gameDir, process.platform === 'win32' ? { documentsDir: app.getPath('documents') } : {});
  const backups = new BackupStore(paths);
  return { s, paths, backups, installer: new Installer(paths, appDataDir(), backups), nexus: makeNexus(nexusKey()) };
}

/** Folders made by hand before this app existed (e.g. _CoopBackup_2026-10-15/CreationClub) become restorable batches. */
function adoptLegacyBackups(c) {
  for (const e of util.listDir(c.paths.gameDir)) {
    if (!e.isDirectory() || !/^_CoopBackup_/i.test(e.name)) continue;
    const cc = util.findCaseInsensitive(path.join(c.paths.gameDir, e.name), 'CreationClub');
    if (cc) c.backups.adoptFolder(cc, { label: `Creation Club content (${e.name.replace(/^_CoopBackup_/, '')})`, category: 'creation-club' });
  }
}

/** The app's own log (userData/logs/app.log): errors with the action that hit them. Kept to ~1 MB. */
function appLogFile() {
  return path.join(appDataDir(), 'logs', 'app.log');
}
function logError(where, err) {
  try {
    const file = appLogFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { if (fs.statSync(file).size > 1 << 20) fs.renameSync(file, file + '.old'); } catch {}
    const msg = err && err.stack ? err.stack : String(err && err.message ? err.message : err);
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${app.getVersion()} ${where}: ${msg}
`);
  } catch { /* logging must never break the app */ }
}
process.on('uncaughtException', e => logError('uncaught', e));
process.on('unhandledRejection', e => logError('unhandled rejection', e));

// Expected failures (bad input, network) carry a plain message; anything else is a bug and gets logged.
const EXPECTED = new Set(['NO_GAME']);
// Every handler by channel, so the AI helper can use the app exactly the way the pages do.
const handlers = {};
function handle(channel, fn) {
  handlers[channel] = fn;
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      if (!EXPECTED.has(err.message) && (/^(TypeError|ReferenceError|RangeError|SyntaxError)$/.test(err.name) || process.env.STRC_LOG_ALL)) logError(channel, err);
      return { ok: false, error: err.message };
    }
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- app / game folder ----------
let detectedCache = null;
handle('app:init', async () => {
  const s = loadSettings();
  // Scanning Steam libraries spawns reg.exe; once per run is enough.
  const detected = detectedCache || (detectedCache = await game.detectGameDirs());
  // No folder yet, or the saved one is gone (game moved to another library): use what Steam reports.
  if ((!s.gameDir || !game.isGameDir(s.gameDir)) && detected.length) { s.gameDir = detected[0]; saveSettings(s); }
  const valid = !!s.gameDir && game.isGameDir(s.gameDir);
  if (valid) {
    const c = ctx();
    adoptLegacyBackups(c);
    // Snapshots taken by the Steam Deck Play wrapper are pruned here, since the wrapper is a plain shell script.
    try { c.backups.pruneAutoSnapshots(c.s.keepAutoSnapshots); } catch {}
  }
  return {
    gameDir: s.gameDir, valid, detected, playerName: s.playerName, hasNexusKey: !!nexusKey(), version: app.getVersion(),
    platform: process.platform,
    protonLauncher: process.platform === 'win32' ? null : !!launch.protonLauncher(),
  };
});

handle('game:pickDir', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Select your Skyrim Special Edition folder', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = r.filePaths[0];
  if (!game.isGameDir(dir)) throw new Error("That folder doesn't contain SkyrimSE.exe and a Data folder.");
  updateSettings({ gameDir: dir });
  adoptLegacyBackups(ctx());
  return dir;
});

const PUBLIC_SETTINGS = ['playerName', 'checklist', 'autoSnapshot', 'keepAutoSnapshots', 'extraBackupDir', 'uiScale'];
handle('settings:set', (patch = {}) => {
  patch = patch && typeof patch === 'object' ? patch : {};
  const allowed = {};
  for (const k of PUBLIC_SETTINGS) if (k in patch) allowed[k] = patch[k];
  if ('keepAutoSnapshots' in allowed) allowed.keepAutoSnapshots = Math.max(1, Math.min(100, Number(allowed.keepAutoSnapshots) || 10));
  if ('uiScale' in allowed) {
    allowed.uiScale = Math.max(0.7, Math.min(1.6, Number(allowed.uiScale) || 1));
    if (win && !win.isDestroyed()) win.webContents.setZoomFactor(allowed.uiScale);
  }
  // The extra backup folder is only ever set through the folder picker (settings:pickBackupDir); here it can just be cleared.
  if ('extraBackupDir' in allowed && allowed.extraBackupDir) delete allowed.extraBackupDir;
  const s = updateSettings(allowed);
  return Object.fromEntries(PUBLIC_SETTINGS.map(k => [k, s[k]]));
});

// ---------- dashboard ----------
function currentVersions(snap) {
  return { game: snap.gameVersion, str: snap.str.version };
}

handle('health:get', () => {
  const c = ctx();
  const snap = health.snapshot(c.paths);
  // First run: remember today's versions so a later Steam update can be spotted.
  if (!c.s.lastSeen && snap.gameVersion) updateSettings({ lastSeen: currentVersions(snap) });
  return {
    snapshot: {
      gameVersion: snap.gameVersion, skse: snap.skse, addressLibrary: snap.addressLibrary, str: snap.str,
      manager: snap.manager, pluginCount: snap.loadOrder.length, autoUpdate: snap.autoUpdate,
      ccRemovable: snap.cc.removable.length, ccKeep: snap.cc.keep.length,
    },
    checks: health.checks(c.paths, snap, c.backups, { lastSeen: c.s.lastSeen, crashAck: c.s.crashAck, clientCrashAck: c.s.clientCrashAck === snap.client.updatedAt }),
  };
});

handle('fix:run', async fix => {
  const c = ctx();
  switch (fix.action) {
    case 'backupCC': return backupCreationClub(c);
    case 'backupFiles': return c.backups.backup(fix.rels, { label: fix.label || 'Problem files', category: 'known-issue' });
    case 'restoreFiles': {
      const byBatch = {};
      for (const it of fix.items) (byBatch[it.batch] = byBatch[it.batch] || []).push(it.rel);
      let restored = 0;
      for (const [id, rels] of Object.entries(byBatch)) restored += c.backups.restore(id, rels).restored;
      // Restored free Creation Club files are loaded by the game automatically via Skyrim.ccc.
      return { restored };
    }
    case 'steamUpdateOnLaunch': await launch.setSteamAutoUpdate(c.paths, 1); return { done: true };
    case 'ackVersions': updateSettings({ lastSeen: currentVersions(health.snapshot(c.paths)) }); return { done: true };
    case 'activatePlugins': {
      const names = (fix.names || []).filter(n => plugins.PLUGIN_RE.test(n));
      c.backups.snapshotConfig(util.resolveCI(c.paths.localAppDir, 'Plugins.txt'));
      plugins.addToPluginsTxt(c.paths.localAppDir, names);
      return { done: true };
    }
    default: throw new Error(`Unknown fix ${fix.action}`);
  }
});

function backupCreationClub(c, only = null) {
  const report = cleanup.creationClubReport(c.paths);
  const items = report.removable.filter(i => !only || only.includes(i.plugin));
  const rels = items.flatMap(cleanup.relFilesFor);
  if (!rels.length) return { moved: 0 };
  return c.backups.backup(rels, { label: `Anniversary Edition content (${items.length} add-ons)`, category: 'creation-club' });
}

// ---------- cleanup ----------
handle('cleanup:report', () => {
  const c = ctx();
  return { cc: cleanup.creationClubReport(c.paths), plugins: cleanup.pluginReport(c.paths), issues: cleanup.knownIssues(c.paths), manager: game.modManager(c.paths) };
});
handle('cleanup:backupCC', only => backupCreationClub(ctx(), only));
handle('cleanup:backupPlugins', names => {
  const c = ctx();
  const report = cleanup.pluginReport(c.paths);
  const chosen = report.filter(p => names.includes(p.name) && !p.protected);
  const rels = chosen.flatMap(p => [p.name, ...p.archives].map(f => path.join('Data', f)));
  return c.backups.backup(rels, { label: chosen.length === 1 ? chosen[0].name : `${chosen.length} mods`, category: 'mods' });
});
handle('cleanup:setActive', async (name, active) => {
  const st = await launch.status();
  if (st.game || st.client) throw new Error('Close Skyrim first — it rewrites Plugins.txt when it exits.');
  if (!plugins.PLUGIN_RE.test(String(name))) throw new Error(`${name} isn't a plugin file name.`);
  const c = ctx();
  c.backups.snapshotConfig(util.resolveCI(c.paths.localAppDir, 'Plugins.txt'));
  if (active) plugins.addToPluginsTxt(c.paths.localAppDir, [name]);
  else {
    const file = util.resolveCI(c.paths.localAppDir, 'Plugins.txt');
    const entries = plugins.readPluginsTxt(file).map(e => e.name.toLowerCase() === name.toLowerCase() ? { ...e, active: false } : e);
    plugins.writePluginsTxt(file, entries);
  }
  return true;
});

// ---------- backups ----------
handle('backups:list', () => ctx().backups.list());
handle('backups:usage', () => ctx().backups.usage());
handle('backups:restore', (id, rels) => ctx().backups.restore(id, rels || null));
handle('backups:delete', id => ctx().backups.deleteBatch(id));
/** Config files the app edits, by file name, so an old version can find its way back. */
function configTargets(c) {
  const map = new Map(configs.configFiles(c.paths).map(f => [path.basename(f.file).toLowerCase(), f]));
  map.set('plugins.txt', { id: 'plugins', file: util.resolveCI(c.paths.localAppDir, 'Plugins.txt') });
  return map;
}
handle('backups:configHistory', () => {
  const c = ctx();
  const targets = configTargets(c);
  return c.backups.listConfigHistory().filter(v => targets.has(v.name.toLowerCase())).slice(0, 200);
});
handle('backups:restoreConfig', async id => {
  const c = ctx();
  const name = String(id).split('/').pop().replace(/\.\d+$/, '').toLowerCase();
  const t = configTargets(c).get(name);
  if (!t) throw new Error("The app doesn't know where that file belongs.");
  // Skyrim rewrites its INIs and Plugins.txt on exit, which would undo the restore.
  if (t.id !== 'server') await assertGameClosed(t.id === 'plugins' ? 'prefs' : t.id);
  return c.backups.restoreConfigVersion(id, t.file);
});
handle('backups:open', () => {
  const c = ctx();
  fs.mkdirSync(c.backups.root, { recursive: true });
  return shell.openPath(c.backups.root);
});

// ---------- configs ----------
handle('config:list', () => configs.configFiles(ctx().paths));
handle('config:load', id => configs.load(ctx().paths, id));
/** Skyrim rewrites its INIs when it exits, which would silently undo edits made while it runs. */
async function assertGameClosed(id) {
  if (!['prefs', 'skyrim', 'custom', 'enginefixes', 'displaytweaks'].includes(id)) return;
  const st = await launch.status();
  if (st.game || st.client) throw new Error('Close Skyrim first — it overwrites these settings when it exits.');
}

handle('config:save', async (id, changes) => {
  await assertGameClosed(id);
  const c = ctx();
  const r = configs.save(c.paths, id, changes, c.backups);
  return { ...r, serverRunning: id === 'server' ? (await launch.status()).server : false };
});
handle('config:presets', id => configs.presets(id, appDataDir()));
handle('config:applyPreset', async (id, name) => {
  await assertGameClosed(id);
  const c = ctx();
  const p = configs.presets(id, appDataDir()).find(x => x.name === name);
  if (!p) throw new Error('Preset not found');
  const r = configs.save(c.paths, id, configs.presetToChanges(p.values), c.backups);
  return { ...r, serverRunning: id === 'server' ? (await launch.status()).server : false };
});
handle('config:savePreset', (id, name) => {
  const c = ctx();
  const loaded = configs.load(c.paths, id);
  const values = {};
  for (const e of loaded.entries.filter(x => x.featured && !x.missing && x.type !== 'secret')) values[`${e.section}/${e.key}`] = e.value;
  configs.saveUserPreset(appDataDir(), id, name, values);
  return true;
});
handle('config:deletePreset', (id, name) => { configs.deleteUserPreset(appDataDir(), id, name); return true; });
handle('config:openFile', id => {
  const f = configs.configFiles(ctx().paths).find(x => x.id === id);
  return f && f.exists ? shell.openPath(f.file) : null;
});

// ---------- mods ----------
handle('mods:list', () => {
  const c = ctx();
  const skse = logs.sksePluginResults(c.paths).results;
  return { categories: mods.CATALOG.categories, compatLabels: mods.CATALOG.compatLabels, mods: mods.modList(c.paths, c.installer.registry(), c.s.customMods || [], skse), gameVersion: game.gameVersion(c.paths), hasNexusKey: c.nexus.configured };
});
handle('mods:checkUpdates', async () => {
  const c = ctx();
  if (!c.nexus.configured) throw new Error('Add your Nexus API key in Settings to check for updates.');
  return mods.checkUpdates(c.nexus, mods.modList(c.paths, c.installer.registry(), c.s.customMods || []));
});
handle('mods:addCustom', async (ref, category) => {
  const c = ctx();
  const id = parseModRef(ref);
  if (!id) throw new Error('Paste a Nexus link like https://www.nexusmods.com/skyrimspecialedition/mods/12604');
  let name = `Nexus mod ${id}`, desc = 'Added by you.';
  if (c.nexus.configured) {
    try { const info = await c.nexus.mod(id); name = info.name; desc = info.summary || desc; } catch {}
  }
  const list = (c.s.customMods || []).filter(m => m.id !== id);
  list.push({ id, name, desc, group: category || 'My mods', addedAt: new Date().toISOString() });
  updateSettings({ customMods: list });
  return { id, name };
});
handle('mods:removeCustom', id => {
  const s = loadSettings();
  updateSettings({ customMods: (s.customMods || []).filter(m => m.id !== id) });
  return true;
});
handle('mods:openNexus', (id, tab) => shell.openExternal(modUrl(id, tab)));
handle('mods:install', async id => {
  const c = ctx();
  if (!c.nexus.configured) return { manual: true };
  const user = await c.nexus.validate();
  if (!user.is_premium) return { manual: true };
  const file = await mods.bestFile(c.nexus, id);
  if (!file) throw new Error('No main file found on Nexus for this mod.');
  const links = await c.nexus.downloadLinks(id, file.file_id);
  if (!links || !links[0] || !/^https:/.test(links[0].URI)) throw new Error('Nexus did not return a download link.');
  // The file name comes from the server; never let it pick a folder.
  const dest = path.join(appDataDir(), 'downloads', path.basename(String(file.file_name || `${id}.7z`)));
  await download(links[0].URI, dest, p => send('progress', { id, p }));
  try {
    const info = await c.nexus.mod(id);
    return await c.installer.installArchive(dest, { name: info.name, nexusId: id, version: file.version || info.version });
  } finally {
    fs.rm(dest, { force: true }, () => {});
  }
});
handle('mods:pickArchive', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Pick a mod archive', properties: ['openFile'], filters: [{ name: 'Mod archives', extensions: ['7z', 'zip', 'rar'] }] });
  return r.canceled ? null : r.filePaths[0];
});
handle('mods:installArchive', async (file, meta) => ctx().installer.installArchive(file, meta || {}));
handle('mods:uninstall', key => ctx().installer.uninstall(key));
handle('mods:registry', () => ctx().installer.registry());

/**
 * Waits for a new mod archive to finish downloading into the Downloads folder (its size stops changing).
 * Returns { promise, cancel }; the promise resolves to { file, size } or rejects on cancel/timeout.
 */
function watchDownloads(timeoutMs = 15 * 60 * 1000) {
  const dir = app.getPath('downloads');
  const started = Date.now();
  const sizes = new Map();
  let timer, rejectFn;
  const promise = new Promise((resolve, reject) => {
    rejectFn = reject;
    timer = setInterval(() => {
      if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('Gave up waiting for the download')); return; }
      for (const e of util.listDir(dir)) {
        if (!e.isFile() || !ARCHIVE_EXT.test(e.name)) continue;
        const full = path.join(dir, e.name);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.mtimeMs < started - 5000) continue;
        if (sizes.get(full) === st.size && st.size > 0) { clearInterval(timer); resolve({ file: full, size: st.size }); return; }
        sizes.set(full, st.size);
      }
    }, 2000);
  });
  return { promise, cancel: () => { clearInterval(timer); rejectFn(new Error('Cancelled')); } };
}

// Watches the Downloads folder after the user starts a Nexus manual download, so the file can be installed in one click.
let manualWatch = null;
handle('downloads:watch', (modId, name) => {
  if (manualWatch) manualWatch.cancel();
  manualWatch = watchDownloads();
  manualWatch.promise.then(({ file, size }) => send('download:found', { file, modId, name, size })).catch(() => {});
  return app.getPath('downloads');
});
handle('downloads:stop', () => { if (manualWatch) manualWatch.cancel(); manualWatch = null; return true; });

// ---------- Nexus key ----------
handle('nexus:setKey', async key => {
  key = String(key || '').trim();
  if (!key) { updateSettings({ nexusKeyEnc: null }); nexusKeyCache = null; return { cleared: true }; }
  const user = await makeNexus(key).validate();
  if (!safeStorage.isEncryptionAvailable()) throw new Error(process.platform === 'win32' ? 'Windows secure storage is unavailable, so the key cannot be saved safely.' : 'No system keyring is available (install gnome-keyring or KWallet), so the key cannot be saved safely.');
  updateSettings({ nexusKeyEnc: safeStorage.encryptString(key).toString('base64') });
  nexusKeyCache = key;
  return { name: user.name, premium: !!user.is_premium };
});
handle('nexus:status', async () => {
  const k = nexusKey();
  if (!k) return { configured: false };
  try { const u = await makeNexus(k).validate(); return { configured: true, name: u.name, premium: !!u.is_premium }; }
  catch (e) { return { configured: true, error: e.message }; }
});
handle('nexus:openKeyPage', () => shell.openExternal('https://next.nexusmods.com/settings/api-keys'));

// ---------- play / server ----------
handle('launch:status', () => launch.status());
handle('launch:client', async () => {
  const c = ctx();
  const st = await launch.status();
  if (st.game || st.client) throw new Error('Skyrim is already running.');
  // Linux with the Play wrapper set up: start through Steam, which runs Skyrim Together under Proton.
  let viaSteam = false;
  if (process.platform === 'linux') {
    try { viaSteam = playWrapperState(c, await steamRoot()).launchOptionSet && !steamdeck.flags(c.paths.gameDir).solo; } catch {}
  }
  // A copy of the saves before every session, so a bad sync or crash can always be undone
  // (the Play wrapper takes its own when that's switched on there).
  let snapshot = null;
  const wrapperSnapshots = viaSteam && steamdeck.flags(c.paths.gameDir).autoSnapshot;
  if (c.s.autoSnapshot && !wrapperSnapshots && util.walkFiles(c.paths.saves).length) {
    try {
      snapshot = await c.backups.snapshotSaves('Automatic, before launch', { auto: true, keepAuto: c.s.keepAutoSnapshots, mirrorDir: c.s.extraBackupDir });
    } catch (e) {
      snapshot = { error: e.message };
    }
  }
  if (viaSteam) {
    launch.openSteamUrl(`steam://rungameid/${game.APP_ID}`);
    return { steamStarted: !st.steam, snapshot, viaSteam: true };
  }
  if (!st.steam) launch.openSteam();
  launch.launchClient(c.paths);
  return { steamStarted: !st.steam, snapshot };
});
handle('launch:server', () => { launch.launchServer(ctx().paths); return true; });
handle('launch:stopServer', () => launch.stopServer());
handle('launch:restartServer', async () => {
  await launch.stopServer();
  for (let i = 0; i < 20 && (await launch.status()).server; i++) await new Promise(r => setTimeout(r, 250));
  launch.launchServer(ctx().paths);
  return true;
});

// ---------- save snapshots ----------
handle('saves:list', () => ctx().backups.listSaveSnapshots());
handle('saves:snapshot', note => { const c = ctx(); return c.backups.snapshotSaves(note || '', { mirrorDir: c.s.extraBackupDir }); });
handle('settings:pickBackupDir', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Pick a folder for an extra copy of every save snapshot', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  updateSettings({ extraBackupDir: r.filePaths[0] });
  return r.filePaths[0];
});
handle('saves:delete', id => ctx().backups.deleteSaveSnapshot(id));
handle('saves:restore', async id => {
  const st = await launch.status();
  if (st.game || st.client) throw new Error('Close Skyrim before restoring saves.');
  return ctx().backups.restoreSaveSnapshot(id);
});
handle('saves:open', () => shell.openPath(ctx().paths.saves));

// ---------- app updates (GitHub releases) ----------
const REPO = 'clawdroppin/str-companion';
/** The newest GitHub release. A bad answer is a network problem, not a bug in the app. */
async function latestRelease() {
  const r = await fetchText(`https://api.github.com/repos/${REPO}/releases/latest`, { Accept: 'application/vnd.github+json' });
  if (r.status !== 200) throw new Error("Couldn't reach GitHub.");
  try { return JSON.parse(r.body); } catch { throw new Error("GitHub's answer couldn't be read."); }
}
handle('app:checkUpdate', async () => {
  let rel;
  try { rel = await latestRelease(); } catch { return { hasUpdate: false }; }
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  const url = /^https:\/\/github\.com\//.test(rel.html_url) ? rel.html_url : `https://github.com/${REPO}/releases/latest`;
  return { latest, url, hasUpdate: !!latest && util.compareVersions(latest, app.getVersion()) > 0, canSelfUpdate: !!(process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE) };
});
handle('server:session', () => logs.serverSession(ctx().paths));
handle('net:info', () => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
  return { local: ips };
});
handle('net:publicIp', async () => {
  const r = await fetchText('https://api.ipify.org');
  const ip = r.body.trim();
  if (r.status !== 200 || !/^[\d.]+$|^[0-9a-f:]+$/i.test(ip)) throw new Error("Couldn't look up your public IP right now.");
  return ip;
});

// ---------- logs ----------
handle('logs:list', () => logs.logFiles(ctx().paths));
handle('logs:tail', id => {
  const f = logs.logFiles(ctx().paths).find(l => l.id === id);
  return f && f.exists ? logs.tail(f.file, 300) : '';
});
handle('logs:open', id => {
  const f = logs.logFiles(ctx().paths).find(l => l.id === id);
  return f && f.exists ? shell.openPath(f.file) : null;
});
handle('logs:crashes', () => {
  const c = ctx();
  const order = plugins.effectiveLoadOrder(c.paths.gameDir, c.paths.localAppDir).order.map(p => p.name);
  const client = logs.clientLog(c.paths);
  return {
    reports: logs.crashReports(c.paths, order),
    clientCrashed: client.crashed,
    clientLogAt: client.updatedAt,
    ack: c.s.crashAck || null,
  };
});
handle('logs:openCrash', file => {
  // Only open files that really are crash logs we listed.
  const hit = logs.crashFiles(ctx().paths).find(f => f.file === file);
  return hit ? shell.openPath(hit.file) : null;
});
handle('logs:ackCrashes', () => {
  const c = ctx();
  updateSettings({ crashAck: new Date().toISOString(), clientCrashAck: logs.clientLog(c.paths).updatedAt });
  return true;
});

// ---------- friends sync ----------
/** Nexus ids of the mods my plugins came from (Vortex or this app), so friends get download links. */
function nexusIdsFor(c, pluginNames) {
  const want = new Set(pluginNames.map(n => n.toLowerCase()));
  const ids = {};
  for (const m of game.vortexMods(c.paths)) {
    if (!m.nexusId) continue;
    for (const f of m.files) {
      const base = path.basename(f);
      if (want.has(base.toLowerCase())) ids[base] = m.nexusId;
    }
  }
  for (const r of Object.values(c.installer.registry())) {
    if (!r.nexusId) continue;
    for (const p of r.plugins || []) if (want.has(p.toLowerCase())) ids[p] = r.nexusId;
  }
  return ids;
}

/** Every installed Nexus mod (Vortex, this app, or detected by its files), keyed by Nexus id. */
function installedMods(c) {
  const map = new Map();
  for (const v of game.vortexMods(c.paths)) {
    if (v.nexusId) map.set(v.nexusId, { nexusId: v.nexusId, version: v.version, name: v.name, fileHint: v.name, manager: 'Vortex' });
  }
  for (const r of Object.values(c.installer.registry())) {
    if (r.nexusId && !map.has(r.nexusId)) map.set(r.nexusId, { nexusId: r.nexusId, version: r.version, name: r.name, fileHint: String(r.fileName || '').replace(ARCHIVE_EXT, ''), manager: 'STR Companion' });
  }
  for (const m of mods.modList(c.paths, c.installer.registry(), [])) {
    if (m.id && m.installed && !map.has(m.id)) map.set(m.id, { nexusId: m.id, version: m.installedVersion || null, name: m.name, fileHint: '', manager: m.manager || 'Manual' });
  }
  return map;
}

function mySetup(c, snap = health.snapshot(c.paths)) {
  const pluginNames = snap.loadOrder.map(p => p.name);
  return {
    playerName: c.s.playerName,
    gameVersion: snap.gameVersion,
    strVersion: snap.str.version,
    skseVersion: snap.skse.installed ? snap.skse.version : null,
    addressLibrary: snap.addressLibrary.matchesGame,
    plugins: pluginNames,
    sksePlugins: snap.sksePlugins,
    nexusIds: nexusIdsFor(c, pluginNames),
    mods: [...installedMods(c).values()],
  };
}

function localPlugins(c, snap) {
  return {
    onDisk: [...snap.loadOrder.map(p => p.name), ...snap.inactive],
    implicit: snap.loadOrder.filter(p => p.source !== 'plugins.txt').map(p => p.name),
  };
}

handle('share:mine', () => { const m = mySetup(ctx()); return { code: share.makeCode(m), setup: m }; });
handle('share:compare', code => {
  const c = ctx();
  const snap = health.snapshot(c.paths);
  const mine = mySetup(c, snap);
  const theirs = share.parseCode(code);
  return { theirs, diffs: share.compare(mine, theirs), plan: share.matchPlan(mine, theirs, localPlugins(c, snap)) };
});

/** Rewrites Plugins.txt to match a friend's load order. Plugins.txt is snapshotted first; nothing is deleted. */
handle('share:applyMatch', async code => {
  const c = ctx();
  const st = await launch.status();
  if (st.game || st.client) throw new Error('Close Skyrim first — it rewrites Plugins.txt when it exits.');
  const snap = health.snapshot(c.paths);
  const theirs = share.parseCode(code);
  const plan = share.matchPlan(mySetup(c, snap), theirs, localPlugins(c, snap));
  const file = util.resolveCI(c.paths.localAppDir, 'Plugins.txt');
  const snapshot = c.backups.snapshotConfig(file);
  plugins.applyLoadOrder(c.paths.gameDir, c.paths.localAppDir, plan.order);
  return { ...plan, snapshot, manager: snap.manager };
});

// Party roster: friends' setup codes kept between sessions, re-checked against my setup on every visit.
handle('party:list', () => {
  const c = ctx();
  const snap = health.snapshot(c.paths);
  const mine = mySetup(c, snap);
  return (c.s.party || []).map(m => {
    try {
      const theirs = share.parseCode(m.code);
      const diffs = share.compare(mine, theirs);
      return { ...m, theirs: { ...theirs, plugins: theirs.plugins.length }, errors: diffs.filter(d => d.level === 'error').length, warnings: diffs.filter(d => d.level !== 'error').length };
    } catch (e) {
      return { ...m, invalid: e.message };
    }
  });
});
handle('party:save', code => {
  const theirs = share.parseCode(code);
  const s = loadSettings();
  const name = (theirs.playerName || 'Friend').slice(0, 40);
  const party = (s.party || []).filter(m => m.name !== name);
  party.push({ name, code: String(code).trim(), savedAt: new Date().toISOString() });
  updateSettings({ party });
  return { name };
});
handle('party:remove', name => {
  const s = loadSettings();
  updateSettings({ party: (s.party || []).filter(m => m.name !== name) });
  return true;
});

/** A ready-to-paste invite for the group chat: address, password and my setup code. */
handle('share:invite', publicIp => {
  const c = ctx();
  const ini = new IniDoc(util.readText(game.strInfo(c.paths).configFile, ''));
  const port = ini.get('GameServer', 'uPort') || '10578';
  const password = ini.get('GameServer', 'sPassword') || '';
  const code = share.makeCode(mySetup(c));
  const ip = /^[\d.]+$|^[0-9a-f:]+$/i.test(String(publicIp || '')) ? publicIp : '<my IP>';
  return [
    'Skyrim Together tonight!',
    `Server: ${ip}:${port}`,
    password ? `Password: ${password}` : 'No password',
    'Paste my setup code into STR Companion (Friends Sync) to check your mods match:',
    code,
  ].join('\n');
});

// ---------- Nexus "Mod Manager Download" links (nxm://) ----------
// Free Nexus accounts can't download through the API, but every "Mod Manager Download" click hands the
// registered mod manager an nxm:// link with a one-time key. Registering for those links is what lets
// free accounts install with one click per mod.

const LINUX_DESKTOP = 'str-companion-nxm.desktop';

/** How this copy of the app is started, for the OS to launch it with an nxm:// link. */
function launchCommand() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return { exe: process.env.PORTABLE_EXECUTABLE_FILE, args: [] }; // Windows portable exe
  if (process.env.APPIMAGE) return { exe: process.env.APPIMAGE, args: [] };
  if (app.isPackaged) return { exe: process.execPath, args: [] };
  return { exe: process.execPath, args: [path.resolve(app.getAppPath())] }; // npm start (development)
}

/** Whether nxm:// links come to this app, and which other program has them otherwise (e.g. Vortex). */
async function nxmStatus() {
  if (process.platform === 'win32') {
    const { exe, args } = launchCommand();
    const registered = app.isDefaultProtocolClient('nxm', exe, args);
    let owner = null, ownerMissing = false;
    if (!registered) {
      const r = await util.run('reg', ['query', 'HKCR\\nxm\\shell\\open\\command', '/ve']);
      const m = r.stdout.match(/REG_SZ\s+(.+)/);
      if (m) {
        // Name the program, and notice when it points at a file that no longer exists.
        const exe = (m[1].match(/^"([^"]+)"/) || m[1].match(/^(\S+)/) || [])[1] || '';
        owner = /vortex/i.test(exe) ? 'Vortex' : /modorganizer|nxmhandler/i.test(exe) ? 'Mod Organizer 2' : (path.win32.basename(exe).replace(/\.exe$/i, '') || 'another program');
        ownerMissing = !!exe && !util.exists(exe);
      }
    }
    return { registered, owner, ownerMissing };
  }
  const r = await util.run('xdg-mime', ['query', 'default', 'x-scheme-handler/nxm']);
  const current = r.stdout.trim();
  return { registered: current === LINUX_DESKTOP, owner: current && current !== LINUX_DESKTOP ? current.replace(/\.desktop$/, '') : null };
}

async function setNxmHandler(on) {
  const { exe, args } = launchCommand();
  if (process.platform === 'win32') {
    const ok = on ? app.setAsDefaultProtocolClient('nxm', exe, args) : app.removeAsDefaultProtocolClient('nxm', exe, args);
    if (!ok) throw new Error('Windows refused to change the nxm:// link handler.');
    return nxmStatus();
  }
  const dir = path.join(os.homedir(), '.local', 'share', 'applications');
  const file = path.join(dir, LINUX_DESKTOP);
  if (on) {
    const quote = s => `"${String(s).replace(/(["\\`$])/g, '\\$1')}"`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, [
      '[Desktop Entry]', 'Type=Application', 'Name=STR Companion (Nexus links)', 'NoDisplay=true',
      `Exec=${[exe, ...args].map(quote).join(' ')} %u`, 'MimeType=x-scheme-handler/nxm;', '',
    ].join('\n'));
    const r = await util.run('xdg-mime', ['default', LINUX_DESKTOP, 'x-scheme-handler/nxm']);
    if (!r.ok) throw new Error('xdg-mime is needed to register for Nexus links (install xdg-utils).');
  } else if (util.exists(file)) {
    fs.rmSync(file, { force: true });
  }
  return nxmStatus();
}

handle('nxm:status', () => nxmStatus());
handle('nxm:set', on => setNxmHandler(!!on));

// Links the setup wizard is waiting for, by Nexus mod id.
const nxmWaiters = new Map();
let pendingNxm = [];

function handleNxmUrl(url) {
  const link = setup.parseNxm(url);
  if (!link || link.game !== GAME) return;
  const waiter = nxmWaiters.get(link.modId);
  if (waiter) { nxmWaiters.delete(link.modId); waiter.resolve(link); return; }
  // Not something the wizard asked for: any website can open nxm:// links, so the user confirms first.
  if (win && !win.isDestroyed() && win.webContents.getURL()) send('nxm:incoming', { url, modId: link.modId, fileId: link.fileId });
  else pendingNxm.push(url);
}

function nxmFromArgv(argv) {
  return argv.find(a => /^nxm:\/\//i.test(a)) || null;
}

async function downloadAndInstall(c, modId, fileId, nxm, meta, onProgress) {
  const links = await c.nexus.downloadLinks(modId, fileId, nxm);
  const link = links && links[0] && links[0].URI;
  if (!link || !/^https:/.test(link)) throw new Error('Nexus did not return a download link.');
  const fileName = path.basename(decodeURIComponent(new URL(link).pathname)) || `${modId}-${fileId}.7z`;
  const dest = path.join(appDataDir(), 'downloads', fileName);
  await download(link, dest, onProgress);
  try {
    return await c.installer.installArchive(dest, meta);
  } finally {
    fs.rm(dest, { force: true }, () => {});
  }
}

// An nxm link the user confirmed (clicked "Mod Manager Download" outside the wizard).
handle('nxm:install', async url => {
  const c = ctx();
  if (!c.nexus.configured) throw new Error('Add your Nexus API key in Settings first.');
  const link = setup.parseNxm(url);
  if (!link || link.game !== GAME) throw new Error('Not a Skyrim Special Edition link.');
  const [info, files] = await Promise.all([c.nexus.mod(link.modId), c.nexus.files(link.modId)]);
  const file = (files.files || []).find(f => f.file_id === link.fileId);
  return downloadAndInstall(c, link.modId, link.fileId, link, { name: info.name, nexusId: link.modId, version: (file && file.version) || info.version }, p => send('progress', { id: link.modId, p }));
});

// ---------- Quick Setup: set this PC up from a host's code ----------

function setupLocalState(c) {
  const snap = health.snapshot(c.paths);
  const mine = mySetup(c, snap);
  return {
    snap,
    local: {
      gameVersion: snap.gameVersion,
      mine,
      onDisk: [...snap.loadOrder.map(p => p.name), ...snap.inactive],
      implicit: snap.loadOrder.filter(p => p.source !== 'plugins.txt').map(p => p.name),
      installed: installedMods(c),
      ccExtra: snap.cc.removable.map(i => i.plugin),
    },
  };
}

handle('setup:plan', async code => {
  const c = ctx();
  // The account part is always returned, so the page renders the same way with or without a code.
  let premium = null;
  if (c.nexus.configured) { try { premium = !!(await c.nexus.validate()).is_premium; } catch { premium = null; } }
  const base = { code: '', host: null, plan: null, codeError: null, hasNexusKey: c.nexus.configured, premium, nxm: await nxmStatus(), running: !!setupRun };
  const text = String(code || c.s.setupCode || '').trim();
  if (!text) return base;
  let host;
  try {
    host = share.parseCode(text);
  } catch (e) {
    // A code typed just now is reported as an error; a stale saved one just shows the message.
    if (code) throw e;
    return { ...base, code: text, codeError: e.message };
  }
  if (code) updateSettings({ setupCode: text });
  const { local } = setupLocalState(c);
  return {
    ...base,
    code: text,
    host: { playerName: host.playerName, gameVersion: host.gameVersion, strVersion: host.strVersion, plugins: host.plugins.length, mods: host.mods.length },
    plan: setup.buildPlan(host, local),
  };
});

let setupRun = null;

handle('setup:cancel', () => {
  if (setupRun) {
    setupRun.cancelled = true;
    for (const w of nxmWaiters.values()) w.reject(new Error('Cancelled'));
    nxmWaiters.clear();
    if (setupRun.watch) setupRun.watch.cancel();
  }
  return true;
});

/**
 * Installs every missing mod from the host's code (exact versions), then matches Anniversary content,
 * load order and the co-op game preset. Progress is streamed to the window as 'setup:progress'.
 */
handle('setup:run', async (opts = {}) => {
  if (setupRun) throw new Error('Setup is already running.');
  const c = ctx();
  const code = c.s.setupCode;
  if (!code) throw new Error('Paste the host\'s setup code first.');
  if (!c.nexus.configured) throw new Error('Add your Nexus API key first.');
  const st = await launch.status();
  if (st.game || st.client) throw new Error('Close Skyrim first.');
  const host = share.parseCode(code);
  const premium = !!(await c.nexus.validate()).is_premium;
  const nxmOn = (await nxmStatus()).registered;
  const run = setupRun = { cancelled: false, watch: null };
  const progress = (stepId, state, extra = {}) => send('setup:progress', { stepId, state, ...extra });
  const summary = { installed: [], failed: [], skipped: [] };

  try {
    const { local } = setupLocalState(c);
    const plan = setup.buildPlan(host, local);
    for (const step of plan.steps.filter(s => s.kind === 'mod' && (s.status === 'needed' || s.status === 'update'))) {
      if (run.cancelled) break;
      const m = step.mod;
      try {
        progress(step.id, 'working', { text: 'Finding the right file on Nexus…' });
        const files = await c.nexus.files(m.nexusId);
        const pick = setup.pickFile(files, m);
        if (!pick) throw new Error('No downloadable files on Nexus.');
        const meta = { name: m.name || pick.file.name, nexusId: m.nexusId, version: pick.file.version || m.version };
        const versionNote = pick.exactVersion ? '' : ` (the host's ${m.version} isn't on Nexus anymore — using ${pick.file.version || 'the newest'})`;
        let result;
        if (premium) {
          progress(step.id, 'working', { text: `Downloading ${pick.file.file_name}${versionNote}` });
          result = await downloadAndInstall(c, m.nexusId, pick.file.file_id, null, meta, p => progress(step.id, 'working', { text: `Downloading ${pick.file.file_name}`, p }));
        } else if (nxmOn) {
          // Free account: open the file's download page; the user clicks "Slow download" and Nexus sends us the link.
          let timeout;
          const waiting = new Promise((resolve, reject) => {
            nxmWaiters.set(m.nexusId, { resolve, reject });
            timeout = setTimeout(() => { nxmWaiters.delete(m.nexusId); reject(new Error('Timed out waiting for the Nexus download')); }, 15 * 60 * 1000);
          });
          await shell.openExternal(fileDownloadUrl(m.nexusId, pick.file.file_id));
          progress(step.id, 'waiting', { text: `Click "Slow download" on the Nexus page that just opened${versionNote}`, url: fileDownloadUrl(m.nexusId, pick.file.file_id) });
          const link = await waiting.finally(() => clearTimeout(timeout));
          progress(step.id, 'working', { text: 'Downloading…' });
          result = await downloadAndInstall(c, m.nexusId, link.fileId, link, meta, p => progress(step.id, 'working', { text: 'Downloading…', p }));
        } else {
          // Not registered for Nexus links: the user downloads manually and we pick the file up from Downloads.
          run.watch = watchDownloads();
          await shell.openExternal(modUrl(m.nexusId, 'files'));
          progress(step.id, 'waiting', { text: `Click "Manual download" on "${pick.file.name}"${pick.file.version ? ` (${pick.file.version})` : ''}${versionNote}`, url: modUrl(m.nexusId, 'files') });
          const { file } = await run.watch.promise;
          run.watch = null;
          progress(step.id, 'working', { text: 'Installing…' });
          result = await c.installer.installArchive(file, meta);
        }
        if (!result.ok) throw new Error(result.message);
        summary.installed.push(meta.name);
        progress(step.id, 'done', { text: result.choices ? `Installed (installer options: ${result.choices.map(x => x.option).join(', ')})` : 'Installed', choices: result.choices });
      } catch (e) {
        if (run.cancelled) break;
        summary.failed.push({ name: m.name, error: e.message });
        progress(step.id, 'failed', { text: e.message });
      }
    }

    if (!run.cancelled && opts.cleanup !== false) {
      const { local: now } = setupLocalState(c);
      const extra = setup.buildPlan(host, now).steps.find(s => s.id === 'cleanup');
      if (extra && extra.status === 'needed') {
        progress('cleanup', 'working', { text: 'Moving Anniversary add-ons to backup…' });
        const r = backupCreationClub(c, extra.plugins);
        progress('cleanup', 'done', { text: `Moved ${r.moved} files to backup` });
      }
    }
    if (!run.cancelled && opts.loadOrder !== false) {
      progress('loadorder', 'working', { text: 'Matching the load order…' });
      const { local: now } = setupLocalState(c);
      const lp = share.matchPlan(now.mine, host, { onDisk: now.onDisk, implicit: now.implicit });
      c.backups.snapshotConfig(util.resolveCI(c.paths.localAppDir, 'Plugins.txt'));
      plugins.applyLoadOrder(c.paths.gameDir, c.paths.localAppDir, lp.order);
      progress('loadorder', 'done', { text: lp.missing.length ? `Matched — ${lp.missing.length} plugin(s) still missing` : 'Matched' });
    }
    if (!run.cancelled && opts.preset && configs.configFiles(c.paths).find(f => f.id === 'prefs' && f.exists)) {
      const p = configs.presets('prefs', appDataDir()).find(x => x.name === 'Co-op Friendly');
      if (p) configs.save(c.paths, 'prefs', configs.presetToChanges(p.values), c.backups);
    }
  } finally {
    setupRun = null;
    for (const w of nxmWaiters.values()) w.reject(new Error('Cancelled'));
    nxmWaiters.clear();
  }

  const { local: after } = setupLocalState(c);
  const final = setup.buildPlan(host, after);
  const inSync = share.compare(after.mine, host).filter(d => d.level === 'error').length === 0;
  send('setup:progress', { stepId: null, state: 'finished', summary, inSync, remaining: final.remaining });
  return { summary, inSync, cancelled: run.cancelled };
});

// ---------- Steam Deck / Steam integration ----------

/** The Steam install that holds userdata (launch options, shortcuts). */
async function steamRoot() {
  for (const p of await game.steamPaths()) if (util.exists(path.join(p, 'userdata'))) return p;
  throw new Error("Couldn't find Steam's userdata folder.");
}

function steamCommand(root) {
  if (process.platform === 'win32') return { cmd: path.join(root, 'steam.exe'), args: [] };
  if (root.includes(path.join('.var', 'app', 'com.valvesoftware.Steam'))) return { cmd: 'flatpak', args: ['run', 'com.valvesoftware.Steam'] };
  return { cmd: util.which('steam') || 'steam', args: [] };
}

/**
 * Steam rewrites its config files when it exits, so they can only be edited while it's closed.
 * Closes Steam (Desktop Mode only) and returns whether it was running.
 */
async function closeSteam(root) {
  const procs = await util.runningProcesses();
  if (!(await launch.status()).steam) return false;
  if (steamdeck.inGamingMode(procs)) throw new Error('Switch to Desktop Mode first (Steam button → Power → Switch to Desktop). Steam can\'t be restarted from Gaming Mode.');
  const { cmd, args } = steamCommand(root);
  require('child_process').spawn(cmd, [...args, '-shutdown'], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (!(await launch.status()).steam) {
      await new Promise(r => setTimeout(r, 1500)); // let it finish writing its files
      return true;
    }
  }
  throw new Error('Steam didn\'t close. Close it yourself (Steam menu → Exit) and try again.');
}

function reopenSteam(root) {
  const { cmd, args } = steamCommand(root);
  require('child_process').spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

/** A copy of the app icon outside the AppImage/asar, so Steam can show it. */
function iconFile() {
  const dest = path.join(appDataDir(), 'icon.png');
  if (!util.exists(dest)) fs.copyFileSync(path.join(__dirname, '..', 'renderer', 'icon.png'), dest);
  return dest;
}

function playWrapperState(c, root) {
  const wrapper = path.join(c.paths.gameDir, steamdeck.WRAPPER_NAME);
  const opts = root ? steamdeck.launchOptions(root) : [];
  return {
    wrapper: util.exists(wrapper),
    launchOptionSet: opts.some(o => o.options.includes(steamdeck.WRAPPER_NAME)),
    accounts: opts.length,
    flags: steamdeck.flags(c.paths.gameDir),
  };
}

handle('deck:status', async () => {
  const c = ctx();
  let root = null;
  try { root = await steamRoot(); } catch {}
  const { exe } = launchCommand();
  // One process scan for both questions.
  const procs = await util.runningProcesses();
  return {
    platform: process.platform,
    isDeck: steamdeck.isSteamDeck(),
    gamingMode: steamdeck.inGamingMode(procs),
    steamFound: !!root,
    steamRunning: launch.PROCS.steam.some(n => procs.has(n)),
    play: process.platform === 'linux' ? playWrapperState(c, root) : null,
    // Only a stable file can go in the Steam library (not the dev build or a temp unpack).
    canAddToSteam: !!(process.env.APPIMAGE || process.env.PORTABLE_EXECUTABLE_FILE || (app.isPackaged && process.platform === 'linux')),
    inSteam: root ? steamdeck.hasShortcut(root, exe) : false,
  };
});

handle('deck:setupPlay', async () => {
  if (process.platform !== 'linux') throw new Error('The Play-button setup is for the Steam Deck and Linux.');
  const c = ctx();
  const root = await steamRoot();
  const wasRunning = await closeSteam(root);
  try {
    const flags = steamdeck.flags(c.paths.gameDir);
    const wrapper = steamdeck.writeWrapper(c.paths.gameDir, { autoSnapshot: util.exists(path.join(c.paths.gameDir, steamdeck.CONTROL_DIR)) ? flags.autoSnapshot : true, solo: flags.solo });
    const changed = steamdeck.updateLaunchOptions(root, o => steamdeck.withWrapper(o, wrapper), path.join(c.backups.root, 'steam-config'));
    return { changed, wrapper };
  } finally {
    if (wasRunning) reopenSteam(root);
  }
});

handle('deck:undoPlay', async () => {
  const c = ctx();
  const root = await steamRoot();
  const wasRunning = await closeSteam(root);
  try {
    const changed = steamdeck.updateLaunchOptions(root, o => steamdeck.withoutWrapper(o), path.join(c.backups.root, 'steam-config'));
    steamdeck.removeWrapper(c.paths.gameDir);
    return { changed };
  } finally {
    if (wasRunning) reopenSteam(root);
  }
});

handle('deck:setFlags', f => {
  const c = ctx();
  steamdeck.setFlags(c.paths.gameDir, { autoSnapshot: f.autoSnapshot, solo: f.solo });
  return steamdeck.flags(c.paths.gameDir);
});

handle('deck:addToSteam', async () => {
  const c = ctx();
  const root = await steamRoot();
  const { exe } = launchCommand();
  const wasRunning = await closeSteam(root);
  try {
    const added = steamdeck.addShortcut(root, { name: 'STR Companion', exe, startDir: path.dirname(exe), icon: iconFile() }, path.join(c.backups.root, 'steam-config'));
    return { added };
  } finally {
    if (wasRunning) reopenSteam(root);
  }
});

// ---------- router port (UPnP) ----------
function serverPort(c) {
  const ini = new IniDoc(util.readText(game.strInfo(c.paths).configFile, ''));
  return Number(ini.get('GameServer', 'uPort')) || 10578;
}
handle('upnp:status', async () => { const port = serverPort(ctx()); return { port, ...(await upnp.status(port)) }; });
handle('upnp:open', () => upnp.openPort(serverPort(ctx())));
handle('upnp:close', () => upnp.closePort(serverPort(ctx())));

// ---------- bug report ----------
// Programming errors in the window are logged here too, so bug reports include them.
handle('app:logError', (where, message) => { logError(`window ${String(where).slice(0, 80)}`, String(message).slice(0, 4000)); return true; });

handle('report:create', async () => {
  const c = ctx();
  const snap = health.snapshot(c.paths);
  const file = await report.createReport(c.paths, {
    appVersion: app.getVersion(),
    snapshot: snap,
    checks: health.checks(c.paths, snap, c.backups, { lastSeen: c.s.lastSeen }),
    vortexMods: game.vortexMods(c.paths),
    outDir: app.getPath('desktop'),
    extraFiles: [appLogFile(), appLogFile() + '.old'],
    zipExe: sevenZip().exe,
  });
  shell.showItemInFolder(file);
  return file;
});

// ---------- self-update ----------
handle('app:selfUpdate', async () => {
  const rel = await latestRelease();
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  if (util.compareVersions(latest, app.getVersion()) <= 0) return { upToDate: true };
  const target = process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE;
  const name = selfupdate.assetFor(process.platform, latest, { portableExe: process.env.PORTABLE_EXECUTABLE_FILE, appImage: process.env.APPIMAGE });
  if (!name || !target) throw new Error('This copy can\'t update itself — download the new version from the release page.');
  const asset = (rel.assets || []).find(a => a.name === name);
  const sumsAsset = (rel.assets || []).find(a => a.name === 'SHA256SUMS.txt');
  if (!asset || !sumsAsset) throw new Error('The new release is still being built — try again in a few minutes.');
  const sums = selfupdate.parseSums((await fetchText(sumsAsset.browser_download_url)).body);
  if (!sums[name]) throw new Error('The release has no checksum for this file.');
  // Download next to the app, so the final swap is a same-folder rename.
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.update`);
  await download(asset.browser_download_url, tmp, p => send('progress', { id: 'self', p }));
  if ((await selfupdate.sha256File(tmp)) !== sums[name]) {
    fs.rmSync(tmp, { force: true });
    throw new Error('The download didn\'t match its checksum, so it wasn\'t installed.');
  }
  if (process.platform === 'win32') {
    const script = path.join(os.tmpdir(), `strc-update-${Date.now()}.cmd`);
    fs.writeFileSync(script, selfupdate.windowsSwapScript(tmp, target));
    require('child_process').spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    setTimeout(() => app.quit(), 300);
  } else {
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, target);
    app.relaunch({ execPath: target, args: [] });
    setTimeout(() => app.exit(0), 300);
  }
  return { updating: latest };
});

// ---------- local AI helper ----------
// The user's own model (Ollama, LM Studio…) chats in a side panel and can use the app through the
// tools in core/aitools.js. Changes ask the user first unless they switched that off.

const AI_DEFAULTS = { url: '', model: '', allowChanges: false, autoApprove: false, numCtx: 16384, note: '', apiKeyEnc: null };
const AI_MAX_STEPS = 16;
/** Saved AI settings. 1.5.0 kept a simpler version under "llm"; it carries over. */
function aiSaved() {
  const all = loadSettings();
  if (all.ai) return { ...AI_DEFAULTS, ...all.ai };
  const old = all.llm;
  if (old && old.baseUrl) return { ...AI_DEFAULTS, url: old.baseUrl, model: old.model || '', note: old.systemNote || '', apiKeyEnc: old.apiKeyEnc || null };
  return { ...AI_DEFAULTS };
}
function aiApiKey(s) {
  if (!s.apiKeyEnc) return null;
  try { return safeStorage.decryptString(Buffer.from(s.apiKeyEnc, 'base64')); } catch { return null; }
}
/** What the panel may see: never the key itself. */
function aiPublic(s) {
  const { apiKeyEnc, ...rest } = s;
  return { ...rest, hasKey: !!apiKeyEnc, local: s.url ? ai.isLocalUrl(s.url) : true };
}
function aiSettings() {
  const s = aiSaved();
  // Test runs point at a stand-in server (scripts/ui-check.js).
  if (process.env.STRC_AI_URL && process.env.STRC_SHOTS) Object.assign(s, { url: process.env.STRC_AI_URL, model: 'mock', allowChanges: true });
  return s;
}

const aiKinds = new Map(); // url -> 'ollama' | 'openai'
const aiTextMode = new Set(); // url|model pairs whose server rejected tools
async function aiKind(url) {
  if (!aiKinds.has(url)) aiKinds.set(url, await ai.detectKind(url));
  return aiKinds.get(url);
}

handle('ai:getSettings', () => ({ ...aiPublic(aiSettings()), presets: ai.PRESETS }));
handle('ai:setSettings', (patch = {}) => {
  patch = patch && typeof patch === 'object' ? patch : {};
  const cur = aiSaved();
  if ('url' in patch) { cur.url = patch.url ? ai.normalizeUrl(patch.url) : ''; aiKinds.delete(cur.url); }
  if ('model' in patch) cur.model = String(patch.model || '').slice(0, 200);
  for (const k of ['allowChanges', 'autoApprove']) if (k in patch) cur[k] = !!patch[k];
  if ('numCtx' in patch) cur.numCtx = Math.max(2048, Math.min(262144, Math.round(Number(patch.numCtx)) || 16384));
  if ('note' in patch) cur.note = String(patch.note || '').slice(0, 2000);
  // Like the Nexus key: encrypted by the OS, never sent back to the window. Empty clears it.
  if ('apiKey' in patch) {
    const key = String(patch.apiKey || '').trim();
    if (!key) cur.apiKeyEnc = null;
    else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('No secure storage is available, so the API key cannot be saved safely.');
      cur.apiKeyEnc = safeStorage.encryptString(key).toString('base64');
    }
  }
  updateSettings({ ai: cur });
  return aiPublic(cur);
});
handle('ai:models', async (url, apiKey) => {
  const u = ai.normalizeUrl(url || aiSettings().url);
  aiKinds.delete(u);
  const kind = await aiKind(u);
  const key = String(apiKey || '').trim() || aiApiKey(aiSaved());
  return { kind, models: await ai.listModels(u, kind, key), local: ai.isLocalUrl(u) };
});

let aiMessages = []; // the conversation (without the briefing), in core/ai.js's neutral shape
let aiRun = null;
let aiPage = 'dashboard';
const aiEmit = ev => send('ai:event', ev);

/** Short facts about this PC for the briefing, gathered once per question. */
async function aiState() {
  const out = [`- STR Companion ${app.getVersion()} on ${process.platform === 'win32' ? 'Windows' : steamdeck.isSteamDeck() ? 'Steam Deck' : 'Linux'}`];
  let c;
  try { c = ctx(); } catch { return out.concat('- No Skyrim folder chosen yet: the user must pick it on the welcome screen. Most tools will fail until then.').join('\n'); }
  try {
    const snap = health.snapshot(c.paths);
    const st = await launch.status();
    const problems = health.checks(c.paths, snap, c.backups, { lastSeen: c.s.lastSeen, crashAck: c.s.crashAck }).filter(x => x.level === 'error' || x.level === 'warn');
    out.push(
      `- Game folder: ${c.paths.gameDir}`,
      `- Skyrim ${snap.gameVersion || '?'}; SKSE ${snap.skse.installed ? snap.skse.version : 'not installed'}; Address Library ${snap.addressLibrary.matchesGame ? 'matches' : 'missing or wrong'}; Skyrim Together ${snap.str.installed ? snap.str.version || 'installed' : 'not installed'}`,
      `- ${snap.loadOrder.length} plugins load (${snap.inactive.length} off); mod manager: ${snap.manager || 'none detected'}; removable Anniversary add-ons: ${snap.cc.removable.length}`,
      `- Running: ${['game', 'client', 'server', 'steam'].filter(k => st[k]).join(', ') || 'nothing'}`,
      `- Nexus key: ${c.nexus.configured ? 'yes' : 'no'}; player name: ${c.s.playerName}; friends saved: ${(c.s.party || []).length}`,
      problems.length ? `- Dashboard problems: ${problems.map(p => `${p.level === 'error' ? '✖' : '!'} ${p.title}`).join('; ')}` : '- The dashboard shows no problems.',
    );
  } catch (e) {
    out.push(`- (Couldn't read the game's state: ${e.message})`);
  }
  out.push(`- The user is looking at the "${aiPage}" page.`);
  return out.join('\n');
}

const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && o[k] !== undefined).map(k => [k, o[k]]));

/** What each tool does, on top of the same handlers the pages call. Results are trimmed for small models. */
const aiExec = {
  async get_overview() {
    const h = await handlers['health:get']();
    return {
      ...h.snapshot,
      checks: h.checks.map(x => pick(x, ['level', 'title', 'detail', 'fix'])),
      running: await launch.status(),
      nexus: await handlers['nexus:status'](),
      page: aiPage,
    };
  },
  get_load_order() {
    const c = ctx();
    const snap = health.snapshot(c.paths);
    return {
      loads: snap.loadOrder.map((p, i) => `${i}. ${p.name}${p.source && p.source !== 'plugins.txt' ? ` (${p.source})` : ''}`),
      off: snap.inactive,
      missingMasters: snap.masterProblems,
      counts: snap.counts,
    };
  },
  async list_mods({ installedOnly } = {}) {
    const d = await handlers['mods:list']();
    return d.mods.filter(m => !installedOnly || m.installed).map(m => pick(m, ['id', 'name', 'category', 'compat', 'installed', 'installedVersion', 'manager', 'registryKey', 'loadStatus', 'custom', 'versionLocked']));
  },
  check_mod_updates: () => handlers['mods:checkUpdates'](),
  async cleanup_report() {
    const r = await handlers['cleanup:report']();
    return {
      creationClub: { removable: r.cc.removable.map(i => i.plugin), keep: r.cc.keep.map(i => i.plugin || i) },
      plugins: r.plugins.map(p => ({ name: p.name, active: p.active, protected: !!p.protected, creationClub: !!p.creationClub, masters: p.masters, manager: p.manager || undefined })),
      knownIssues: r.issues,
      manager: r.manager,
    };
  },
  async read_config({ file, all, section }) {
    const d = await handlers['config:load'](file);
    if (!d.exists) return { exists: false, file: d.file, note: 'The file does not exist yet; set_config_values creates it.' };
    const entries = d.entries
      .filter(e => (all || e.featured) && (!section || String(e.section).toLowerCase() === String(section).toLowerCase()))
      .map(e => ({ section: e.section, key: e.key, value: e.type === 'secret' ? (e.value ? '(set, hidden)' : '') : e.value, ...(e.featured ? { label: e.label, type: e.type } : {}), ...(e.options ? { options: e.options.map(o => (Array.isArray(o) ? o[0] : o)) } : {}), ...(e.missing ? { notInFile: true } : {}), ...(e.warn ? { warn: e.warn } : {}) }));
    return { file: d.file, note: d.note, sections: d.sections, entries, ...(all ? {} : { hint: 'Only well-known settings; pass all=true for every key.' }) };
  },
  list_presets: async ({ file }) => (await handlers['config:presets'](file)).map(p => pick(p, ['name', 'description', 'builtin', 'values'])),
  async list_backups() {
    const c = ctx();
    return {
      batches: c.backups.list().map(b => ({ id: b.id, label: b.label, category: b.category, createdAt: b.createdAt, files: b.files.length })),
      saveSnapshots: c.backups.listSaveSnapshots().map(s => pick(s, ['id', 'note', 'createdAt', 'auto', 'files', 'size'])),
      configHistory: (await handlers['backups:configHistory']()).slice(0, 40),
    };
  },
  read_log({ log, lines }) {
    const f = logs.logFiles(ctx().paths).find(l => l.id === log);
    if (!f || !f.exists) return { exists: false, note: `There is no ${log} log yet.` };
    return logs.tail(f.file, Math.max(10, Math.min(400, Number(lines) || 120)));
  },
  async get_crash_reports() {
    const r = await handlers['logs:crashes']();
    return { ...r, reports: r.reports.slice(0, 3) };
  },
  get_server_session: () => handlers['server:session'](),
  async get_network_info() {
    const out = { localIps: (await handlers['net:info']()).local };
    try { out.publicIp = await handlers['net:publicIp'](); } catch (e) { out.publicIp = `unknown (${e.message})`; }
    try { out.router = await handlers['upnp:status'](); } catch (e) { out.router = `unknown (${e.message})`; }
    return out;
  },
  async get_my_setup_code() {
    const m = await handlers['share:mine']();
    return { code: m.code, playerName: m.setup.playerName, gameVersion: m.setup.gameVersion, strVersion: m.setup.strVersion, plugins: m.setup.plugins.length, mods: m.setup.mods.length };
  },
  async compare_setup_code({ code }) {
    const r = await handlers['share:compare'](code);
    return { friend: pick(r.theirs, ['playerName', 'gameVersion', 'strVersion', 'skseVersion']), differences: r.diffs, loadOrderPlan: pick(r.plan, ['missing', 'activate', 'deactivate', 'extraImplicit', 'reorder', 'changes']) };
  },
  list_party: () => handlers['party:list'](),
  quick_setup_plan: ({ code }) => handlers['setup:plan'](code || undefined),
  get_steam_status: () => handlers['deck:status'](),
  get_app_settings: () => handlers['settings:set']({}),
  open_page({ page }) { aiEmit({ type: 'navigate', page }); return { shown: page }; },

  set_config_values: async ({ file, changes }) => ({ ...(await handlers['config:save'](file, changes)), note: 'The previous file is in config history (list_backups).' }),
  apply_preset: ({ file, name }) => handlers['config:applyPreset'](file, name),
  save_preset: ({ file, name }) => handlers['config:savePreset'](file, name),
  run_fix({ fix }) {
    if (fix.action === 'goto') return aiExec.open_page({ page: fix.page });
    return handlers['fix:run'](fix);
  },
  move_creation_club_to_backup: ({ plugins: only }) => handlers['cleanup:backupCC'](only && only.length ? only : null),
  move_mods_to_backup: ({ plugins: names }) => handlers['cleanup:backupPlugins'](names),
  set_plugin_enabled: ({ plugin, enabled }) => handlers['cleanup:setActive'](plugin, enabled),
  restore_backup: ({ batch, files }) => handlers['backups:restore'](batch, files && files.length ? files : null),
  restore_config_version: ({ version }) => handlers['backups:restoreConfig'](version),
  take_save_snapshot: ({ note }) => handlers['saves:snapshot'](note || 'Taken by the AI helper'),
  server_control: ({ action }) => handlers[{ start: 'launch:server', stop: 'launch:stopServer', restart: 'launch:restartServer' }[action]](),
  launch_game: () => handlers['launch:client'](),
  match_load_order: ({ code }) => handlers['share:applyMatch'](code),
  party({ action, code, name }) {
    if (action === 'save') { if (!code) throw new Error('Give the friend\'s code.'); return handlers['party:save'](code); }
    if (!name) throw new Error('Give the friend\'s name.');
    return handlers['party:remove'](name);
  },
  async install_mod({ nexusId }) {
    const r = await handlers['mods:install'](nexusId);
    return r && r.manual ? { notInstalled: true, why: 'Direct downloads need a Nexus Premium account (or no key is set). Tell the user to use the Install button on the Mods page, which walks them through the free download.' } : r;
  },
  uninstall_mod: ({ key }) => handlers['mods:uninstall'](key),
  add_custom_mod: ({ link, category }) => handlers['mods:addCustom'](String(link), category),
  update_app_settings: a => handlers['settings:set'](pick(a, ['playerName', 'autoSnapshot', 'keepAutoSnapshots', 'uiScale'])),
  open_router_port: () => handlers['upnp:open'](),
  create_bug_report: () => handlers['report:create'](),
  restore_save_snapshot: ({ id }) => handlers['saves:restore'](id),
  async run_quick_setup({ cleanup: cl, loadOrder, coopPreset }) {
    aiEmit({ type: 'navigate', page: 'setup' });
    return handlers['setup:run']({ cleanup: cl !== false, loadOrder: loadOrder !== false, preset: !!coopPreset });
  },
  steam_play_button: ({ action }) => handlers[action === 'setup' ? 'deck:setupPlay' : 'deck:undoPlay'](),
};

function aiApproval(run, id) {
  return new Promise(resolve => {
    run.approvals.set(id, resolve);
    run.ctrl.signal.addEventListener('abort', () => resolve(false), { once: true });
  });
}

let aiToolSeq = 0;
async function aiRunTool(run, cfg, call) {
  const tool = aitools.byName.get(call.name);
  // Servers may reuse call ids between turns ("call_0"), so the panel and approvals get one of their own.
  const uid = `t${++aiToolSeq}`;
  const base = { type: 'tool', id: uid, name: call.name };
  const fail = error => { aiEmit({ ...base, status: 'error', error }); return { error }; };
  if (!tool || !aiExec[call.name]) return fail(`There is no tool called ${call.name}.`);
  const args = aitools.coerceArgs(tool, call.arguments);
  aiEmit({ ...base, status: 'running', args, risk: tool.risk });
  if (tool.risk !== 'read' && !cfg.allowChanges) return fail('Changes are turned off in the AI settings. Tell the user what to do instead.');
  const bad = aitools.checkArgs(tool, args);
  if (bad) return fail(bad);
  if (tool.risk === 'ask' || (tool.risk === 'change' && !cfg.autoApprove)) {
    aiEmit({ ...base, status: 'confirm', text: aitools.describeCall(call.name, args), risk: tool.risk });
    if (!(await aiApproval(run, uid))) {
      aiEmit({ ...base, status: 'denied' });
      return { error: run.ctrl.signal.aborted ? 'Stopped by the user.' : 'The user said no to this change.' };
    }
    aiEmit({ ...base, status: 'running', args, risk: tool.risk });
  }
  try {
    const data = await aiExec[call.name](args);
    aiEmit({ ...base, status: 'done', risk: tool.risk });
    if (tool.risk !== 'read') aiEmit({ type: 'changed' });
    return data === undefined ? { done: true } : data;
  } catch (e) {
    if (/^(TypeError|ReferenceError|RangeError|SyntaxError)$/.test(e.name)) logError(`ai tool ${call.name}`, e);
    return fail(e.message === 'NO_GAME' ? 'No Skyrim folder is set; the user must choose it first.' : e.message);
  }
}

/** The recent conversation, within a rough character budget, starting at a user message. */
function aiHistory(budget) {
  let msgs = aiMessages.map((m, i) => (m.role === 'tool' && i < aiMessages.length - 12 && m.content.length > 600 ? { ...m, content: m.content.slice(0, 600) + '… [older result cut]' } : m));
  const size = list => list.reduce((n, m) => n + String(m.content || '').length + JSON.stringify(m.toolCalls || '').length, 0);
  while (size(msgs) > budget) {
    const next = msgs.findIndex((m, i) => i > 0 && m.role === 'user');
    if (next < 0) break;
    msgs = msgs.slice(next);
  }
  return msgs;
}

async function aiConversation(run, cfg) {
  const url = ai.normalizeUrl(cfg.url);
  const kind = await aiKind(url);
  const apiKey = aiApiKey(cfg);
  let model = cfg.model;
  if (!model) {
    model = (await ai.listModels(url, kind, apiKey))[0];
    if (!model) throw new Error(kind === 'ollama' ? 'Ollama has no models yet. Run `ollama pull qwen3:8b` (or another model) first.' : 'The server has no model loaded. Load one in LM Studio first.');
  }
  const state = await aiState();
  // Roughly 3.5 characters per token, leaving room for the briefing, the tools and the answer.
  const budget = Math.max(6000, (cfg.numCtx || 16384) * 3.5 - 22000);
  for (let step = 0; step < AI_MAX_STEPS; step++) {
    const textTools = aiTextMode.has(`${url}|${model}`);
    const system = aitools.systemPrompt({ state, allowChanges: cfg.allowChanges, autoApprove: cfg.autoApprove, textTools, note: cfg.note });
    aiEmit({ type: 'turn', model });
    let res;
    try {
      res = await ai.chat({
        url, kind, model, apiKey, numCtx: cfg.numCtx, signal: run.ctrl.signal,
        messages: [{ role: 'system', content: system }, ...aiHistory(budget)].map(m => (textTools ? ai.toTextMode([m])[0] : m)),
        tools: textTools ? null : aitools.specs(cfg.allowChanges),
        onText: text => aiEmit({ type: 'text', text }),
        onThinking: text => aiEmit({ type: 'thinking', text }),
      });
    } catch (e) {
      if (e.noTools && !textTools) {
        aiTextMode.add(`${url}|${model}`);
        aiEmit({ type: 'notice', text: `${model} can't use tools directly, so the app switched to text instructions for it.` });
        step--;
        continue;
      }
      throw e;
    }
    aiMessages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls });
    if (!res.toolCalls.length) return;
    for (const call of res.toolCalls) {
      const out = run.ctrl.signal.aborted ? { error: 'Stopped by the user.' } : await aiRunTool(run, cfg, call);
      aiMessages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: ai.resultText(out) });
    }
    if (run.ctrl.signal.aborted) return;
  }
  aiEmit({ type: 'notice', text: `Paused after ${AI_MAX_STEPS} steps. Say "continue" to let it carry on.` });
}

handle('ai:chat', (text, page) => {
  if (aiRun) throw new Error('The AI is still working on the last question.');
  const cfg = aiSettings();
  if (!cfg.url) throw new Error('Set up the AI first: choose your AI server in the AI panel\'s settings.');
  text = String(text || '').trim().slice(0, 8000);
  if (!text) throw new Error('Type a question first.');
  if (aitools.PAGES.includes(page)) aiPage = page;
  aiMessages.push({ role: 'user', content: text });
  const run = aiRun = { ctrl: new AbortController(), approvals: new Map() };
  aiConversation(run, cfg)
    .catch(e => {
      if (e.stopped || run.ctrl.signal.aborted) aiEmit({ type: 'notice', text: 'Stopped.' });
      else { if (/^(TypeError|ReferenceError|RangeError|SyntaxError)$/.test(e.name)) logError('ai', e); aiEmit({ type: 'error', message: e.message }); }
    })
    .finally(() => { aiRun = null; aiEmit({ type: 'done' }); });
  return true;
});
handle('ai:approve', (id, allow) => {
  const f = aiRun && aiRun.approvals.get(id);
  if (f) { aiRun.approvals.delete(id); f(!!allow); }
  return !!f;
});
handle('ai:stop', () => { if (aiRun) aiRun.ctrl.abort(); return true; });
handle('ai:reset', () => {
  if (aiRun) aiRun.ctrl.abort();
  aiMessages = [];
  return true;
});

// ---------- misc ----------
handle('shell:openGameDir', () => shell.openPath(ctx().paths.gameDir));
handle('shell:external', url => {
  if (!/^https:\/\/([\w-]+\.)*(nexusmods\.com|github\.com|silverlock\.org|tiltedphoques\.com)\//.test(url)) throw new Error('Blocked link');
  return shell.openExternal(url);
});

function createWindow() {
  // Fit small screens (the Steam Deck is 1280x800, minus panels) instead of opening off-screen.
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1280, area.width),
    height: Math.min(840, area.height),
    minWidth: Math.min(980, area.width),
    minHeight: Math.min(600, area.height),
    backgroundColor: '#14120f',
    title: 'STR Companion',
    autoHideMenuBar: true,
    // Windows takes the icon from the exe; Linux window managers need it set on the window.
    icon: process.platform === 'win32' ? undefined : path.join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Screenshot mode renders offscreen so every frame is painted, even with the window hidden.
      offscreen: !!process.env.STRC_SHOTS,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.env.STRC_SHOTS) captureAllPages(process.env.STRC_SHOTS);
  // Started by a Nexus "Mod Manager Download" click: handle that link once the page is ready.
  win.webContents.once('did-finish-load', () => {
    const scale = Number(loadSettings().uiScale) || 1;
    if (scale !== 1) win.webContents.setZoomFactor(scale);
    const first = nxmFromArgv(process.argv);
    const queued = [...(first ? [first] : []), ...pendingNxm];
    pendingNxm = [];
    for (const u of queued) handleNxmUrl(u);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** Developer aid: STRC_SHOTS=<dir> saves a screenshot of every page, then quits. */
function captureAllPages(dir) {
  const pages = ['dashboard', 'setup', 'play', 'deck', 'mods', 'cleanup', 'config', 'friends', 'session', 'backups', 'logs', 'settings'];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  win.webContents.once('did-finish-load', async () => {
    fs.mkdirSync(dir, { recursive: true });
    await wait(1500);
    const report = {};
    // Extra steps exercise flows, not just pages: a crash-report tab, and comparing my own setup code.
    const extra = {
      'logs:crashes': `document.querySelector('#logTabs [data-tab="crashes"]').click()`,
      // STRC_COMPARE_CODE lets a test compare against a different friend; otherwise my own code is used.
      'friends:compare': `document.querySelector('#theirCode').value = ${JSON.stringify(process.env.STRC_COMPARE_CODE || '')} || document.querySelector('.copyable code').textContent; document.querySelector('#compare').click()`,
      // Quick Setup with a code (the compare code, or my own) so the plan renders.
      'setup:plan': `(async () => { const own = ${JSON.stringify(process.env.STRC_COMPARE_CODE || '')} || (await api.call('share:mine')).code; document.querySelector('#setupCode').value = own; document.querySelector('#check').click(); })()`,
      // Premium test scenario only (fake game, stand-in Nexus with downloads disabled): run the whole
      // "Set up everything" flow — mods fail cleanly, then cleanup and load order run for real.
      ...(process.env.STRC_NEXUS_MOCK === 'premium' && process.env.STRC_GAME_DIR ? {
        'setup:run': `(async () => { await new Promise(r => setTimeout(r, 1500)); document.querySelector('#runSetup')?.click(); await new Promise(r => setTimeout(r, 400)); document.querySelector('#okBtn')?.click(); await new Promise(r => setTimeout(r, 6000)); })()`,
      } : {}),
      // With a stand-in AI server (STRC_AI_URL): ask a question, let it read the setup, allow its change.
      ...(process.env.STRC_AI_URL ? {
        'dashboard:ai': `(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); await aiToggle(true); await w(300); await aiSend('Make the server easier'); for (let i = 0; i < 40 && !document.querySelector('[data-approve]'); i++) await w(250); document.querySelector('[data-approve]')?.click(); for (let i = 0; i < 40 && !/MOCK_DONE/.test(document.querySelector('#aiList')?.textContent || ''); i++) await w(250); })()`,
      } : {}),
    };
    const steps = [...pages, ...Object.keys(extra)];
    // A broken page must not stop the check: record the step's failure, carry on, and always quit.
    try {
    for (const step of steps) {
      try {
      const [p] = step.split(':');
      await win.webContents.executeJavaScript(`document.querySelector('#nav [data-page="${p}"]').click()`);
      if (extra[step]) {
        await wait(1200);
        await win.webContents.executeJavaScript(extra[step]);
      }
      await wait(1800);
      win.webContents.invalidate();
      await wait(200);
      const img = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      fs.writeFileSync(path.join(dir, `${step.replace(":", "-")}.png`), img.toPNG());
      report[step] = await win.webContents.executeJavaScript(`({ h1: document.querySelector('main h1')?.textContent, error: document.querySelector('main .render-error')?.textContent || null })`);
      if (step === 'dashboard:ai') {
        const chat = await win.webContents.executeJavaScript(`document.querySelector('#aiList')?.textContent || ''`);
        if (!/MOCK_DONE/.test(chat)) report[step].error = `the AI chat didn't finish: ${chat.slice(-300)}`;
      }
      // Click through every tab on the page too (each click re-renders, so look the tabs up again each time).
      if (!extra[step]) {
        const count = await win.webContents.executeJavaScript(`document.querySelectorAll('main .tabs button').length`);
        const tabErrors = [];
        for (let i = 0; i < count; i++) {
          await win.webContents.executeJavaScript(`document.querySelectorAll('main .tabs button')[${i}]?.click()`);
          await wait(900);
          const err = await win.webContents.executeJavaScript(`document.querySelector('main .render-error')?.textContent || null`);
          if (err) tabErrors.push(`tab ${i}: ${err}`);
        }
        if (count) report[step].tabs = count;
        if (tabErrors.length) report[step].error = [report[step].error, ...tabErrors].filter(Boolean).join(' | ');
      }
      } catch (e) {
        report[step] = { ...(report[step] || {}), error: `check step failed: ${e.message}` };
      }
    }
    } finally {
      try { report.__errors = await win.webContents.executeJavaScript('window.__errors'); } catch { report.__errors = ['could not read errors'] }
      fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
      app.quit();
    }
  });
}


// Screenshot/test runs get their own profile, so they never touch real settings and can run next to
// an open copy of the app.
if (process.env.STRC_SHOTS) app.setPath('userData', path.join(os.tmpdir(), `strc-shots-profile-${process.pid}`));

// One window only: a second launch focuses the first (two copies would fight over the same files).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // Nexus "Mod Manager Download" clicks arrive here as a second launch with an nxm:// argument.
    const link = nxmFromArgv(argv);
    if (link) handleNxmUrl(link);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
