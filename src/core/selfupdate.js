'use strict';
/** Helpers for updating the app itself from a GitHub release, SHA-256 verified. */
const fs = require('fs');
const crypto = require('crypto');

/** Which release asset replaces this copy of the app, or null when it can't update itself. */
function assetFor(platform, version, { portableExe, appImage } = {}) {
  if (platform === 'win32' && portableExe) return `STR-Companion-${version}.exe`;
  if (platform === 'linux' && appImage) return `STR-Companion-${version}-linux-x86_64.AppImage`;
  return null;
}

/** "abc123…  file.exe" lines (sha256sum format) -> { 'file.exe': 'abc123…' } */
function parseSums(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m) out[m[2].trim()] = m[1].toLowerCase();
  }
  return out;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/**
 * Windows can't replace a running exe, so a tiny batch file waits for the app to exit, swaps the file
 * in, starts the new version and deletes itself.
 */
function windowsSwapScript(newFile, target) {
  const q = s => `"${s}"`;
  return [
    '@echo off',
    'set tries=0',
    ':retry',
    `move /y ${q(newFile)} ${q(target)} >nul 2>&1 && goto done`,
    'set /a tries+=1',
    'if %tries% geq 60 goto fail',
    'timeout /t 1 /nobreak >nul',
    'goto retry',
    ':done',
    `start "" ${q(target)}`,
    ':fail',
    '(goto) 2>nul & del "%~f0"',
    '',
  ].join('\r\n');
}

module.exports = { assetFor, parseSums, sha256File, windowsSwapScript };
