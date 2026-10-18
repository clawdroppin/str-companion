'use strict';
const path = require('path');
const game = require('./game');
const plugins = require('./plugins');
const cleanup = require('./cleanup');
const logs = require('./logs');
const { IniDoc } = require('./ini');
const { readText } = require('./util');

/** Everything the dashboard shows, gathered in one pass. */
function snapshot(paths) {
  const gameVersion = game.gameVersion(paths);
  const vortex = game.vortexMods(paths);
  const lo = plugins.effectiveLoadOrder(paths.gameDir, paths.localAppDir);
  return {
    gameVersion,
    skse: game.skseInfo(paths),
    addressLibrary: game.addressLibraryInfo(paths, gameVersion),
    str: game.strInfo(paths, vortex),
    sksePlugins: game.sksePlugins(paths),
    rootHooks: game.rootHooks(paths),
    autoUpdate: game.steamAutoUpdate(paths),
    manager: game.modManager(paths),
    loadOrder: lo.order,
    inactive: lo.inactive,
    masterProblems: plugins.checkMasters(paths.gameDir, lo.order),
    cc: cleanup.creationClubReport(paths),
    knownIssues: cleanup.knownIssues(paths),
    client: logs.clientLog(paths),
    skseResults: logs.sksePluginResults(paths),
  };
}

/** Turns a snapshot into a checklist with severity and one-click fixes. */
function checks(paths, s, backups) {
  const out = [];
  const add = (level, title, detail, fix) => out.push({ level, title, detail, fix: fix || null });

  add('ok', `Skyrim ${s.gameVersion}`, paths.gameDir);

  if (!s.str.installed) add('error', 'Skyrim Together Reborn is not installed', 'Install it from the Mods page.', { action: 'goto', page: 'mods', label: 'Go to Mods' });
  else add('ok', `Skyrim Together Reborn ${s.str.version || ''}`.trim(), s.client.skseHooked ? 'Loaded correctly last time you played.' : 'Installed.');

  if (!s.skse.installed) add('error', 'SKSE is not installed', 'Skyrim Together and most fixes need it.', { action: 'goto', page: 'mods', label: 'Go to Mods' });
  else if (!s.skse.builtFor.includes(s.gameVersion)) add('error', `SKSE doesn't match your game`, `SKSE is built for ${s.skse.builtFor.join(', ')} but the game is ${s.gameVersion}. Update SKSE.`);
  else add('ok', `SKSE ${s.skse.version}`, `Built for ${s.gameVersion}.`);

  if (!s.addressLibrary.installed) add('error', 'Address Library is missing', 'SKSE plugins need it.', { action: 'goto', page: 'mods', label: 'Go to Mods' });
  else if (!s.addressLibrary.matchesGame) add('error', `Address Library has no file for ${s.gameVersion}`, 'Update Address Library (All in One).');
  else add('ok', 'Address Library', `Has the ${s.gameVersion} database.`);

  const missing = s.masterProblems.filter(p => p.kind === 'missing');
  const order = s.masterProblems.filter(p => p.kind === 'order');
  if (missing.length) {
    const freeMissing = missing.filter(p => plugins.isFreeCc(p.master)).map(p => p.master);
    const restorable = freeMissing.length && backups ? findInBackups(backups, freeMissing) : [];
    add('error', `${missing.length} missing master file${missing.length > 1 ? 's' : ''} — the game will crash on startup`,
      missing.map(p => `${p.plugin} needs ${p.master}`).join('\n'),
      restorable.length ? { action: 'restoreFiles', items: restorable, label: 'Restore from backup' } : null);
  }
  if (order.length) add('error', 'Plugins load before their masters', order.map(p => `${p.plugin} loads before ${p.master}`).join('\n'));
  if (!missing.length && !order.length) add('ok', `Load order: ${s.loadOrder.length} plugins`, 'Every plugin has its masters.');

  if (s.cc.removable.length) {
    add('warn', `${s.cc.removable.length} Anniversary Edition add-ons are active`,
      'The Skyrim Together team recommends disabling them, and every player would need the exact same set. The 4 free ones USSEP needs are kept.',
      { action: 'backupCC', label: 'Move to backup' });
  } else add('ok', 'No extra Anniversary Edition content', s.cc.keep.length ? `Keeping the ${s.cc.keep.length} free files USSEP needs.` : '');

  for (const k of s.knownIssues) add('warn', `${k.name} may cause problems`, k.why, { action: 'backupFiles', rels: [k.rel], label: 'Move to backup' });

  if (s.autoUpdate && s.autoUpdate.value !== 1) {
    add('warn', 'Steam auto-updates Skyrim', 'A surprise game update breaks SKSE and Skyrim Together until they catch up. Set it to update only when you launch.',
      { action: 'steamUpdateOnLaunch', label: 'Fix (Steam must be closed)' });
  } else if (s.autoUpdate) add('ok', 'Steam updates only when launched', '');

  for (const h of s.rootHooks) add('info', `${h.file} in the game folder`, `${h.what}. Fine if you added it on purpose.`);

  const failed = s.skseResults.results.filter(r => !r.ok);
  for (const f of failed) add('warn', `${f.dll} didn't load last launch`, f.why || 'It may not support your game version yet.');
  const loaded = s.skseResults.results.filter(r => r.ok).map(r => r.dll);
  const notSeen = s.sksePlugins.filter(d => !s.skseResults.results.some(r => r.dll.toLowerCase() === d.toLowerCase()));
  if (notSeen.length && s.skseResults.exists) add('info', 'New SKSE plugins not tested yet', `${notSeen.join(', ')} — launch the game once and come back to see if they load.`);
  if (loaded.length) add('ok', `${loaded.length} SKSE plugin${loaded.length > 1 ? 's' : ''} loaded last launch`, loaded.join(', '));

  if (s.client.problems.length) add('info', 'Warnings in the last Skyrim Together session', s.client.problems.slice(-5).join('\n'));

  const serverIni = readText(path.join(paths.strDir, 'config', 'STServer.ini'));
  if (serverIni) {
    const ini = new IniDoc(serverIni);
    if (!ini.get('GameServer', 'sPassword')) add('info', 'Your server has no password', 'Anyone who knows your IP can join.', { action: 'goto', page: 'config', label: 'Set one' });
    if (ini.get('LiveServices', 'bAnnounceServer') === 'true') add('info', 'Your server is on the public list', 'Turn it off if you only play with friends.', { action: 'goto', page: 'config', label: 'Change' });
  }

  if (s.manager === 'Vortex') add('info', 'Vortex manages your mods', 'Files this app moves may show as "externally changed" in Vortex — choose to keep the changes when asked.');

  const rank = { error: 0, warn: 1, info: 2, ok: 3 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

function findInBackups(backups, names) {
  const want = new Set(names.map(n => n.toLowerCase()));
  const items = [];
  for (const b of backups.list()) {
    for (const f of b.files) {
      const base = path.basename(f.rel).toLowerCase().replace(/\.bsa$/, '');
      const plugin = [...want].find(w => base === w.replace(/\.(esp|esm|esl)$/, '') || base === w);
      if (plugin) items.push({ batch: b.id, rel: f.rel });
    }
  }
  return items;
}

module.exports = { snapshot, checks };
