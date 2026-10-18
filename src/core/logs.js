'use strict';
const path = require('path');
const fs = require('fs');
const { readText, exists } = require('./util');

function mtime(p) {
  try { return fs.statSync(p).mtime.toISOString(); } catch { return null; }
}

/** Players currently on the server, read from the latest server session in STServerOut.log. */
function serverSession(paths) {
  const file = path.join(paths.strDir, 'logs', 'STServerOut.log');
  const text = readText(file, '');
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
  const file = path.join(paths.strDir, 'logs', 'tp_client.log');
  const text = readText(file, '');
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
    connected: /Received local actor|connected/i.test(text),
    problems,
  };
}

/** Which SKSE plugins loaded during the last launch, from skse64.log. */
function sksePluginResults(paths) {
  const file = path.join(paths.skseLogs, 'skse64.log');
  const text = readText(file, '');
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
  const text = readText(file, '');
  return text.split(/\r?\n/).slice(-n).join('\n');
}

function logFiles(paths) {
  return [
    { id: 'server', title: 'Server', file: path.join(paths.strDir, 'logs', 'STServerOut.log') },
    { id: 'client', title: 'Skyrim Together client', file: path.join(paths.strDir, 'logs', 'tp_client.log') },
    { id: 'skse', title: 'SKSE', file: path.join(paths.skseLogs, 'skse64.log') },
    { id: 'skseloader', title: 'SKSE loader', file: path.join(paths.skseLogs, 'skse64_loader.log') },
    { id: 'enginefixes', title: 'Engine Fixes', file: path.join(paths.skseLogs, 'EngineFixes.log') },
  ].map(l => ({ ...l, exists: exists(l.file), updatedAt: mtime(l.file) }));
}

module.exports = { serverSession, clientLog, sksePluginResults, tail, logFiles };
