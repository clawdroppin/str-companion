'use strict';
const fs = require('fs');
const path = require('path');
const { readText, listDir, exists, resolveCI } = require('./util');

const BASE_MASTERS = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'];

/** The four free Creation Club files every copy of the game has since 1.6.1130; USSEP needs them as masters. */
const FREE_CC = ['ccBGSSSE001-Fish.esm', 'ccQDRSSE001-SurvivalMode.esl', 'ccBGSSSE037-Curios.esl', 'ccBGSSSE025-AdvDSGS.esm'];

/** Base-game files that must never be moved, even though some are listed in Skyrim.ccc. */
const PROTECTED = new Set([...BASE_MASTERS, '_ResourcePack.esl', 'SkyrimTogether.esp', 'SkyrimTogetherQuestPatches.esp'].map(s => s.toLowerCase()));

const PLUGIN_RE = /\.(esp|esm|esl)$/i;
const CC_RE = /^cc[a-z]+sse\d{3}/i;

/** Parses a plugin's TES4 header: flags and master list. */
function readHeader(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(24);
    if (fs.readSync(fd, head, 0, 24, 0) < 24 || head.toString('latin1', 0, 4) !== 'TES4') return null;
    const size = head.readUInt32LE(4);
    const flags = head.readUInt32LE(8);
    const data = Buffer.alloc(Math.min(size, 1 << 20));
    fs.readSync(fd, data, 0, data.length, 24);
    const masters = [];
    let author = '', description = '';
    for (let o = 0; o + 6 <= data.length;) {
      const type = data.toString('latin1', o, o + 4);
      const len = data.readUInt16LE(o + 4);
      const body = data.subarray(o + 6, o + 6 + len);
      const z = s => s.toString('latin1').replace(/\0.*$/s, '');
      if (type === 'MAST') masters.push(z(body));
      else if (type === 'CNAM') author = z(body);
      else if (type === 'SNAM') description = z(body);
      o += 6 + len;
    }
    return {
      masters,
      author,
      description,
      isMaster: !!(flags & 0x1),
      isLight: !!(flags & 0x200) || /\.esl$/i.test(file),
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readPluginsTxt(file) {
  const text = readText(file, '');
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const active = t.startsWith('*');
    entries.push({ name: active ? t.slice(1) : t, active });
  }
  return entries;
}

function writePluginsTxt(file, entries) {
  const text = readText(file, '');
  const header = text.split(/\r?\n/).filter(l => l.trim().startsWith('#'));
  const lines = [...header, ...entries.map(e => (e.active ? '*' : '') + e.name)];
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n');
}

/** Removes plugins from Plugins.txt and loadorder.txt. Returns the names that were active. */
function removeFromLists(localAppDir, names) {
  const lower = new Set(names.map(n => n.toLowerCase()));
  const pluginsTxt = resolveCI(localAppDir, 'Plugins.txt');
  const wasActive = [];
  if (exists(pluginsTxt)) {
    const entries = readPluginsTxt(pluginsTxt);
    for (const e of entries) if (lower.has(e.name.toLowerCase()) && e.active) wasActive.push(e.name);
    writePluginsTxt(pluginsTxt, entries.filter(e => !lower.has(e.name.toLowerCase())));
  }
  const lo = resolveCI(localAppDir, 'loadorder.txt');
  if (exists(lo)) {
    const text = readText(lo, '');
    const kept = text.split(/\r?\n/).filter(l => l && !lower.has(l.trim().toLowerCase()));
    fs.writeFileSync(lo, kept.join('\r\n') + '\r\n');
  }
  return wasActive;
}

/** Adds plugins to the end of Plugins.txt as active (no-op for ones already listed). */
function addToPluginsTxt(localAppDir, names) {
  const file = resolveCI(localAppDir, 'Plugins.txt');
  const entries = exists(file) ? readPluginsTxt(file) : [];
  for (const n of names) {
    const hit = entries.find(e => e.name.toLowerCase() === n.toLowerCase());
    if (hit) hit.active = true;
    else entries.push({ name: n, active: true });
  }
  fs.mkdirSync(localAppDir, { recursive: true });
  writePluginsTxt(file, entries);
}

function readCcc(gameDir) {
  return readText(resolveCI(gameDir, 'Skyrim.ccc'), '')
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

/**
 * Works out the order the game will actually load plugins in:
 * base masters, then Creation Club files listed in Skyrim.ccc that exist, then Plugins.txt actives.
 */
function effectiveLoadOrder(gameDir, localAppDir) {
  const dataDir = resolveCI(gameDir, 'Data');
  const onDisk = new Map();
  for (const e of listDir(dataDir)) if (e.isFile() && PLUGIN_RE.test(e.name)) onDisk.set(e.name.toLowerCase(), e.name);

  const order = [];
  const seen = new Set();
  const push = (name, source) => {
    const k = name.toLowerCase();
    if (seen.has(k) || !onDisk.has(k)) return;
    seen.add(k);
    order.push({ name: onDisk.get(k), source });
  };
  BASE_MASTERS.forEach(n => push(n, 'base'));
  readCcc(gameDir).forEach(n => push(n, 'creation-club'));
  const listed = readPluginsTxt(resolveCI(localAppDir, 'Plugins.txt'));
  // Masters (ESM / ESL-flagged ESM) load before regular plugins regardless of list order.
  const actives = listed.filter(e => e.active && onDisk.has(e.name.toLowerCase()));
  const withHeaders = actives.map(e => ({ e, h: readHeader(path.join(dataDir, onDisk.get(e.name.toLowerCase()))) }));
  withHeaders.filter(x => x.h && x.h.isMaster).forEach(x => push(x.e.name, 'plugins.txt'));
  withHeaders.filter(x => !x.h || !x.h.isMaster).forEach(x => push(x.e.name, 'plugins.txt'));

  const inactive = [...onDisk.values()].filter(n => !seen.has(n.toLowerCase()));
  return { order, inactive };
}

/** For every loaded plugin, lists masters that are missing or load after it. */
function checkMasters(gameDir, order) {
  const dataDir = resolveCI(gameDir, 'Data');
  const pos = new Map(order.map((p, i) => [p.name.toLowerCase(), i]));
  const problems = [];
  order.forEach((p, i) => {
    const h = readHeader(path.join(dataDir, p.name));
    if (!h) return;
    for (const m of h.masters) {
      const at = pos.get(m.toLowerCase());
      if (at === undefined) problems.push({ plugin: p.name, master: m, kind: 'missing' });
      else if (at > i) problems.push({ plugin: p.name, master: m, kind: 'order' });
    }
  });
  return problems;
}

/** Archives that belong to a plugin: "Name.bsa", "Name - Textures.bsa", etc. */
function companionArchives(dataDir, pluginName) {
  const base = pluginName.replace(PLUGIN_RE, '').toLowerCase();
  return listDir(dataDir)
    .filter(e => e.isFile() && /\.bsa$/i.test(e.name))
    .map(e => e.name)
    .filter(n => {
      const b = n.replace(/\.bsa$/i, '').toLowerCase();
      return b === base || b.startsWith(base + ' - ');
    });
}

function isFreeCc(name) {
  return FREE_CC.some(f => f.toLowerCase() === name.toLowerCase());
}

/** Creation Club plugins present in Data, with their archives. */
function creationClubFiles(gameDir) {
  const dataDir = resolveCI(gameDir, 'Data');
  const ccc = new Set(readCcc(gameDir).map(s => s.toLowerCase()));
  return listDir(dataDir)
    .filter(e => e.isFile() && PLUGIN_RE.test(e.name) && !PROTECTED.has(e.name.toLowerCase())
      && (CC_RE.test(e.name) || ccc.has(e.name.toLowerCase())))
    .map(e => ({
      plugin: e.name,
      archives: companionArchives(dataDir, e.name),
      free: isFreeCc(e.name),
    }));
}

module.exports = {
  BASE_MASTERS, FREE_CC, PROTECTED, PLUGIN_RE, readHeader, readPluginsTxt, writePluginsTxt, removeFromLists,
  addToPluginsTxt, readCcc, effectiveLoadOrder, checkMasters, companionArchives, creationClubFiles, isFreeCc,
};
