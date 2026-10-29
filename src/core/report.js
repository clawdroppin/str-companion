'use strict';
/**
 * One zip with everything needed to help someone: logs, recent crash reports, plugin lists, the server
 * config with passwords blanked, and a plain-text diagnostics summary.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readTail, resolveCI, exists, run, timestampId } = require('./util');
const { IniDoc } = require('./ini');
const logs = require('./logs');

const SECRET_KEYS = /password|token|apikey|api_key/i;

/** STServer.ini with every password-like value blanked. */
function sanitizeIni(text) {
  const doc = new IniDoc(text);
  for (const e of doc.entries()) if (SECRET_KEYS.test(e.key) && e.value) doc.set(e.section, e.key, '<removed>');
  return doc.toString();
}

function diagnosticsText({ appVersion, snapshot, checks, vortexMods }) {
  const s = snapshot;
  const lines = [
    `STR Companion ${appVersion} on ${process.platform} ${os.release()}`,
    `Created ${new Date().toISOString()}`,
    '',
    `Skyrim ${s.gameVersion || '?'}`,
    `Skyrim Together ${s.str.version || '?'} (${s.str.installed ? 'installed' : 'missing'})`,
    `SKSE ${s.skse.version || 'missing'} built for ${s.skse.builtFor.join(', ') || '-'}`,
    `Address Library ${s.addressLibrary.matchesGame ? 'matches game' : 'MISSING/MISMATCH'}`,
    `Plugins: ${s.counts.full} full, ${s.counts.light} light`,
    '',
    '== Checks ==',
    ...checks.map(c => `[${c.level}] ${c.title}${c.detail ? ` — ${String(c.detail).replace(/\n/g, ' | ')}` : ''}`),
    '',
    '== Load order ==',
    ...s.loadOrder.map((p, i) => `${String(i).padStart(3)} ${p.name} (${p.source})`),
    '',
    '== SKSE plugins ==',
    ...s.sksePlugins,
    '',
    '== Mods from Vortex ==',
    ...vortexMods.map(m => `${m.name} ${m.version || ''} (Nexus ${m.nexusId || '?'})`),
  ];
  return lines.join('\n') + '\n';
}

/**
 * Builds the zip. Returns its path.
 * @param zipExe path to 7-Zip
 */
async function createReport(paths, { appVersion, snapshot, checks, vortexMods, outDir, zipExe }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strc-report-'));
  try {
    const put = (name, text) => {
      const f = path.join(tmp, name);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    };
    put('diagnostics.txt', diagnosticsText({ appVersion, snapshot, checks, vortexMods }));
    for (const l of logs.logFiles(paths)) if (l.exists) put(path.join('logs', path.basename(l.file)), readTail(l.file, 2 << 20));
    for (const c of logs.crashFiles(paths).slice(0, 3)) put(path.join('crashes', c.name), readTail(c.file, 2 << 20));
    for (const n of ['Plugins.txt', 'loadorder.txt']) {
      const f = resolveCI(paths.localAppDir, n);
      if (exists(f)) put(path.join('plugins', n), fs.readFileSync(f, 'utf8'));
    }
    const ini = resolveCI(paths.strDir, 'config', 'STServer.ini');
    if (exists(ini)) put('STServer.ini', sanitizeIni(fs.readFileSync(ini, 'utf8')));

    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, `STR-Companion-report-${timestampId()}.zip`);
    const r = await run(zipExe, ['a', '-tzip', out, path.join(tmp, '*'), '-r', '-bso0', '-bsp0']);
    if (!r.ok) throw new Error(`Couldn't create the report zip: ${r.stderr.trim()}`);
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { createReport, sanitizeIni, diagnosticsText };
