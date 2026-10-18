'use strict';
const path = require('path');
const { exists, readJson, listDir, compareVersions } = require('./util');
const game = require('./game');
const { latestMainFile } = require('./nexus');

const CATALOG = readJson(path.join(__dirname, '..', '..', 'data', 'catalog.json'), { categories: [], mods: [] });

function globExists(gameDir, pattern) {
  const full = path.join(gameDir, pattern);
  if (!pattern.includes('*')) return exists(full);
  const dir = path.dirname(full);
  const re = new RegExp('^' + path.basename(full).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  return listDir(dir).some(e => re.test(e.name));
}

/**
 * Merges the curated catalog, the user's custom mods, Vortex-installed mods and mods this app installed
 * into one list with install state and version.
 */
function modList(paths, registry, customMods = [], skseResults = []) {
  const vortex = game.vortexMods(paths);
  const dllStatus = dll => {
    const r = skseResults.find(x => x.dll.toLowerCase() === String(dll).toLowerCase());
    return r ? (r.ok ? 'loaded' : 'failed') : null;
  };
  const regByNexus = new Map(Object.entries(registry).filter(([, r]) => r.nexusId).map(([k, r]) => [r.nexusId, { key: k, ...r }]));
  const describe = m => {
    const v = vortex.find(x => x.nexusId === m.id);
    const r = regByNexus.get(m.id);
    const detected = (m.detect || []).some(p => globExists(paths.gameDir, p));
    return {
      ...m,
      installed: !!(v || r || detected),
      installedVersion: (v && v.version) || (r && r.version) || null,
      manager: v ? 'Vortex' : r ? 'STR Companion' : detected ? 'Manual' : null,
      registryKey: r ? r.key : null,
      // For SKSE plugins: did it actually load on this game version last launch?
      loadStatus: m.dll ? dllStatus(m.dll) : null,
    };
  };
  const list = CATALOG.mods.map(describe);
  for (const c of customMods) if (!list.some(m => m.id === c.id)) list.push(describe({ ...c, category: 'custom', custom: true }));
  // Anything else Vortex or this app installed shows up too, so updates can be checked for it.
  for (const v of vortex) {
    if (v.nexusId && !list.some(m => m.id === v.nexusId)) list.push(describe({ id: v.nexusId, name: v.name, category: 'other', desc: 'Installed with Vortex.' }));
  }
  for (const [key, r] of Object.entries(registry)) {
    if (r.nexusId && list.some(m => m.id === r.nexusId)) continue;
    list.push({ id: r.nexusId, name: r.name, category: 'other', desc: 'Installed with STR Companion.', installed: true, installedVersion: r.version, manager: 'STR Companion', registryKey: key });
  }
  return list;
}

/** Asks Nexus for the latest version of each installed mod that has a Nexus id. */
async function checkUpdates(nexus, list) {
  const results = {};
  const targets = list.filter(m => m.id && m.installed);
  await Promise.all(targets.map(async m => {
    try {
      const info = await nexus.mod(m.id);
      const latest = info.version;
      results[m.id] = {
        latest,
        updatedAt: info.updated_time,
        summary: info.summary,
        hasUpdate: !!(m.installedVersion && latest && compareVersions(latest, m.installedVersion) > 0),
      };
    } catch (e) {
      results[m.id] = { error: e.message };
    }
  }));
  return results;
}

async function bestFile(nexus, id) {
  return latestMainFile(await nexus.files(id));
}

module.exports = { CATALOG, modList, checkUpdates, bestFile };
