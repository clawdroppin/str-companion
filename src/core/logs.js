'use strict';
const path = require('path');
const fs = require('fs');
const { readTail, exists, resolveCI, listDir } = require('./util');
const { BASE_MASTERS } = require('./plugins');

function mtime(p) {
  try { return fs.statSync(p).mtime.toISOString(); } catch { return null; }
}

/** Players currently on the server, read from the latest server session in STServerOut.log. */
function serverSession(paths) {
  const file = resolveCI(paths.strDir, 'logs', 'STServerOut.log');
  const text = readTail(file);
  const players = new Map();
  const events = [];
  let startedAt = null, version = null, port = null;
  for (const line of text.split(/\r?\n/)) {
    const ts = (line.match(/^\[([^\]]+)\]/) || [])[1] || '';
    let m;
    if ((m = line.match(/Server v([\d.]+) started on port (\d+)/))) {
      players.clear();
      events.length = 0;
      startedAt = ts; version = m[1]; port = Number(m[2]);
    } else if ((m = line.match(/New player '([^']*)' \[([0-9a-f]+)\] connected with (\d+) mods/i))) {
      players.set(m[2], { name: m[1], id: m[2], mods: Number(m[3]), since: ts });
      events.push({ ts, text: `${m[1]} joined (${m[3]} mods)` });
    } else if ((m = line.match(/Connection ended ([0-9a-f]+) - '([^']*)' disconnected/i))) {
      const p = players.get(m[1]);
      players.delete(m[1]);
      if (p || m[2] !== 'NULL') events.push({ ts, text: `${p ? p.name : m[2]} left` });
    } else if ((m = line.match(/has a bad password/i))) {
      events.push({ ts, text: 'Someone tried to join with the wrong password', warn: true });
    }
  }
  return { file, exists: exists(file), updatedAt: mtime(file), startedAt, version, port, players: [...players.values()], events: events.slice(-30) };
}

/** Warnings/errors from the Skyrim Together client log, minus known-harmless noise. */
function clientLog(paths) {
  const file = resolveCI(paths.strDir, 'logs', 'tp_client.log');
  const text = readTail(file);
  const all = text.split(/\r?\n/);
  // The log spans several launches; only the latest one matters.
  const lastStart = all.map((l, i) => (/Installing SKSE .* startup hooks/.test(l) ? i : -1)).filter(i => i >= 0).pop() ?? 0;
  const lines = all.slice(lastStart);
  const problems = lines
    // Indented lines are continuations of the harmless BehaviorVar creature-signature warning.
    .filter(l => /\] \[(warning|error|critical)\]/.test(l) && !/BehaviorVar/.test(l) && !/\[tid \d+\]\s{4,}/.test(l))
    .slice(-40);
  return {
    file,
    exists: exists(file),
    updatedAt: mtime(file),
    skseHooked: /SKSE startup hooks installed/.test(text),
    // Skyrim Together's own crash handler writes this when the game crashed during the last session.
    crashed: lines.some(l => /crash occurred/i.test(l)),
    problems,
  };
}

/** Which SKSE plugins loaded during the last launch, from skse64.log. */
function sksePluginResults(paths) {
  const file = resolveCI(paths.skseLogs, 'skse64.log');
  const text = readTail(file);
  const results = [];
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = line.match(/plugin\s+(.+?\.dll)\s*\(.*\)\s+loaded correctly/i))) results.push({ dll: path.basename(m[1]), ok: true });
    else if ((m = line.match(/couldn't load plugin\s+(.+?\.dll)(.*)/i))) results.push({ dll: path.basename(m[1]), ok: false, why: m[2].trim() });
    else if ((m = line.match(/plugin\s+(.+?\.dll).*?(disabled|incompatible|reported as incompatible)(.*)/i))) results.push({ dll: path.basename(m[1]), ok: false, why: (m[2] + m[3]).trim() });
  }
  return { file, exists: exists(file), updatedAt: mtime(file), results };
}

function tail(file, n = 200) {
  const text = readTail(file, 512 * 1024);
  return text.split(/\r?\n/).slice(-n).join('\n');
}

function logFiles(paths) {
  return [
    { id: 'server', title: 'Server', file: resolveCI(paths.strDir, 'logs', 'STServerOut.log') },
    { id: 'client', title: 'Skyrim Together client', file: resolveCI(paths.strDir, 'logs', 'tp_client.log') },
    { id: 'skse', title: 'SKSE', file: resolveCI(paths.skseLogs, 'skse64.log') },
    { id: 'skseloader', title: 'SKSE loader', file: resolveCI(paths.skseLogs, 'skse64_loader.log') },
    { id: 'enginefixes', title: 'Engine Fixes', file: resolveCI(paths.skseLogs, 'EngineFixes.log') },
  ].map(l => ({ ...l, exists: exists(l.file), updatedAt: mtime(l.file) }));
}

// ---------- crash reports ----------

/** Windows/driver/game modules that show up in nearly every crash and say nothing about the cause. */
const NOISE_MODULES = /^(ntdll|kernel32|kernelbase|ucrtbase|msvcp\d*|msvcrt|vcruntime\d*(_\d+)?|user32|win32u|gdi32|combase|rpcrt4|d3d11|d3d12|dxgi|dxgkrnl|nvwgf2umx|nvldumdx|nvoglv64|amdxx64|atidxx64|igd10iumd64|steam_api64|skyrimse|skse64_\d+_\d+_\d+)\.(dll|exe)$/i;

function readHead(file, maxBytes = 512 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, maxBytes));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Crash logs written by crash-logger SKSE plugins (Crash Logger SSE, Trainwreck) and NetScriptFramework.
 * Newest first.
 */
