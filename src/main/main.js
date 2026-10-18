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
const { Nexus, modUrl, parseModRef, download } = require('../core/nexus');
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

// Watches the Downloads folder after the user starts a Nexus manual download, so the file can be installed in one click.
let watchTimer = null;
handle('downloads:watch', (modId, name) => {
  const dir = app.getPath('downloads');
  const started = Date.now();
  const sizes = new Map();
  clearInterval(watchTimer);
  watchTimer = setInterval(() => {
    if (Date.now() - started > 15 * 60 * 1000) { clearInterval(watchTimer); return; }
    for (const e of util.listDir(dir)) {
      if (!e.isFile() || !ARCHIVE_EXT.test(e.name)) continue;
      const full = path.join(dir, e.name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs < started - 5000) continue;
      // Only report once the size has stopped changing (download finished).
      if (sizes.get(full) === st.size && st.size > 0) {
        clearInterval(watchTimer);
        send('download:found', { file: full, modId, name, size: st.size });
        return;
      }
      sizes.set(full, st.size);
    }
  }, 2000);
  return dir;
});
handle('downloads:stop', () => { clearInterval(watchTimer); return true; });

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
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** Developer aid: STRC_SHOTS=<dir> saves a screenshot of every page, then quits. */
function captureAllPages(dir) {
  const pages = ['dashboard', 'play', 'mods', 'cleanup', 'config', 'friends', 'session', 'backups', 'logs', 'settings'];
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
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
