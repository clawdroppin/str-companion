'use strict';
/**
 * Comment- and layout-preserving INI parser. Handles Skyrim's INIs, STServer.ini and the simple
 * key = value TOML that Engine Fixes uses (inline "# comment" after the value).
 */

function detectEol(text) {
  // New/empty files get Windows line endings, which is what Skyrim writes.
  if (!text.includes('\n')) return '\r\n';
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

function splitInlineComment(rest, allowInline) {
  if (!allowInline) return { value: rest.trim(), comment: '' };
  let inQuote = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '"') inQuote = !inQuote;
    if (c === '#' && !inQuote) return { value: rest.slice(0, i).trim(), comment: rest.slice(i + 1).trim() };
  }
  return { value: rest.trim(), comment: '' };
}

class IniDoc {
  constructor(text = '', { toml = false } = {}) {
    this.toml = toml;
    this.eol = detectEol(text);
    this.bom = text.startsWith('﻿');
    this.lines = [];
    let section = '';
    let pendingComments = [];
    for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
      const t = raw.trim();
      if (!t) { this.lines.push({ type: 'blank', raw }); pendingComments = []; continue; }
      if (t.startsWith(';') || t.startsWith('#')) {
        this.lines.push({ type: 'comment', raw });
        pendingComments.push(t.replace(/^[;#]+\s?/, ''));
        continue;
      }
      const sm = t.match(/^\[([^\]]*)\]/);
      if (sm) {
        section = sm[1];
        this.lines.push({ type: 'section', raw, section });
        pendingComments = [];
        continue;
      }
      const eq = raw.indexOf('=');
      if (eq > 0) {
        const key = raw.slice(0, eq).trim();
        const { value, comment } = splitInlineComment(raw.slice(eq + 1), toml);
        this.lines.push({
          type: 'kv', raw, section, key, value, inline: comment,
          doc: pendingComments.join(' ').trim() || comment,
        });
        pendingComments = [];
        continue;
      }
      this.lines.push({ type: 'other', raw });
      pendingComments = [];
    }
    // Drop the phantom trailing blank line produced by a final newline.
    if (this.lines.length && this.lines[this.lines.length - 1].type === 'blank' && this.lines[this.lines.length - 1].raw === '') {
      this.lines.pop();
      this.trailingEol = true;
    }
  }

  _find(section, key) {
    const s = section.toLowerCase(), k = key.toLowerCase();
    return this.lines.find(l => l.type === 'kv' && l.section.toLowerCase() === s && l.key.toLowerCase() === k);
  }

  get(section, key) {
    const l = this._find(section, key);
    return l ? l.value : undefined;
  }

  /** All key/value entries, in file order. */
  entries() {
    return this.lines.filter(l => l.type === 'kv').map(l => ({ section: l.section, key: l.key, value: l.value, doc: l.doc }));
  }

  sections() {
    const seen = [];
    for (const l of this.lines) if (l.type === 'section' && !seen.some(s => s.toLowerCase() === l.section.toLowerCase())) seen.push(l.section);
    return seen;
  }

  set(section, key, value) {
    value = String(value);
    const l = this._find(section, key);
    if (l) {
      if (l.value === value) return false;
      l.value = value;
      l.raw = this._format(l.key, value, l.inline);
      return true;
    }
    const line = { type: 'kv', section, key, value, inline: '', doc: '', raw: this._format(key, value, '') };
    // Insert after the last entry of the section, or append a new section.
    let idx = -1;
    let inSection = false;
    for (let i = 0; i < this.lines.length; i++) {
      const x = this.lines[i];
      if (x.type === 'section') inSection = x.section.toLowerCase() === section.toLowerCase();
      if (inSection && (x.type === 'kv' || x.type === 'section')) idx = i;
    }
    if (idx >= 0) {
      this.lines.splice(idx + 1, 0, line);
    } else {
      if (this.lines.length && this.lines[this.lines.length - 1].type !== 'blank') this.lines.push({ type: 'blank', raw: '' });
      this.lines.push({ type: 'section', raw: `[${section}]`, section });
      this.lines.push(line);
    }
    return true;
  }

  _format(key, value, inline) {
    const base = this.toml ? `${key} = ${value}` : `${key}=${value}`;
    return inline ? `${base.padEnd(48)}# ${inline}` : base;
  }

  toString() {
    const body = this.lines.map(l => l.raw).join(this.eol) + (this.trailingEol ? this.eol : '');
    return (this.bom ? '﻿' : '') + body;
  }
}

/** Guess a value's type for the editor UI. */
function inferType(key, value) {
  const v = String(value).trim();
  if (/^(true|false)$/i.test(v)) return 'bool';
  if (/^b[A-Z]/.test(key) && /^[01]$/.test(v)) return 'bool01';
  if (/^-?\d+$/.test(v)) return 'int';
  if (/^-?\d*\.\d+$/.test(v)) return 'float';
  return 'string';
}

module.exports = { IniDoc, inferType };
