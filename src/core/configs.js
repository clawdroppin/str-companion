'use strict';
const fs = require('fs');
const path = require('path');
const { IniDoc, inferType } = require('./ini');
const { exists, readText, readJson, writeJson, resolveCI } = require('./util');

const META = readJson(path.join(__dirname, '..', '..', 'data', 'config-meta.json'), {});
const BUILTIN_PRESETS = readJson(path.join(__dirname, '..', '..', 'data', 'presets.json'), {});

/** Config files the app knows how to edit. */
function configFiles(paths) {
  return [
    { id: 'server', title: 'Skyrim Together server', file: resolveCI(paths.strDir, 'config', 'STServer.ini'), note: 'Changes apply the next time the server starts.' },
    { id: 'prefs', title: 'Game settings (SkyrimPrefs.ini)', file: resolveCI(paths.myGames, 'SkyrimPrefs.ini'), note: 'Close the game before saving; Skyrim rewrites this file when it exits.' },
    { id: 'skyrim', title: 'Engine settings (Skyrim.ini)', file: resolveCI(paths.myGames, 'Skyrim.ini'), note: 'Close the game before saving.' },
    { id: 'custom', title: 'Custom overrides (SkyrimCustom.ini)', file: resolveCI(paths.myGames, 'SkyrimCustom.ini'), note: 'Settings here override Skyrim.ini and SkyrimPrefs.ini.' },
    { id: 'enginefixes', title: 'Engine Fixes', file: resolveCI(paths.dataDir, 'SKSE', 'Plugins', 'EngineFixes.toml'), toml: true, note: 'Only used if Engine Fixes is installed.' },
    { id: 'displaytweaks', title: 'SSE Display Tweaks', file: resolveCI(paths.dataDir, 'SKSE', 'Plugins', 'SSEDisplayTweaks.ini'), note: 'Only used if SSE Display Tweaks is installed.' },
  ].map(c => ({ ...c, exists: exists(c.file) }));
}

function findFile(paths, id) {
  const c = configFiles(paths).find(f => f.id === id);
  if (!c) throw new Error(`Unknown config ${id}`);
  return c;
}

function load(paths, id) {
  const c = findFile(paths, id);
  const text = readText(c.file, '');
  const doc = new IniDoc(text, { toml: !!c.toml });
  const meta = META[id] || {};
  const entries = doc.entries().map(e => {
    const m = meta[`${e.section}/${e.key}`] || meta[e.key] || {};
    return {
      ...e,
      label: m.label || e.key,
      desc: m.desc || e.doc || '',
      type: m.type || inferType(e.key, e.value),
      options: m.options || null,
      min: m.min, max: m.max, step: m.step,
      group: m.group || e.section || 'General',
      featured: !!m.label,
      warn: m.warn || null,
    };
  });
  // Featured settings that are missing from the file can still be set.
  for (const [k, m] of Object.entries(meta)) {
    if (!k.includes('/') || m.hideIfMissing) continue;
    const [section, key] = k.split('/');
    if (entries.some(e => e.section.toLowerCase() === section.toLowerCase() && e.key.toLowerCase() === key.toLowerCase())) continue;
    entries.push({ section, key, value: m.default ?? '', label: m.label || key, desc: m.desc || '', type: m.type || 'string', options: m.options || null, min: m.min, max: m.max, step: m.step, group: m.group || section, featured: true, missing: true, warn: m.warn || null });
  }
  return { ...c, entries, sections: doc.sections() };
}

/** Applies {section, key, value} changes, snapshotting the file first. Returns the number of changed values. */
function save(paths, id, changes, backups) {
  const c = findFile(paths, id);
  const text = readText(c.file, '');
  const doc = new IniDoc(text, { toml: !!c.toml });
  let changed = 0;
  for (const ch of changes) if (doc.set(ch.section, ch.key, ch.value)) changed++;
  if (!changed) return { changed: 0 };
  const snapshot = backups && exists(c.file) ? backups.snapshotConfig(c.file) : null;
  fs.mkdirSync(path.dirname(c.file), { recursive: true });
  // Writing in place keeps the file's identity, so Vortex's hard links stay intact.
  fs.writeFileSync(c.file, doc.toString());
  return { changed, snapshot };
}

function userPresetsFile(appDataDir) {
  return path.join(appDataDir, 'user-presets.json');
}

function presets(id, appDataDir) {
  const builtin = (BUILTIN_PRESETS[id] || []).map(p => ({ ...p, builtin: true }));
  const user = (readJson(userPresetsFile(appDataDir), {})[id] || []).map(p => ({ ...p, builtin: false }));
  return [...builtin, ...user];
}

function saveUserPreset(appDataDir, id, name, values) {
  const all = readJson(userPresetsFile(appDataDir), {});
  all[id] = (all[id] || []).filter(p => p.name !== name);
  all[id].push({ name, description: 'Saved by you', values });
  writeJson(userPresetsFile(appDataDir), all);
}

function deleteUserPreset(appDataDir, id, name) {
  const all = readJson(userPresetsFile(appDataDir), {});
  all[id] = (all[id] || []).filter(p => p.name !== name);
  writeJson(userPresetsFile(appDataDir), all);
}

/** Preset values are stored as {"Section/key": value}. */
function presetToChanges(values) {
  return Object.entries(values).map(([k, value]) => {
    const i = k.indexOf('/');
    return { section: k.slice(0, i), key: k.slice(i + 1), value };
  });
}

module.exports = { configFiles, load, save, presets, saveUserPreset, deleteUserPreset, presetToChanges };
