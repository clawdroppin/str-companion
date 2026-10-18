'use strict';
// Renders build/icon.png (512x512) from the app's shield logo. Run with: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="bg" cx="50%" cy="30%" r="75%"><stop offset="0" stop-color="#3a2d17"/><stop offset="1" stop-color="#14120f"/></radialGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6d791"/><stop offset="1" stop-color="#c19a48"/></linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <rect x="10" y="10" width="492" height="492" rx="104" fill="none" stroke="#d2ac5c" stroke-opacity=".35" stroke-width="6"/>
  <path d="M256 70 106 136v104c0 92 63 160 150 186 87-26 150-94 150-186V136L256 70Z" fill="none" stroke="url(#gold)" stroke-width="30" stroke-linejoin="round"/>
  <path d="M176 244h160M256 166v170" stroke="url(#gold)" stroke-width="30" stroke-linecap="round"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise(r => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.resize({ width: 512, height: 512 }).toPNG());
  console.log('wrote', out);
  app.quit();
});
