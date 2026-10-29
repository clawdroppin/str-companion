'use strict';
/**
 * Steam Deck / Linux automation:
 *  - a launch wrapper (strc-launch.sh) put in front of %command% in Skyrim's Steam launch options, so
 *    pressing Play (also in Gaming Mode) starts Skyrim Together under Proton instead of the vanilla launcher;
 *  - adding STR Companion to the Steam library as a non-Steam game.
 * Steam rewrites its config files while running, so callers must close Steam before writing them.
 */
const fs = require('fs');
const path = require('path');
const vdf = require('./vdf');
const { exists, readText, listDir, timestampId } = require('./util');

const APP_ID = '489830';
const WRAPPER_NAME = 'strc-launch.sh';
const CONTROL_DIR = '.strcompanion';
const STEAM_EXE = 'SkyrimSELauncher.exe';
const STR_EXE = 'Data/SkyrimTogetherReborn/SkyrimTogether.exe';

function readFirst(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; }
}

/** Valve's handheld: DMI vendor "Valve" (Jupiter = LCD, Galileo = OLED). */
function isSteamDeck() {
  if (process.platform !== 'linux') return false;
  return readFirst('/sys/devices/virtual/dmi/id/board_vendor') === 'Valve'
    || /^(Jupiter|Galileo)$/.test(readFirst('/sys/devices/virtual/dmi/id/product_name'));
}

/** Gaming Mode runs inside gamescope; Steam can't be restarted from there. */
function inGamingMode(procs) {
  if (process.platform !== 'linux') return false;
  if (/gamescope/i.test(process.env.XDG_CURRENT_DESKTOP || '')) return true;
  return !!procs && (procs.has('gamescope-session') || procs.has('gamescope-session-plus'));
}

// ---------- launch wrapper ----------

function wrapperScript() {
  return `#!/bin/sh
# STR Companion launch wrapper for Skyrim Special Edition.
# Steam runs this when you press Play. It snapshots your saves (if switched on), then starts
# Skyrim Together instead of the normal launcher, unless "Play solo" is on in STR Companion.
# Remove it with STR Companion > Steam Deck > Undo.
here="$(cd "$(dirname "$0")" && pwd)"
ctl="$here/${CONTROL_DIR}"
target="${STEAM_EXE}"
str="${STR_EXE}"
if [ -f "$ctl/auto-snapshot" ]; then
  user="$here/../../compatdata/${APP_ID}/pfx/drive_c/users/steamuser"
  docs="$user/Documents"
  [ -d "$docs" ] || docs="$user/My Documents"
  saves="$docs/My Games/Skyrim Special Edition/Saves"
  if [ -d "$saves" ] && [ -n "$(ls -A "$saves" 2>/dev/null)" ]; then
    id="$(date -u +%Y-%m-%d_%H-%M-%S)_play"
    dest="$here/_STRCompanion_Backup/saves/$id"
    if mkdir -p "$dest" && cp -a "$saves/." "$dest/"; then
      files=$(find "$dest" -type f | wc -l | tr -d ' ')
      size=$(du -sb "$dest" 2>/dev/null | cut -f1)
      printf '{"note":"Automatic, before Play","auto":true,"createdAt":"%s","files":%s,"size":%s}\\n' \\
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\${files:-0}" "\${size:-0}" > "$dest/snapshot.json"
    fi
  fi
fi
if [ -f "$ctl/mods-off" ] || [ ! -f "$here/$str" ]; then
  exec "$@"
fi
for arg; do
  shift
  case "$arg" in
    *"/$target"|*"\\\\$target") arg="\${arg%"$target"}$str" ;;
  esac
  set -- "$@" "$arg"
done
exec "$@"
`;
}

/** Writes the wrapper next to SkyrimSE.exe plus its control flags. */
function writeWrapper(gameDir, { autoSnapshot = true, solo = false } = {}) {
  const file = path.join(gameDir, WRAPPER_NAME);
  fs.writeFileSync(file, wrapperScript());
  try { fs.chmodSync(file, 0o755); } catch {}
  setFlags(gameDir, { autoSnapshot, solo });
  return file;
}

