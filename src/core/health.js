'use strict';
const path = require('path');
const game = require('./game');
const plugins = require('./plugins');
const cleanup = require('./cleanup');
const logs = require('./logs');
const { IniDoc } = require('./ini');
const { readText, resolveCI } = require('./util');

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
    counts: plugins.pluginCounts(paths.gameDir, lo.order),
    // Skyrim Together's plugins exist but aren't loaded, e.g. switched off in a mod manager.
    strPluginsOff: ['SkyrimTogether.esp', 'SkyrimTogetherQuestPatches.esp']
      .filter(p => lo.inactive.some(n => n.toLowerCase() === p.toLowerCase())),
    latestCrash: logs.crashReports(paths, lo.order.map(p => p.name), 1)[0] || null,
  };
}

/** Turns a snapshot into a checklist with severity and one-click fixes. */
function checks(paths, s, backups, opts = {}) {
  const out = [];
  const add = (level, title, detail, fix) => out.push({ level, title, detail, fix: fix || null });

  if (!s.gameVersion) add('warn', "Couldn't read Skyrim's version", 'SkyrimSE.exe may be missing or damaged. Verify the game files in Steam.');
  else add('ok', `Skyrim ${s.gameVersion}`, paths.gameDir);

  // Versions seen when the user last acknowledged them; a change usually means Steam updated the game.
  const seen = opts.lastSeen;
  if (seen && seen.game && s.gameVersion && seen.game !== s.gameVersion) {
    add('warn', `Skyrim was updated from ${seen.game} to ${s.gameVersion}`,
      'SKSE, Address Library, SKSE plugins and Skyrim Together all need versions for the new game. Your friends must update too — compare setup codes.',
      { action: 'ackVersions', label: 'Got it' });
  }
  if (seen && seen.str && s.str.version && seen.str !== s.str.version) {
    add('info', `Skyrim Together updated from ${seen.str} to ${s.str.version}`, 'Everyone in your group needs the same version to connect.', { action: 'ackVersions', label: 'Got it' });
  }

  if (!s.str.installed) add('error', 'Skyrim Together Reborn is not installed', 'Install it from the Mods page.', { action: 'goto', page: 'mods', label: 'Go to Mods' });
  else add('ok', `Skyrim Together Reborn ${s.str.version || ''}`.trim(), s.client.skseHooked ? 'Loaded correctly last time you played.' : 'Installed.');
  if (s.strPluginsOff.length) {
    add('error', "Skyrim Together's plugins are switched off", `${s.strPluginsOff.join(' and ')} must be active or multiplayer won't work.`,
      { action: 'activatePlugins', names: s.strPluginsOff, label: 'Switch on' });
  }

  if (!s.skse.installed) add('error', 'SKSE is not installed', 'Skyrim Together and most fixes need it.', { action: 'goto', page: 'mods', label: 'Go to Mods' });
  else if (s.gameVersion && !s.skse.builtFor.includes(s.gameVersion)) add('error', `SKSE doesn't match your game`, `SKSE is built for ${s.skse.builtFor.join(', ')} but the game is ${s.gameVersion}. Update SKSE.`);
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
  const c = s.counts;
  if (c.full > c.fullLimit) {
    add('error', `Too many full plugins (${c.full} of ${c.fullLimit})`, 'Skyrim crashes or silently drops plugins past this limit. Disable some, or ESL-flag the ones that allow it.',
      { action: 'goto', page: 'cleanup', label: 'Open Cleanup' });
  } else if (c.full > c.fullLimit - 10) {
    add('warn', `Close to the plugin limit (${c.full} of ${c.fullLimit})`, "Light (ESL) plugins don't count toward this limit.");
  }
  if (c.light > c.lightLimit) add('error', `Too many light plugins (${c.light} of ${c.lightLimit})`, 'Disable some light (ESL) plugins.');

  if (s.cc.removable.length) {
    add('warn', s.cc.removable.length === 1 ? '1 Anniversary Edition add-on is active' : `${s.cc.removable.length} Anniversary Edition add-ons are active`,
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

  const crash = s.latestCrash;
  if (crash && (!opts.crashAck || crash.at > opts.crashAck)) {
    const suspects = [...crash.modules.map(m => m.name), ...crash.plugins.map(p => p.name)].slice(0, 4);
    add('warn', `Skyrim crashed (${new Date(crash.at).toLocaleString()})`,
      [crash.exception, suspects.length ? `Mentioned most: ${suspects.join(', ')}` : null].filter(Boolean).join('\n'),
      { action: 'goto', page: 'logs', tab: 'crashes', label: 'View crash' });
  } else if (s.client.crashed && !opts.clientCrashAck) {
    add('warn', 'Skyrim crashed during the last Skyrim Together session', 'Install a crash logger (Mods → Stability) to see what caused it next time.',
      { action: 'goto', page: 'logs', tab: 'client', label: 'View log' });
  }
  if (s.client.problems.length) add('info', 'Warnings in the last Skyrim Together session', s.client.problems.slice(-5).join('\n'));

  const serverIni = readText(resolveCI(paths.strDir, 'config', 'STServer.ini'));
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