function crashFiles(paths) {
  const dirs = [
    { dir: paths.skseLogs, re: /^crash-.*\.log$/i, source: 'Crash Logger' },
    { dir: resolveCI(paths.skseLogs, 'Crashlogs'), re: /\.log$/i, source: 'Trainwreck' },
    { dir: resolveCI(paths.dataDir, 'NetScriptFramework', 'Crash'), re: /^crash_.*\.txt$/i, source: 'NetScriptFramework' },
  ];
  const out = [];
  for (const d of dirs) {
    for (const e of listDir(d.dir)) {
      if (!e.isFile() || !d.re.test(e.name)) continue;
      const file = path.join(d.dir, e.name);
      try { out.push({ file, name: e.name, source: d.source, at: fs.statSync(file).mtime.toISOString() }); } catch {}
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Best-effort summary of a crash log: the exception, and which mods (DLLs and plugins) show up most in
 * the call stack and the objects involved. Logs end with a full plugin/module list, which is skipped
 * so every installed mod isn't counted.
 */
function summarizeCrash(text, knownPlugins = []) {
  const exc = text.match(/Unhandled (?:native )?exception\s*"?([^"\n]+?)"?\s+at\s+(0x[0-9A-Fa-f`]+)\s*([^\n]*)/i);
  const tailStart = text.search(/^\s*(MODULES|SKSE PLUGINS|PLUGINS|GAME PLUGINS):?\s*$/im);
  const region = tailStart > 0 ? text.slice(0, tailStart) : text;
  const stackStart = region.search(/PROBABLE CALL STACK|CALL STACK|Possible relevant objects/i);
  const stack = stackStart >= 0 ? region.slice(stackStart) : region;

  const modules = new Map();
  // Module names don't contain spaces; allowing them would swallow the address printed before each name.
  for (const m of stack.matchAll(/([\w\-.()]+\.(?:dll|exe))\+(?:0x)?[0-9A-Fa-f]+/gi)) {
    const name = m[1].trim().split(/[\\/]/).pop();
    if (NOISE_MODULES.test(name)) continue;
    modules.set(name, (modules.get(name) || 0) + 1);
  }
  const base = new Set(BASE_MASTERS.map(s => s.toLowerCase()));
  const lower = region.toLowerCase();
  const pluginsHit = [];
  for (const p of knownPlugins) {
    const k = p.toLowerCase();
    if (base.has(k)) continue;
    let count = 0, i = 0;
    while ((i = lower.indexOf(k, i)) >= 0) {
      // "Addon.esp" must not count inside "MyAddon.esp".
      if (i === 0 || !/[a-z0-9_\-]/.test(lower[i - 1])) count++;
      i += k.length;
    }
    if (count) pluginsHit.push([p, count]);
  }
  const top = map => [...map].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));
  return {
    exception: exc ? `${exc[1].trim()} at ${exc[3].trim() || exc[2]}` : null,
    modules: top(modules),
    plugins: top(new Map(pluginsHit)),
  };
}

function crashReports(paths, knownPlugins = [], limit = 8) {
  return crashFiles(paths).slice(0, limit).map(c => ({ ...c, ...summarizeCrash(readHead(c.file), knownPlugins) }));
}

module.exports = { serverSession, clientLog, sksePluginResults, tail, logFiles, crashFiles, crashReports, summarizeCrash };
