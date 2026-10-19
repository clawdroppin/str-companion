'use strict';
/**
 * Runs a FOMOD installer (fomod/ModuleConfig.xml) non-interactively with the author's defaults:
 * required options, recommended options, and the first usable option where one must be picked.
 * That's what you'd get by clicking "Next" through the installer in Vortex or MO2.
 */
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const { resolveCIStrict, walkFiles, isInside } = require('./util');

const ARRAYS = new Set(['file', 'folder', 'plugin', 'group', 'installStep', 'pattern', 'flag', 'fileDependency', 'flagDependency', 'dependencies', 'gameDependency', 'fommDependency']);

/** ModuleConfig.xml is often UTF-16; decode by BOM, or by the zero bytes UTF-16 leaves in ASCII text. */
function decodeXml(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf.length > 1 && buf[1] === 0 && buf[0] !== 0) return buf.toString('utf16le');
  return buf.toString('utf8');
}

function parseConfig(file) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    isArray: name => ARRAYS.has(name),
  });
  const xml = parser.parse(decodeXml(fs.readFileSync(file)));
  if (!xml.config) throw new Error('Not a FOMOD installer');
  return xml.config;
}

const arr = x => (x == null ? [] : Array.isArray(x) ? x : [x]);

/** FOMOD "order" attribute: Explicit keeps the file's order, Ascending/Descending sort by name. */
function ordered(items, order) {
  if (!order || order === 'Explicit') return items;
  const sorted = [...items].sort((a, b) => String(a['@name']).localeCompare(String(b['@name'])));
  return order === 'Descending' ? sorted.reverse() : sorted;
}

/** Evaluates a composite dependency (also used for step visibility). Unknown kinds count as met. */
function depsMet(node, ctx) {
  if (Array.isArray(node)) return node.every(n => depsMet(n, ctx));
  if (!node || typeof node !== 'object') return true;
  const results = [
    ...arr(node.fileDependency).map(d => fileState(String(d['@file'] || ''), ctx) === d['@state']),
    ...arr(node.flagDependency).map(d => (ctx.flags[d['@flag']] || '') === (d['@value'] || '')),
    ...arr(node.gameDependency).map(() => true),
    ...arr(node.fommDependency).map(() => true),
    ...arr(node.dependencies).map(d => depsMet(d, ctx)),
  ];
  if (!results.length) return true;
  return node['@operator'] === 'Or' ? results.some(Boolean) : results.every(Boolean);
}

function fileState(name, ctx) {
  const k = name.toLowerCase();
  if (ctx.active.has(k)) return 'Active';
  if (ctx.onDisk.has(k)) return 'Inactive';
  return 'Missing';
}

function pluginType(plugin, ctx) {
  const td = plugin.typeDescriptor || {};
  if (td.type) return td.type['@name'];
  const dt = td.dependencyType;
  if (dt) {
    for (const p of arr(dt.patterns && dt.patterns.pattern)) if (depsMet(p.dependencies, ctx)) return p.type && p.type['@name'];
    return dt.defaultType && dt.defaultType['@name'];
  }
  return 'Optional';
}

/** Which options of a group get picked, following the group's rule and the author's recommendations. */
function selectInGroup(group, ctx) {
  const plugins = ordered(arr(group.plugins && group.plugins.plugin), group.plugins && group.plugins['@order'])
    .map(p => ({ p, type: pluginType(p, ctx) }))
    .filter(x => x.type !== 'NotUsable');
  const req = plugins.filter(x => x.type === 'Required');
  const rec = plugins.filter(x => x.type === 'Recommended');
  switch (group['@type']) {
    case 'SelectAll': return plugins;
    case 'SelectExactlyOne': return [req[0] || rec[0] || plugins[0]].filter(Boolean);
    case 'SelectAtMostOne': return [req[0] || rec[0]].filter(Boolean);
    case 'SelectAtLeastOne': { const pick = [...req, ...rec]; return pick.length ? pick : plugins.slice(0, 1); }
    default: return [...req, ...rec]; // SelectAny
  }
}

/**
 * Works out what to install.
 * @param root   folder that contains fomod/ (the extracted archive)
 * @param state  { active: plugin names loaded now, onDisk: plugin names in Data }
 * @returns { files: [{from, to}], choices: [{step, group, option}], moduleName }
 *          `to` is relative to the Data folder.
 */
function resolve(root, state = {}) {
  const cfgFile = resolveCIStrict(root, 'fomod', 'ModuleConfig.xml');
  const cfg = parseConfig(cfgFile);
  const ctx = {
    flags: {},
    active: new Set((state.active || []).map(s => s.toLowerCase())),
    onDisk: new Set((state.onDisk || []).map(s => s.toLowerCase())),
  };
  const entries = [];
  const addFiles = node => {
    if (!node) return;
    for (const f of arr(node.file)) entries.push({ kind: 'file', source: f['@source'], destination: f['@destination'], priority: Number(f['@priority']) || 0 });
    for (const f of arr(node.folder)) entries.push({ kind: 'folder', source: f['@source'], destination: f['@destination'], priority: Number(f['@priority']) || 0 });
  };

  addFiles(cfg.requiredInstallFiles);
  const choices = [];
  const steps = ordered(arr(cfg.installSteps && cfg.installSteps.installStep), cfg.installSteps && cfg.installSteps['@order']);
  for (const step of steps) {
    if (step.visible && !depsMet(step.visible, ctx)) continue;
    const groups = ordered(arr(step.optionalFileGroups && step.optionalFileGroups.group), step.optionalFileGroups && step.optionalFileGroups['@order']);
    for (const g of groups) {
      for (const { p } of selectInGroup(g, ctx)) {
        choices.push({ step: step['@name'] || '', group: g['@name'] || '', option: p['@name'] || '' });
        addFiles(p.files);
        for (const fl of arr(p.conditionFlags && p.conditionFlags.flag)) ctx.flags[fl['@name']] = typeof fl === 'object' ? String(fl['#text'] ?? '') : String(fl);
      }
    }
  }
  for (const pat of arr(cfg.conditionalFileInstalls && cfg.conditionalFileInstalls.patterns && cfg.conditionalFileInstalls.patterns.pattern)) {
    if (depsMet(pat.dependencies, ctx)) addFiles(pat.files);
  }

  // Lower priority first, so higher-priority files overwrite them.
  entries.sort((a, b) => a.priority - b.priority);
  const out = new Map();
  for (const e of entries) {
    const src = resolveCIStrict(root, ...String(e.source || '').split(/[\\/]+/).filter(Boolean));
    if (!isInside(root, src)) continue;
    let dest = String(e.destination ?? (e.kind === 'file' ? e.source : '')).replace(/\\/g, '/').replace(/^\/+/, '');
    if (e.kind === 'file') {
      if (!fs.existsSync(src)) continue;
      if (!dest || dest.endsWith('/')) dest += path.basename(src);
      out.set(dest.toLowerCase(), { from: src, to: path.normalize(dest) });
    } else {
      for (const rel of walkFiles(src)) {
        const to = path.normalize(path.join(dest, rel));
        out.set(to.toLowerCase(), { from: path.join(src, rel), to });
      }
    }
  }
  return { files: [...out.values()], choices, moduleName: cfg.moduleName && (cfg.moduleName['#text'] || cfg.moduleName) };
}

module.exports = { resolve, decodeXml };
