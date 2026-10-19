'use strict';
const zlib = require('zlib');

const PREFIX = 'STR2-';

/**
 * A compact, pasteable summary of everything that has to match between co-op players.
 * v2 also carries the Nexus id of each plugin's mod (when known) so friends get download links.
 */
function makeCode(snapshot) {
  const payload = {
    n: snapshot.playerName || '',
    g: snapshot.gameVersion,
    t: snapshot.strVersion,
    s: snapshot.skseVersion,
    a: snapshot.addressLibrary ? 1 : 0,
    p: snapshot.plugins,
    k: snapshot.sksePlugins,
    x: snapshot.nexusIds || {},
    // Every Nexus mod installed, including ones without plugins (SKSE, Address Library, DLL fixes),
    // with the exact version and archive name so a friend's app can fetch the same file.
    m: (snapshot.mods || []).map(m => ({ i: m.nexusId, v: m.version || null, n: m.name || '', f: m.fileHint || '' })),
  };
  return PREFIX + zlib.deflateRawSync(Buffer.from(JSON.stringify(payload))).toString('base64url');
}

function parseCode(code) {
  const s = String(code).trim();
  const m = s.match(/^STR([12])-([A-Za-z0-9_-]+)$/);
  if (!m) throw new Error("That isn't an STR Companion setup code. Codes start with STR2- (or STR1- from older versions) — make sure you copied the whole thing.");
  let p;
  try {
    p = JSON.parse(zlib.inflateRawSync(Buffer.from(m[2], 'base64url')).toString());
  } catch {
    throw new Error('That setup code is damaged or incomplete — ask your friend to copy it again.');
  }
  return {
    playerName: p.n, gameVersion: p.g, strVersion: p.t, skseVersion: p.s,
    addressLibrary: !!p.a, plugins: p.p || [], sksePlugins: p.k || [], nexusIds: p.x || {},
    mods: (p.m || []).filter(m => Number.isInteger(m.i) && m.i > 0)
      .map(m => ({ nexusId: m.i, version: m.v || null, name: String(m.n || ''), fileHint: String(m.f || '') })),
  };
}

/** Lists what differs between two setups, most serious first. */
function compare(mine, theirs) {
  const diffs = [];
  const add = (level, text) => diffs.push({ level, text });
  if (mine.gameVersion !== theirs.gameVersion) add('error', `Game version: you have ${mine.gameVersion}, they have ${theirs.gameVersion}.`);
  if (mine.strVersion !== theirs.strVersion) add('error', `Skyrim Together: you have ${mine.strVersion || 'unknown'}, they have ${theirs.strVersion || 'unknown'}.`);
  if (!theirs.skseVersion) add('warn', 'They don\'t have SKSE installed.');
  else if (mine.skseVersion !== theirs.skseVersion) add('warn', `SKSE: you have ${mine.skseVersion}, they have ${theirs.skseVersion}.`);
  if (!theirs.addressLibrary) add('warn', 'They\'re missing Address Library (or it doesn\'t match their game version).');

  const lower = a => a.map(x => x.toLowerCase());
  const mp = lower(mine.plugins), tp = lower(theirs.plugins);
  const onlyMine = mine.plugins.filter(p => !tp.includes(p.toLowerCase()));
  const onlyTheirs = theirs.plugins.filter(p => !mp.includes(p.toLowerCase()));
  for (const p of onlyMine) add('error', `They're missing ${p}.`);
  for (const p of onlyTheirs) add('error', `They have ${p}, which you don't.`);
  if (!onlyMine.length && !onlyTheirs.length) {
    const firstDiff = mp.findIndex((p, i) => p !== tp[i]);
    if (firstDiff >= 0) add('error', `Same plugins but a different load order, starting at #${firstDiff + 1} (${mine.plugins[firstDiff]} vs ${theirs.plugins[firstDiff]}).`);
  }
  const ms = lower(mine.sksePlugins), ts = lower(theirs.sksePlugins);
  for (const d of mine.sksePlugins.filter(p => !ts.includes(p.toLowerCase()))) add('info', `They don't have the SKSE plugin ${d} (only matters for stability).`);
  for (const d of theirs.sksePlugins.filter(p => !ms.includes(p.toLowerCase()))) add('info', `They have the SKSE plugin ${d}, which you don't.`);
  const order = { error: 0, warn: 1, info: 2 };
  return diffs.sort((a, b) => order[a.level] - order[b.level]);
}

/** True when the plugin lists are identical in content and order (the part Skyrim Together syncs on). */
function pluginsMatch(mine, theirs) {
  return mine.plugins.length === theirs.plugins.length
    && mine.plugins.every((p, i) => p.toLowerCase() === String(theirs.plugins[i]).toLowerCase());
}

/**
 * What it takes to make my load order match theirs.
 * @param mine     my setup (plugins = my effective load order)
 * @param theirs   their parsed setup code
 * @param local    { onDisk: all plugin files in my Data, implicit: plugins my game loads on its own }
 */
function matchPlan(mine, theirs, local) {
  const low = s => s.toLowerCase();
  const onDisk = new Set(local.onDisk.map(low));
  const implicit = new Set(local.implicit.map(low));
  const mineActive = new Set(mine.plugins.map(low));
  const theirSet = new Set(theirs.plugins.map(low));

  const missing = theirs.plugins
    .filter(p => !onDisk.has(low(p)))
    .map(p => ({ name: p, nexusId: theirs.nexusIds[p] || theirs.nexusIds[low(p)] || null }));
  const activate = theirs.plugins.filter(p => onDisk.has(low(p)) && !mineActive.has(low(p)) && !implicit.has(low(p)));
  const deactivate = mine.plugins.filter(p => !theirSet.has(low(p)) && !implicit.has(low(p)));
  // Plugins the game loads by itself (Creation Club) can't be switched off in Plugins.txt; they have to be moved.
  const extraImplicit = mine.plugins.filter(p => !theirSet.has(low(p)) && implicit.has(low(p)));
  const order = theirs.plugins.filter(p => onDisk.has(low(p)) && !implicit.has(low(p)));
  const mineOrdered = mine.plugins.filter(p => !implicit.has(low(p)) && theirSet.has(low(p))).map(low);
  const reorder = order.map(low).filter(p => mineActive.has(p)).join('|') !== mineOrdered.join('|');
  return {
    order, missing, activate, deactivate, extraImplicit, reorder,
    changes: activate.length + deactivate.length + (reorder ? 1 : 0),
  };
}

module.exports = { makeCode, parseCode, compare, pluginsMatch, matchPlan };
