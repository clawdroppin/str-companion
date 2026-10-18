'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { runningProcesses, run, readText, exists, which, findCaseInsensitive } = require('./util');
const game = require('./game');

const IS_WIN = process.platform === 'win32';

// Process names as they appear on each platform (on Linux, Proton programs keep their .exe names).
const PROCS = {
  steam: IS_WIN ? ['steam.exe'] : ['steam', 'steamwebhelper'],
  game: ['skyrimse.exe'],
  client: ['skyrimtogether.exe'],
  server: ['skyrimtogetherserver.exe', 'skyrimtogetherserver'],
  vortex: ['vortex.exe'],
};

async function status() {
  const procs = await runningProcesses();
  const out = {};
  for (const [k, names] of Object.entries(PROCS)) out[k] = names.some(n => procs.has(n));
  return out;
}

function spawnDetached(cmd, args, cwd) {
  // detached gives console programs (the server) their own window on Windows.
  const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

/**
 * How to run a Windows .exe inside Skyrim's Proton prefix on Linux. protontricks-launch picks the
 * right Proton version and prefix for the app id; the Flatpak build is common on Steam Deck.
 */
function protonLauncher() {
  const native = which('protontricks-launch');
  if (native) return { cmd: native, args: ['--appid', game.APP_ID] };
  if (which('flatpak')) {
    const r = require('child_process').spawnSync('flatpak', ['info', 'com.github.Matoking.protontricks'], { stdio: 'ignore' });
    if (r.status === 0) return { cmd: 'flatpak', args: ['run', '--command=protontricks-launch', 'com.github.Matoking.protontricks', '--appid', game.APP_ID] };
  }
  return null;
}

const PROTON_HELP = 'Running Skyrim Together on Linux needs protontricks (it starts Windows programs inside Skyrim\'s Proton prefix). '
  + 'Install it from your distro or Flathub (com.github.Matoking.protontricks), then try again. '
  + 'Alternatively add SkyrimTogether.exe to Steam as a non-Steam game and force Proton for it.';

function launchExe(exe) {
  if (!exe || !exists(exe)) throw new Error(`Not found: ${exe}`);
  if (IS_WIN) return spawnDetached(exe, [], path.dirname(exe));
  const proton = protonLauncher();
  if (!proton) throw new Error(PROTON_HELP);
  spawnDetached(proton.cmd, [...proton.args, exe], path.dirname(exe));
}

function launchClient(paths) {
  launchExe(game.strInfo(paths).exe);
}

/**
 * On Linux the server can run natively if a Linux build sits next to the .exe, or with Wine
 * (it's a plain console program, so it doesn't need the game's prefix); otherwise through Proton.
 */
function launchServer(paths) {
  const info = game.strInfo(paths);
  if (IS_WIN) return launchExe(info.server);
  const native = findCaseInsensitive(paths.strDir, 'SkyrimTogetherServer');
  if (native) {
    try { fs.chmodSync(native, 0o755); } catch {}
    return spawnDetached(native, [], path.dirname(native));
  }
  if (!info.server) throw new Error('SkyrimTogetherServer.exe not found.');
  const wine = which('wine');
  if (wine) return spawnDetached(wine, [info.server], path.dirname(info.server));
  launchExe(info.server);
}

async function stopServer() {
  if (IS_WIN) return run('taskkill', ['/im', 'SkyrimTogetherServer.exe']);
  return run('pkill', ['-f', '-i', 'SkyrimTogetherServer']);
}

function openSteam() {
  if (IS_WIN) spawn('cmd', ['/c', 'start', '', 'steam://open/main'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawnDetached(which('xdg-open') || 'xdg-open', ['steam://open/main']);
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

module.exports = { status, launchClient, launchServer, stopServer, openSteam, setSteamAutoUpdate, protonLauncher, PROCS };
