'use strict';
const zlib = require('zlib');

const PREFIX = 'STR1-';

/** A compact, pasteable summary of everything that has to match between co-op players. */
function makeCode(snapshot) {
  const payload = {
    n: snapshot.playerName || '',
    g: snapshot.gameVersion,
    t: snapshot.strVersion,
    s: snapshot.skseVersion,
    a: snapshot.addressLibrary ? 1 : 0,
    p: snapshot.plugins,
    k: snapshot.sksePlugins,
  };
  return PREFIX + zlib.deflateRawSync(Buffer.from(JSON.stringify(payload))).toString('base64url');
}

function parseCode(code) {
  const s = String(code).trim();
  if (!s.startsWith(PREFIX)) throw new Error('That isn\'t an STR Companion setup code (they start with STR1-).');
  const p = JSON.parse(zlib.inflateRawSync(Buffer.from(s.slice(PREFIX.length), 'base64url')).toString());
  return {
    playerName: p.n, gameVersion: p.g, strVersion: p.t, skseVersion: p.s,
    addressLibrary: !!p.a, plugins: p.p || [], sksePlugins: p.k || [],
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

module.exports = { makeCode, parseCode, compare };
