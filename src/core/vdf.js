'use strict';
/**
 * Steam's two config formats:
 *  - text VDF (localconfig.vdf: per-game launch options), key/value pairs in braces
 *  - binary VDF (shortcuts.vdf: non-Steam games in the library)
 * Both parse to ordered objects: { key: string | number | object }. Key order is kept, which
 * matters to Steam and keeps diffs small.
 */

// ---------- text ----------

function parseText(text) {
  let i = 0;
  const s = text.replace(/^﻿/, '');
  const skip = () => {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
      break;
    }
  };
  const str = () => {
    if (s[i] === '"') {
      i++;
      let out = '';
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[i + 1];
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          i += 2;
        } else out += s[i++];
      }
      i++;
      return out;
    }
    const start = i;
    while (i < s.length && !/[\s{}"]/.test(s[i])) i++;
    return s.slice(start, i);
  };
  const obj = () => {
    const o = {};
    for (;;) {
      skip();
      if (i >= s.length || s[i] === '}') { i++; return o; }
      const key = str();
      skip();
      if (s[i] === '{') { i++; o[key] = obj(); } else o[key] = str();
    }
  };
  return obj();
}

const esc = v => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function stringifyText(o, depth = 0) {
  const pad = '\t'.repeat(depth);
  let out = '';
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object') out += `${pad}"${esc(k)}"\n${pad}{\n${stringifyText(v, depth + 1)}${pad}}\n`;
    else out += `${pad}"${esc(k)}"\t\t"${esc(v)}"\n`;
  }
  return out;
}

/** Finds a child key ignoring case (Steam isn't consistent: "apps" vs "Apps"). */
function child(o, key, create = false) {
  if (!o || typeof o !== 'object') return undefined;
  const k = Object.keys(o).find(x => x.toLowerCase() === key.toLowerCase());
  if (k !== undefined) return o[k];
  if (create) { o[key] = {}; return o[key]; }
  return undefined;
}

// ---------- binary ----------

const T_MAP = 0x00, T_STR = 0x01, T_INT = 0x02, T_END = 0x08;

function parseBinary(buf) {
  let i = 0;
  const cstr = () => {
    const end = buf.indexOf(0, i);
    if (end < 0) throw new Error('Corrupt shortcuts.vdf');
    const s = buf.toString('utf8', i, end);
    i = end + 1;
    return s;
  };
  const map = () => {
    const o = {};
    while (i < buf.length) {
      const t = buf[i++];
      if (t === T_END) return o;
      const key = cstr();
      if (t === T_MAP) o[key] = map();
      else if (t === T_STR) o[key] = cstr();
      else if (t === T_INT) { o[key] = buf.readInt32LE(i); i += 4; }
      else throw new Error(`Unsupported field type ${t} in shortcuts.vdf`);
    }
    return o;
  };
  return buf.length ? map() : {};
}

function stringifyBinary(o) {
  const parts = [];
  const write = obj => {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') {
        parts.push(Buffer.from([T_MAP]), Buffer.from(k + '\0'));
        write(v);
        parts.push(Buffer.from([T_END]));
      } else if (typeof v === 'number') {
        const n = Buffer.alloc(4);
        n.writeInt32LE(v | 0, 0);
        parts.push(Buffer.from([T_INT]), Buffer.from(k + '\0'), n);
      } else {
        parts.push(Buffer.from([T_STR]), Buffer.from(k + '\0'), Buffer.from(String(v) + '\0'));
      }
    }
  };
  write(o);
  parts.push(Buffer.from([T_END]));
  return Buffer.concat(parts);
}

// CRC-32 (zlib polynomial), which Steam uses to derive a non-Steam shortcut's app id.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Steam's id for a non-Steam shortcut: crc32(exe + name) with the top bit set, stored as int32. */
function shortcutAppId(exe, name) {
  return ((crc32(Buffer.from(exe + name, 'utf8')) | 0x80000000) >>> 0) | 0;
}

module.exports = { parseText, stringifyText, child, parseBinary, stringifyBinary, crc32, shortcutAppId };
