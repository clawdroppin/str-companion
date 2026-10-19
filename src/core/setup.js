'use strict';
/**
 * "Set up from a friend's code": turns a host's parsed setup code plus this PC's state into an ordered
 * plan, and picks the exact Nexus file that matches what the host installed. Pure functions; the
 * Electron side does the downloading and installing.
 */
const { compareVersions } = require('./util');
const { matchPlan } = require('./share');

/** Installed first, in this order: everything else depends on them. */
const FOUNDATION = [69993, 30379, 32444, 266]; // Skyrim Together, SKSE, Address Library, USSEP

/**
 * @param host   parsed setup code (share.parseCode)
 * @param local  {
 *   gameVersion, mine (my setup, as share.compare expects), onDisk, implicit (plugin names),
 *   installed: Map<nexusId, {version, manager}>, ccExtra: Creation Club plugins I have and could move
 * }
 */
function buildPlan(host, local) {
  const steps = [];
  steps.push({
    id: 'game', kind: 'game',
    status: !host.gameVersion || host.gameVersion === local.gameVersion ? 'done' : 'blocked',
    title: `Skyrim ${host.gameVersion || '?'}`,
    detail: host.gameVersion === local.gameVersion
      ? 'Same game version as the host.'
      : `You have ${local.gameVersion || 'an unknown version'}; the host has ${host.gameVersion}. Steam only offers the latest version, so whoever is behind should update (or the host should hold off). Mods built for one version may not load on the other.`,
  });

  const byId = new Map();
  for (const m of host.mods) if (!byId.has(m.nexusId)) byId.set(m.nexusId, m);
  const ordered = [
    ...FOUNDATION.filter(id => byId.has(id)).map(id => byId.get(id)),
    ...[...byId.values()].filter(m => !FOUNDATION.includes(m.nexusId)),
  ];
  const onDisk = new Set(local.onDisk.map(s => s.toLowerCase()));
  const pluginsOf = id => Object.entries(host.nexusIds || {}).filter(([, v]) => v === id).map(([k]) => k);

  for (const m of ordered) {
    const have = local.installed.get(m.nexusId);
    const plugins = pluginsOf(m.nexusId);
    const pluginsPresent = plugins.length > 0 && plugins.every(p => onDisk.has(p.toLowerCase()));
    let status = 'needed';
    let detail = m.version ? `Version ${m.version}` : 'Latest version';
    if (have) {
      const same = !m.version || !have.version || compareVersions(m.version, have.version) === 0;
      if (same) { status = 'done'; detail = `Installed${have.version ? ` (${have.version})` : ''}`; }
      else if (have.manager === 'Vortex') { status = 'vortex'; detail = `You have ${have.version}, the host has ${m.version}. Update it in Vortex.`; }
      else { status = 'update'; detail = `You have ${have.version}, the host has ${m.version}.`; }
    } else if (pluginsPresent) {
      status = 'done';
      detail = 'Its plugins are already installed.';
    }
    steps.push({ id: `mod-${m.nexusId}`, kind: 'mod', status, title: m.name || `Nexus mod ${m.nexusId}`, detail, mod: m, plugins });
  }

  // Plugins the host has that no known Nexus mod provides: only the host can say where they came from.
  const covered = new Set(Object.keys(host.nexusIds || {}).map(s => s.toLowerCase()));
  const implicit = new Set(local.implicit.map(s => s.toLowerCase()));
  const unknown = host.plugins.filter(p => !onDisk.has(p.toLowerCase()) && !covered.has(p.toLowerCase()) && !implicit.has(p.toLowerCase()));
  if (unknown.length) {
    steps.push({
      id: 'unknown', kind: 'unknown', status: 'blocked', title: `${unknown.length} plugin${unknown.length > 1 ? 's' : ''} from unknown mods`,
      detail: `${unknown.join(', ')} — the host installed ${unknown.length > 1 ? 'these' : 'this'} without a mod manager, so ask them which mod${unknown.length > 1 ? 's' : ''} to get.`,
    });
  }

  const hostPlugins = new Set(host.plugins.map(s => s.toLowerCase()));
  const ccExtra = (local.ccExtra || []).filter(p => !hostPlugins.has(p.toLowerCase()));
  steps.push({
    id: 'cleanup', kind: 'cleanup', status: ccExtra.length ? 'needed' : 'done',
    title: 'Anniversary Edition content',
    detail: ccExtra.length ? `Move ${ccExtra.length} add-on${ccExtra.length > 1 ? 's' : ''} the host doesn't use to backup.` : 'Matches the host.',
    plugins: ccExtra,
  });

  const lo = matchPlan(local.mine, host, { onDisk: local.onDisk, implicit: local.implicit });
  // Plugins still to be installed also need putting in the host's order once they arrive.
  const loNeeded = lo.changes > 0 || lo.missing.length > 0;
  steps.push({
    id: 'loadorder', kind: 'loadorder', status: loNeeded ? 'needed' : 'done',
    title: 'Load order',
    detail: lo.changes ? 'Reorder and switch plugins on or off to match the host.'
      : lo.missing.length ? 'Matched to the host once the mods above are installed.' : 'Matches the host.',
    plan: lo,
  });

  return { steps, remaining: steps.filter(s => s.status === 'needed' || s.status === 'update').length };
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** "SkyUI_5_2_SE-12604-5-2SE-1700000000.7z" -> "SkyUI_5_2_SE" (Nexus appends mod id, version and upload time). */
function archiveBase(fileName) {
  const stem = String(fileName || '').replace(/\.(7z|zip|rar)$/i, '');
  const m = stem.match(/^(.*?)-\d+-[0-9A-Za-z-]+-\d{9,}$/);
  return m ? m[1] : stem;
}

/**
 * Picks the Nexus file that matches what the host installed: same version first, then the archive
 * name, then main files over optional ones. Old versions are allowed, since matching the host matters
 * more than being newest.
 */
function pickFile(filesResponse, mod) {
  const files = (filesResponse.files || []).filter(f => !['ARCHIVED', 'DELETED'].includes(f.category_name));
  if (!files.length) return null;
  const hint = norm(archiveBase(mod.fileHint) || mod.name);
  const score = f => {
    let s = 0;
    if (mod.version && f.version && compareVersions(f.version, mod.version) === 0) s += 100;
    const base = norm(archiveBase(f.file_name));
    if (hint && (base === hint || norm(f.name) === hint)) s += 40;
    else if (hint && base.startsWith(hint)) s += 15;
    s += { MAIN: 20, UPDATE: 6, OPTIONAL: 4, MISCELLANEOUS: 2, OLD_VERSION: 0 }[f.category_name] || 0;
    return s;
  };
  const ranked = files
    .map(f => ({ f, s: score(f) }))
    .sort((a, b) => b.s - a.s || (b.f.uploaded_timestamp || 0) - (a.f.uploaded_timestamp || 0));
  const best = ranked[0].f;
  return { file: best, exactVersion: !!(mod.version && best.version && compareVersions(best.version, mod.version) === 0) };
}

/**
 * The link Nexus's "Mod Manager Download" button opens:
 * nxm://skyrimspecialedition/mods/12604/files/35407?key=...&expires=...&user_id=...
 */
function parseNxm(url) {
  const m = String(url).match(/^nxm:\/\/([a-z0-9]+)\/mods\/(\d+)\/files\/(\d+)\/?(?:\?(.*))?$/i);
  if (!m) return null;
  const q = new URLSearchParams(m[4] || '');
  return {
    game: m[1].toLowerCase(),
    modId: Number(m[2]),
    fileId: Number(m[3]),
    key: q.get('key'),
    expires: q.get('expires'),
    userId: q.get('user_id'),
  };
}

module.exports = { buildPlan, pickFile, parseNxm, FOUNDATION };
