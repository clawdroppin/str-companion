'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
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
const { IniDoc } = require('../core/ini');

let win;
const appDataDir = () => app.getPath('userData');
const settingsFile = () => path.join(appDataDir(), 'settings.json');

const DEFAULT_SETTINGS = {
  gameDir: null, playerName: os.userInfo().username, customMods: [], checklist: {}, party: [],
  autoSnapshot: true, keepAutoSnapshots: 10,
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
function nexusKey() {
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
  return { s, paths, backups, installer: new Installer(paths, appDataDir(), backups), nexus: new Nexus(nexusKey()) };
}

/** Folders made by hand before this app existed (e.g. _CoopBackup_2026-10-15/CreationClub) become restorable batches. */
function adoptLegacyBackups(c) {
  for (const e of util.listDir(c.paths.gameDir)) {
    if (!e.isDirectory() || !/^_CoopBackup_/i.test(e.name)) continue;
    const cc = util.findCaseInsensitive(path.join(c.paths.gameDir, e.name), 'CreationClub');
    if (cc) c.backups.adoptFolder(cc, { label: `Creation Club content (${e.name.replace(/^_CoopBackup_/, '')})`, category: 'creation-club' });
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
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
  if (valid) adoptLegacyBackups(ctx());
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

const PUBLIC_SETTINGS = ['playerName', 'checklist', 'autoSnapshot', 'keepAutoSnapshots'];
handle('settings:set', patch => {
  const allowed = {};
  for (const k of PUBLIC_SETTINGS) if (k in patch) allowed[k] = patch[k];
  if ('keepAutoSnapshots' in allowed) allowed.keepAutoSnapshots = Math.max(1, Math.min(100, Number(allowed.keepAutoSnapshots) || 10));
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
handle('cleanup:setActive', (name, active) => {
  const c = ctx();
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
  const user = await new Nexus(key).validate();
  if (!safeStorage.isEncryptionAvailable()) throw new Error(process.platform === 'win32' ? 'Windows secure storage is unavailable, so the key cannot be saved safely.' : 'No system keyring is available (install gnome-keyring or KWallet), so the key cannot be saved safely.');
  updateSettings({ nexusKeyEnc: safeStorage.encryptString(key).toString('base64') });
  nexusKeyCache = key;
  return { name: user.name, premium: !!user.is_premium };
});
handle('nexus:status', async () => {
  const k = nexusKey();
  if (!k) return { configured: false };
  try { const u = await new Nexus(k).validate(); return { configured: true, name: u.name, premium: !!u.is_premium }; }
  catch (e) { return { configured: true, error: e.message }; }
});
handle('nexus:openKeyPage', () => shell.openExternal('https://next.nexusmods.com/settings/api-keys'));

// ---------- play / server ----------
handle('launch:status', () => launch.status());
handle('launch:client', async () => {
  const c = ctx();
  const st = await launch.status();
  if (st.game || st.client) throw new Error('Skyrim is already running.');
  // A copy of the saves before every session, so a bad sync or crash can always be undone.
  let snapshot = null;
  if (c.s.autoSnapshot && util.walkFiles(c.paths.saves).length) {
    try {
      snapshot = await c.backups.snapshotSaves('Automatic, before launch', { auto: true, keepAuto: c.s.keepAutoSnapshots });
    } catch (e) {
      snapshot = { error: e.message };
    }
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
handle('saves:snapshot', note => ctx().backups.snapshotSaves(note || ''));
handle('saves:delete', id => ctx().backups.deleteSaveSnapshot(id));
handle('saves:restore', async id => {
  const st = await launch.status();
  if (st.game || st.client) throw new Error('Close Skyrim before restoring saves.');
  return ctx().backups.restoreSaveSnapshot(id);
});
handle('saves:open', () => shell.openPath(ctx().paths.saves));

// ---------- app updates (GitHub releases) ----------
const REPO = 'clawdroppin/str-companion';
handle('app:checkUpdate', async () => {
  const r = await fetchText(`https://api.github.com/repos/${REPO}/releases/latest`, { Accept: 'application/vnd.github+json' });
  if (r.status !== 200) return { hasUpdate: false };
  const rel = JSON.parse(r.body);
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  const url = /^https:\/\/github\.com\//.test(rel.html_url) ? rel.html_url : `https://github.com/${REPO}/releases/latest`;
  return { latest, url, hasUpdate: !!latest && util.compareVersions(latest, app.getVersion()) > 0 };
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
    let owner = null;
    if (!registered) {
      const r = await util.run('reg', ['query', 'HKCR\\nxm\\shell\\open\\command', '/ve']);
      const m = r.stdout.match(/REG_SZ\s+(.+)/);
      if (m) owner = /vortex/i.test(m[1]) ? 'Vortex' : /modorganizer|nxmhandler/i.test(m[1]) ? 'Mod Organizer 2' : 'another program';
    }
    return { registered, owner };
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
  const text = String(code || c.s.setupCode || '').trim();
  if (!text) return { plan: null, hasNexusKey: c.nexus.configured };
  const host = share.parseCode(text);
  if (code) updateSettings({ setupCode: text });
  const { local } = setupLocalState(c);
  let premium = null;
  if (c.nexus.configured) { try { premium = !!(await c.nexus.validate()).is_premium; } catch { premium = null; } }
  return {
    code: text,
    host: { playerName: host.playerName, gameVersion: host.gameVersion, strVersion: host.strVersion, plugins: host.plugins.length, mods: host.mods.length },
    plan: setup.buildPlan(host, local),
    hasNexusKey: c.nexus.configured,
    premium,
    nxm: await nxmStatus(),
    running: !!setupRun,
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

// ---------- misc ----------
handle('shell:openGameDir', () => shell.openPath(ctx().paths.gameDir));
handle('shell:external', url => {
  if (!/^https:\/\/([\w-]+\.)*(nexusmods\.com|github\.com|silverlock\.org|tiltedphoques\.com)\//.test(url)) throw new Error('Blocked link');
  return shell.openExternal(url);
});

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
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
  const pages = ['dashboard', 'setup', 'play', 'mods', 'cleanup', 'config', 'friends', 'session', 'backups', 'logs', 'settings'];
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
    };
    const steps = [...pages, ...Object.keys(extra)];
    for (const step of steps) {
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
    }
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    app.quit();
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