function setFlags(gameDir, { autoSnapshot, solo }) {
  const dir = path.join(gameDir, CONTROL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const flag = (name, on) => {
    const f = path.join(dir, name);
    if (on) fs.writeFileSync(f, '1');
    else fs.rmSync(f, { force: true });
  };
  if (autoSnapshot !== undefined) flag('auto-snapshot', autoSnapshot);
  if (solo !== undefined) flag('mods-off', solo);
}

function flags(gameDir) {
  const dir = path.join(gameDir, CONTROL_DIR);
  return { autoSnapshot: exists(path.join(dir, 'auto-snapshot')), solo: exists(path.join(dir, 'mods-off')) };
}

function removeWrapper(gameDir) {
  fs.rmSync(path.join(gameDir, WRAPPER_NAME), { force: true });
  fs.rmSync(path.join(gameDir, CONTROL_DIR), { recursive: true, force: true });
}

/** Puts the wrapper in front of %command%, keeping the user's own launch options. */
function withWrapper(existing, wrapperPath) {
  const token = `"${wrapperPath}"`;
  const base = withoutWrapper(existing);
  if (base.includes('%command%')) return base.replace('%command%', `${token} %command%`);
  if (!base.trim()) return `${token} %command%`;
  return `${token} %command% ${base.trim()}`;
}

function withoutWrapper(existing) {
  const s = String(existing || '');
  const pos = s.indexOf(WRAPPER_NAME);
  if (pos < 0) return s;
  const start = s.lastIndexOf('"', pos) >= 0 ? s.lastIndexOf('"', pos) : pos;
  let end = pos + WRAPPER_NAME.length;
  if (s[end] === '"') end++;
  let out = (s.slice(0, start) + s.slice(end).trimStart()).trim();
  if (out === '%command%') out = '';
  return out;
}

// ---------- Steam user configs ----------

/** userdata/<id>/config folders that belong to real accounts (0 and anonymous are skipped). */
function userConfigDirs(steamRoot) {
  return listDir(path.join(steamRoot, 'userdata'))
    .filter(e => e.isDirectory() && /^\d+$/.test(e.name) && e.name !== '0')
    .map(e => path.join(steamRoot, 'userdata', e.name, 'config'))
    .filter(d => exists(d));
}

function appNode(cfg, create) {
  let n = cfg;
  for (const k of ['UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps', APP_ID]) {
    n = vdf.child(n, k, create);
    if (!n) return null;
  }
  return n;
}

function launchOptions(steamRoot) {
  const out = [];
  for (const dir of userConfigDirs(steamRoot)) {
    const text = readText(path.join(dir, 'localconfig.vdf'));
    if (!text) continue;
    const node = appNode(vdf.parseText(text), false);
    out.push({ user: path.basename(path.dirname(dir)), options: node && typeof node.LaunchOptions === 'string' ? node.LaunchOptions : '' });
  }
  return out;
}

/**
 * Rewrites Skyrim's launch options for every Steam account on this PC, backing each
 * localconfig.vdf up first. Steam must be closed.
 */
function updateLaunchOptions(steamRoot, transform, backupDir) {
  let changed = 0;
  for (const dir of userConfigDirs(steamRoot)) {
    const file = path.join(dir, 'localconfig.vdf');
    const text = readText(file);
    if (!text) continue;
    const cfg = vdf.parseText(text);
    const node = appNode(cfg, true);
    const before = typeof node.LaunchOptions === 'string' ? node.LaunchOptions : '';
    const after = transform(before);
    if (after === before) continue;
    if (backupDir) {
      const dest = path.join(backupDir, `${path.basename(path.dirname(dir))}-localconfig-${timestampId()}.vdf`);
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(file, dest);
    }
    if (after) node.LaunchOptions = after; else delete node.LaunchOptions;
    fs.writeFileSync(file, vdf.stringifyText(cfg));
    changed++;
  }
  return changed;
}

// ---------- non-Steam shortcut ----------

function shortcutsFile(configDir) {
  return path.join(configDir, 'shortcuts.vdf');
}

function hasShortcut(steamRoot, exe) {
  return userConfigDirs(steamRoot).some(dir => {
    try {
      const s = vdf.parseBinary(fs.readFileSync(shortcutsFile(dir)));
      return Object.values(s.shortcuts || {}).some(x => String(x.Exe || x.exe || '').replace(/"/g, '') === exe);
    } catch { return false; }
  });
}

/** Adds a non-Steam game entry for every Steam account (skips ones that already have it). */
function addShortcut(steamRoot, { name, exe, startDir, icon = '', launchOptions = '' }, backupDir) {
  let added = 0;
  for (const dir of userConfigDirs(steamRoot)) {
    const file = shortcutsFile(dir);
    let data = { shortcuts: {} };
    if (exists(file)) {
      data = vdf.parseBinary(fs.readFileSync(file));
      if (!data.shortcuts) data.shortcuts = {};
      if (backupDir) {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(file, path.join(backupDir, `${path.basename(path.dirname(dir))}-shortcuts-${timestampId()}.vdf`));
      }
    }
    const list = data.shortcuts;
    if (Object.values(list).some(x => String(x.Exe || x.exe || '').replace(/"/g, '') === exe)) continue;
    const quotedExe = `"${exe}"`;
    const next = String(Object.keys(list).reduce((m, k) => Math.max(m, Number(k) + 1 || 0), 0));
    list[next] = {
      appid: vdf.shortcutAppId(quotedExe, name),
      AppName: name,
      Exe: quotedExe,
      StartDir: `"${startDir}"`,
      icon,
      ShortcutPath: '',
      LaunchOptions: launchOptions,
      IsHidden: 0,
      AllowDesktopConfig: 1,
      AllowOverlay: 1,
      OpenVR: 0,
      Devkit: 0,
      DevkitGameID: '',
      DevkitOverrideAppID: 0,
      LastPlayTime: 0,
      FlatpakAppID: '',
      tags: {},
    };
    fs.writeFileSync(file, vdf.stringifyBinary(data));
    added++;
  }
  return added;
}

module.exports = {
  APP_ID, WRAPPER_NAME, CONTROL_DIR, STEAM_EXE, STR_EXE,
  isSteamDeck, inGamingMode, wrapperScript, writeWrapper, removeWrapper, setFlags, flags,
  withWrapper, withoutWrapper, userConfigDirs, launchOptions, updateLaunchOptions, hasShortcut, addShortcut,
};
