'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { runningProcesses, run, readText, exists } = require('./util');
const game = require('./game');

const PROCS = {
  steam: 'steam.exe',
  game: 'skyrimse.exe',
  client: 'skyrimtogether.exe',
  server: 'skyrimtogetherserver.exe',
  vortex: 'vortex.exe',
};

async function status() {
  const procs = await runningProcesses();
  const out = {};
  for (const [k, exe] of Object.entries(PROCS)) out[k] = procs.has(exe);
  return out;
}

function startDetached(exe) {
  if (!exe || !exists(exe)) throw new Error(`Not found: ${exe}`);
  // detached gives console programs (the server) their own window.
  const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

function launchClient(paths) {
  startDetached(game.strInfo(paths).exe);
}

function launchServer(paths) {
  startDetached(game.strInfo(paths).server);
}

async function stopServer() {
  return run('taskkill', ['/im', 'SkyrimTogetherServer.exe']);
}

function openSteam() {
  spawn('cmd', ['/c', 'start', '', 'steam://open/main'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/**
 * Sets Steam's auto-update for Skyrim. 1 = only update when launched, which stops surprise updates
 * from breaking SKSE and Skyrim Together. Steam must be closed or it rewrites the file.
 */
async function setSteamAutoUpdate(paths, value) {
  const s = await status();
  if (s.steam) throw new Error('Close Steam completely first (Steam menu > Exit), then try again.');
  const file = game.steamManifestPath(paths);
  const text = readText(file);
  if (!text) throw new Error('Steam manifest for Skyrim not found.');
  const next = /"AutoUpdateBehavior"\s+"\d+"/.test(text)
    ? text.replace(/("AutoUpdateBehavior"\s+)"\d+"/, `$1"${value}"`)
    : text.replace(/("StateFlags"\s+"\d+")/, `$1\n\t"AutoUpdateBehavior"\t\t"${value}"`);
  fs.writeFileSync(file, next);
}

module.exports = { status, launchClient, launchServer, stopServer, openSteam, setSteamAutoUpdate };
