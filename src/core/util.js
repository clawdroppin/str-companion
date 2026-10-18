'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readText(p, fallback = null) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}

function readJson(p, fallback = null) {
  const t = readText(p);
  if (t == null) return fallback;
  try { return JSON.parse(t.replace(/^﻿/, '')); } catch { return fallback; }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

function listDir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

/** Find a directory entry ignoring case (Windows paths are case-insensitive, but readdir names are not). */
function findCaseInsensitive(dir, name) {
  const lower = name.toLowerCase();
  const hit = listDir(dir).find(e => e.name.toLowerCase() === lower);
  return hit ? path.join(dir, hit.name) : null;
}

/**
 * Joins path segments, matching each one case-insensitively against what's on disk. Linux file systems
 * are case-sensitive, but Skyrim and its tools don't agree on casing ("Plugins.txt" vs "plugins.txt").
 * Segments that don't exist yet keep the casing given.
 */
function resolveCIStrict(base, ...segments) {
  let cur = base;
  for (const seg of segments) cur = findCaseInsensitive(cur, seg) || path.join(cur, seg);
  return cur;
}

// Windows file systems already ignore case, so skip the directory scans there.
const resolveCI = process.platform === 'win32' ? (base, ...segments) => path.join(base, ...segments) : resolveCIStrict;

/** True when `p` is `base` or inside it (guards against "../" in relative paths). */
function isInside(base, p) {
  const rel = path.relative(path.resolve(base), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The last `maxBytes` of a text file. Logs grow without limit, and only their recent end matters. */
function readTail(p, maxBytes = 1 << 20) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    // Drop the partial first line when we started mid-file.
    if (len < size) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Full path of a command on PATH, or null. */
function which(cmd) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}

/**
 * Reads the FileVersion from a Windows PE file's VS_FIXEDFILEINFO block.
 * Returns e.g. "1.7.104.0", or null when the file has no version resource.
 */
const peCache = new Map();
function peFileVersion(file) {
  // SkyrimSE.exe is ~37 MB; only re-read it when it actually changed.
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  if (peCache.has(key)) return peCache.get(key);
  const v = readPeVersion(file);
  peCache.set(key, v);
  return v;
}

function readPeVersion(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  const sig = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);
  let i = buf.lastIndexOf(sig);
  while (i >= 0) {
    // dwStrucVersion follows the signature; a real block has 0x00010000
    if (buf.readUInt32LE(i + 4) === 0x00010000) {
      const ms = buf.readUInt32LE(i + 8);
      const ls = buf.readUInt32LE(i + 12);
      return `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
    }
    i = buf.lastIndexOf(sig, i - 1);
  }
  return null;
}

/** "1.7.104.0" -> "1.7.104" */
function shortVersion(v) {
  return v ? v.replace(/\.0$/, '') : v;
}

/**
 * Compares version strings part by part. Each part is a number with an optional letter suffix,
 * so "4.3.9c" > "4.3.9b" > "4.3.9" (USSEP uses letters for hotfixes).
 */
function compareVersions(a, b) {
  const parts = v => String(v).trim().replace(/^v/i, '').split(/[.\-_]/).map(x => {
    const m = x.match(/^(\d*)(.*)$/);
    return { n: parseInt(m[1], 10) || 0, s: m[2].toLowerCase() };
  });
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || { n: 0, s: '' }, y = pb[i] || { n: 0, s: '' };
    if (x.n !== y.n) return x.n < y.n ? -1 : 1;
    if (x.s !== y.s) return x.s < y.s ? -1 : 1;
  }
  return 0;
}

function run(cmd, args, opts = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** Names of running processes (lowercase image names, e.g. "skyrimse.exe", "steam"). */
async function runningProcesses() {
  if (process.platform === 'win32') {
    const r = await run('tasklist', ['/fo', 'csv', '/nh']);
    const names = new Set();
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)"/);
      if (m) names.add(m[1].toLowerCase());
    }
    return names;
  }
  const r = await run('ps', ['-eo', 'args=']);
  return parsePsOutput(r.stdout);
}

/**
 * Turns `ps -eo args=` output into process names. Proton/Wine programs show up as arguments like
 * "Z:\\...\\SkyrimSE.exe" or "/home/me/.../SkyrimSE.exe", so every path-looking token counts.
 */
function parsePsOutput(text) {
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    // Splitting on spaces also breaks paths like ".../Skyrim Special Edition/SkyrimSE.exe", but the last
    // piece still ends in the file name, which is all we need.
    for (const tok of line.trim().split(/\s+/)) {
      if (!tok) continue;
      const base = tok.split(/[\\/]/).pop().toLowerCase();
      if (base) names.add(base);
    }
  }
  return names;
}

/** Moves a file, falling back to copy+delete across drives. */
function moveFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

function walkFiles(root, rel = '') {
  const out = [];
  for (const e of listDir(path.join(root, rel))) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...walkFiles(root, r));
    else out.push(r);
  }
  return out;
}

function removeEmptyDirs(dir, stopAt) {
  let d = dir;
  while (d && d !== stopAt && d.startsWith(stopAt)) {
    try {
      if (fs.readdirSync(d).length) return;
      fs.rmdirSync(d);
    } catch { return; }
    d = path.dirname(d);
  }
}

function dirSize(dir) {
  let total = 0;
  for (const rel of walkFiles(dir)) {
    try { total += fs.statSync(path.join(dir, rel)).size; } catch {}
  }
  return total;
}

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

module.exports = {
  exists, readText, readJson, writeJson, listDir, findCaseInsensitive, resolveCI, resolveCIStrict, isInside, readTail,
  which, peFileVersion, shortVersion, compareVersions, run, runningProcesses, parsePsOutput, moveFile, walkFiles,
  removeEmptyDirs, timestampId, dirSize,
};
