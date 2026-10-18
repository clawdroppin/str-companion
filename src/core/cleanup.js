'use strict';
const fs = require('fs');
const path = require('path');
const plugins = require('./plugins');
const game = require('./game');
const { listDir } = require('./util');

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/** Creation Club / Anniversary content, split into what USSEP needs (keep) and the rest (safe to move). */
function creationClubReport(paths) {
  const items = plugins.creationClubFiles(paths.gameDir).map(c => ({
    ...c,
    size: [c.plugin, ...c.archives].reduce((s, f) => s + fileSize(path.join(paths.dataDir, f)), 0),
  }));
  return {
    keep: items.filter(i => i.free),
    removable: items.filter(i => !i.free),
  };
}

function relFilesFor(item) {
  return [item.plugin, ...item.archives].map(f => path.join('Data', f));
}

/** Every plugin in Data with what the user needs to decide whether to move it. */
function pluginReport(paths) {
  const { order, inactive } = plugins.effectiveLoadOrder(paths.gameDir, paths.localAppDir);
  const vortexFiles = new Map();
  for (const m of game.vortexMods(paths)) for (const f of m.files) vortexFiles.set(f.toLowerCase(), m.name);

  const all = [
    ...order.map((p, i) => ({ name: p.name, active: true, index: i, source: p.source })),
    ...inactive.map(n => ({ name: n, active: false, index: null, source: 'inactive' })),
  ];
  const headers = new Map(all.map(p => [p.name.toLowerCase(), plugins.readHeader(path.join(paths.dataDir, p.name))]));
  return all.map(p => {
    const h = headers.get(p.name.toLowerCase()) || { masters: [] };
    const archives = plugins.companionArchives(paths.dataDir, p.name);
    const dependents = all.filter(o => (headers.get(o.name.toLowerCase())?.masters || []).some(m => m.toLowerCase() === p.name.toLowerCase())).map(o => o.name);
    return {
      ...p,
      masters: h.masters,
      author: h.author,
      light: h.isLight,
      archives,
      dependents,
      size: [p.name, ...archives].reduce((s, f) => s + fileSize(path.join(paths.dataDir, f)), 0),
      protected: plugins.PROTECTED.has(p.name.toLowerCase()) || plugins.isFreeCc(p.name),
      creationClub: p.source === 'creation-club' || /^cc[a-z]+sse\d{3}/i.test(p.name),
      manager: vortexFiles.get(p.name.toLowerCase()) ? `Vortex: ${vortexFiles.get(p.name.toLowerCase())}` : null,
    };
  });
}

/** Known trouble with Skyrim Together (from the Tilted Online FAQ and community reports). */
const KNOWN_ISSUES = [
  { match: /^smoothcam\.dll$/i, where: 'skse', name: 'SmoothCam', why: 'Can stop saves from loading with Skyrim Together.' },
  { match: /^alternateconversationcamera\.dll$/i, where: 'skse', name: 'Alternate Conversation Camera', why: 'Listed as incompatible by the Skyrim Together team.' },
  { match: /^slack\.dll$/i, where: 'skse', name: 'S.L.A.C.K.', why: 'Listed as incompatible by the Skyrim Together team.' },
  { match: /^wheeler.*\.dll$/i, where: 'skse', name: 'Wheeler', why: '"Show in UI" is listed as incompatible.' },
  { match: /^kiloader/i, where: 'root', name: 'KiLoader', why: 'Listed as incompatible (often used for ENB).' },
  { match: /master occlusion field/i, where: 'plugin', name: 'Master Occlusion Field', why: 'Listed as incompatible by the Skyrim Together team.' },
  { match: /^alternate start - live another life\.esp$/i, where: 'plugin', name: 'Alternate Start', why: 'Changes how the main quest begins; everyone must choose the same start or quests desync.' },
];

function knownIssues(paths) {
  const found = [];
  const skse = game.sksePlugins(paths);
  const root = listDir(paths.gameDir).filter(e => e.isFile()).map(e => e.name);
  const data = listDir(paths.dataDir).filter(e => e.isFile()).map(e => e.name);
  for (const k of KNOWN_ISSUES) {
    const pool = k.where === 'skse' ? skse : k.where === 'root' ? root : data;
    for (const f of pool.filter(n => k.match.test(n))) {
      const rel = k.where === 'skse' ? path.join('Data', 'SKSE', 'Plugins', f) : k.where === 'root' ? f : path.join('Data', f);
      found.push({ ...k, match: undefined, file: f, rel });
    }
  }
  return found;
}

module.exports = { creationClubReport, relFilesFor, pluginReport, knownIssues, KNOWN_ISSUES };
