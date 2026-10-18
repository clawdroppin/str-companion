'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const API = 'https://api.nexusmods.com/v1';
const GAME = 'skyrimspecialedition';
const APP_VERSION = '1.0.0';

function request(url, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        apikey: apiKey,
        accept: 'application/json',
        'Application-Name': 'STR Companion',
        'Application-Version': APP_VERSION,
      },
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          let msg = body;
          try { msg = JSON.parse(body).message || body; } catch {}
          const err = new Error(`Nexus ${res.statusCode}: ${msg}`);
          err.status = res.statusCode;
          return reject(err);
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Nexus request timed out')));
  });
}

class Nexus {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  get configured() {
    return !!this.apiKey;
  }

  validate() {
    return request(`${API}/users/validate.json`, this.apiKey);
  }

  mod(id) {
    return request(`${API}/games/${GAME}/mods/${id}.json`, this.apiKey);
  }

  files(id) {
    return request(`${API}/games/${GAME}/mods/${id}/files.json`, this.apiKey);
  }

  /** Direct download links. Nexus only allows this for Premium accounts. */
  downloadLinks(modId, fileId) {
    return request(`${API}/games/${GAME}/mods/${modId}/files/${fileId}/download_link.json`, this.apiKey);
  }
}

/** The newest main file of a mod (what "update" should mean for most mods). */
function latestMainFile(files) {
  const list = (files.files || []).filter(f => f.category_name === 'MAIN');
  const pool = list.length ? list : (files.files || []).filter(f => f.category_name !== 'OLD_VERSION' && f.category_name !== 'ARCHIVED');
  return pool.sort((a, b) => b.uploaded_timestamp - a.uploaded_timestamp)[0] || null;
}

function modUrl(id, tab) {
  return `https://www.nexusmods.com/${GAME}/mods/${id}${tab ? `?tab=${tab}` : ''}`;
}

/** Accepts "https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files" or "12604". */
function parseModRef(input) {
  const s = String(input).trim();
  const m = s.match(/nexusmods\.com\/skyrimspecialedition\/mods\/(\d+)/i) || s.match(/^(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** Downloads a URL to a file, following redirects, reporting progress 0..1. */
function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const get = (u, hops) => {
      https.get(u, { headers: { 'User-Agent': `STRCompanion/${APP_VERSION}` } }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) {
          res.resume();
          return get(new URL(res.headers.location, u).toString(), hops + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Download failed (${res.statusCode})`)); }
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const out = fs.createWriteStream(dest);
        // A half-written archive would fail to extract later with a confusing error, so remove it.
        const fail = err => { out.destroy(); fs.rm(dest, { force: true }, () => reject(err)); };
        res.on('data', c => { got += c.length; if (total && onProgress) onProgress(got / total); });
        res.on('aborted', () => fail(new Error('Download was interrupted')));
        res.pipe(out);
        out.on('finish', () => out.close(() => (total && got < total ? fail(new Error('Download was incomplete')) : resolve(dest))));
        out.on('error', fail);
      }).on('error', reject).setTimeout(60000, function () { this.destroy(new Error('Download timed out')); });
    };
    get(url, 0);
  });
}

module.exports = { Nexus, latestMainFile, modUrl, parseModRef, download };
