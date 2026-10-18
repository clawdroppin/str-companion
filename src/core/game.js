'use strict';
const path = require('path');
const os = require('os');
const { exists, readText, readJson, listDir, findCaseInsensitive, peFileVersion, shortVersion, run } = require('./util');

const APP_ID = '489830';

/** Folders the game uses outside its install directory. */
function gamePaths(gameDir, env = {}) {
  const documents = env.documentsDir || path.join(os.homedir(), 'Documents');
  const localAppData = env.localAppData || process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const myGames = path.join(documents, 'My Games', 'Skyrim Special Edition');
  return {
    gameDir,
    dataDir: path.join(gameDir, 'Data'),
    strDir: path.join(gameDir, 'Data', 'SkyrimTogetherReborn'),
    myGames,
    skseLogs: path.join(myGames, 'SKSE'),
    saves: path.join(myGames, 'Saves'),
    localAppDir: path.join(localAppData, 'Skyrim Special Edition'),
    steamappsDir: path.resolve(gameDir, '..', '..'),
  };
}

function isGameDir(dir) {
  return !!dir && exists(path.join(dir, 'SkyrimSE.exe')) && exists(path.join(dir, 'Data'));
}

/** Parses Steam's libraryfolders.vdf for library paths. */
function steamLibraries(steamPath) {
  const vdf = readText(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'), '');
  const libs = [steamPath];
  for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.push(m[1].replace(/\\\\/g, '\\'));
  return [...new Set(libs.map(p => path.normalize(p)))];
}

async function steamPath() {
  const r = await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
  const m = r.stdout.match(/SteamPath\s+REG_SZ\s+(.+)/);
  if (m) return path.normalize(m[1].trim());
  for (const p of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) if (exists(p)) return p;
  return null;
}

/** Looks through every Steam library for Skyrim Special Edition. */
async function detectGameDirs() {
  const sp = await steamPath();
  if (!sp) return [];
  return steamLibraries(sp)
    .map(lib => path.join(lib, 'steamapps', 'common', 'Skyrim Special Edition'))
    .filter(isGameDir);
}

function steamManifestPath(paths) {
  return path.join(paths.steamappsDir, `appmanifest_${APP_ID}.acf`);
}

const AUTO_UPDATE = { 0: 'Always keep updated', 1: 'Only update when launched', 2: 'High priority' };

function steamAutoUpdate(paths) {
  const text = readText(steamManifestPath(paths));
  if (!text) return null;
  const m = text.match(/"AutoUpdateBehavior"\s+"(\d+)"/);
  const v = m ? Number(m[1]) : 0;
  return { value: v, label: AUTO_UPDATE[v] || `Unknown (${v})` };
}

function skseInfo(paths) {
  const dlls = listDir(paths.gameDir).filter(e => /^skse64_\d+_\d+_\d+\.dll$/i.test(e.name)).map(e => e.name);
  const loader = exists(path.join(paths.gameDir, 'skse64_loader.exe'));
  const builtFor = dlls.map(d => d.match(/skse64_(\d+)_(\d+)_(\d+)/i).slice(1).join('.'));
  return {
    installed: loader && dlls.length > 0,
    loader,
    builtFor,
    version: loader ? skseVersionString(peFileVersion(path.join(paths.gameDir, 'skse64_loader.exe'))) : null,
  };
}

/** SKSE stamps its loader as 0.major.minor.build, e.g. "0.2.3.1" -> "2.3.1". */
function skseVersionString(v) {
  if (!v) return null;
  const parts = v.split('.');
  return (parts[0] === '0' ? parts.slice(1) : parts).join('.');
}

function addressLibraryInfo(paths, gameVersion) {
  const dir = path.join(paths.dataDir, 'SKSE', 'Plugins');
  const files = listDir(dir).filter(e => /^version(lib)?-[\d-]+\.bin$/i.test(e.name)).map(e => e.name);
  const want = gameVersion ? gameVersion.split('.').concat(['0', '0', '0', '0']).slice(0, 4).join('-') : null;
  const match = want ? files.find(f => f.toLowerCase().startsWith(`versionlib-${want}`)) : null;
  return { installed: files.length > 0, matchesGame: !!match, file: match || null, count: files.length };
}

/** Skyrim Together Reborn: install state and version (exe has no version resource, so read it from logs/manager). */
function strInfo(paths, vortexMods = []) {
  const exe = findCaseInsensitive(paths.strDir, 'SkyrimTogether.exe');
  const installed = !!exe;
  let version = null;
  const vortex = vortexMods.find(m => m.nexusId === 69993);
  if (vortex) version = vortex.version;
  if (!version) {
    const log = readText(path.join(paths.strDir, 'logs', 'STServerOut.log'), '');
    const m = [...log.matchAll(/Server v([\d.]+)/g)].pop();
    if (m) version = m[1];
  }
  return {
    installed,
    version,
    exe,
    server: findCaseInsensitive(paths.strDir, 'SkyrimTogetherServer.exe'),
    plugins: ['SkyrimTogether.esp', 'SkyrimTogetherQuestPatches.esp'].filter(p => exists(path.join(paths.dataDir, p))),
    configFile: path.join(paths.strDir, 'config', 'STServer.ini'),
  };
}

/** SKSE plugin DLLs installed in Data/SKSE/Plugins. */
function sksePlugins(paths) {
  return listDir(path.join(paths.dataDir, 'SKSE', 'Plugins'))
    .filter(e => e.isFile() && /\.dll$/i.test(e.name))
    .map(e => e.name);
}

/** DLLs sitting next to SkyrimSE.exe that hook into the game (ENB, ReShade, preloaders...). */
function rootHooks(paths) {
  const known = {
    'dxgi.dll': 'ReShade or another graphics injector',
    'd3d11.dll': 'ENB or another graphics injector',
    'd3dcompiler_46e.dll': 'ENB helper',
    'enbseries.ini': 'ENB',
    'd3dx9_42.dll': 'Engine Fixes preloader (old versions)',
    'tbb.dll': 'Engine Fixes memory library (old versions)',
    'tbbmalloc.dll': 'Engine Fixes memory library (old versions)',
    'dinput8.dll': 'Plugin preloader',
    'winhttp.dll': 'Plugin preloader',
    'version.dll': 'Plugin preloader',
  };
  return listDir(paths.gameDir)
    .filter(e => e.isFile() && known[e.name.toLowerCase()])
    .map(e => ({ file: e.name, what: known[e.name.toLowerCase()] }));
}

/**
 * Mods Vortex deployed, parsed from its deployment manifest. Vortex folder names encode the Nexus id
 * and version, e.g. "Skyrim Together Reborn 69993 1.8.3 2026-10-03T20-22Z Ks18n0UzJ" or "Name-272-4-2-6a-1772996477".
 */
function vortexMods(paths) {
  // Data mods are in Data/vortex.deployment.json; mods deployed to the game root (SKSE) are in
  // <game>/vortex.deployment.<type>.json.
  const manifests = [path.join(paths.dataDir, 'vortex.deployment.json')]
    .concat(listDir(paths.gameDir).filter(e => e.isFile() && /^vortex\.deployment.*\.json$/i.test(e.name)).map(e => path.join(paths.gameDir, e.name)));
  const bySource = new Map();
  for (const file of manifests) {
    const manifest = readJson(file);
    for (const f of (manifest && manifest.files) || []) {
      if (!bySource.has(f.source)) bySource.set(f.source, []);
      bySource.get(f.source).push(f.relPath);
    }
  }
  if (!bySource.size) return [];
  const mods = [];
  for (const [source, files] of bySource) mods.push({ folder: source, files, ...parseModFolderName(source) });
  return mods;
}

function parseModFolderName(name) {
  let m = name.match(/^(.+?) (\d+) (\S+) \d{4}-\d{2}-\d{2}T/);
  if (m) return { name: m[1], nexusId: Number(m[2]), version: m[3] };
  m = name.match(/^(.+?)-(\d+)-(.+)-(\d{9,})$/);
  if (m) return { name: m[1], nexusId: Number(m[2]), version: m[3].replace(/-/g, '.') };
  return { name, nexusId: null, version: null };
}

function modManager(paths) {
  if (exists(path.join(paths.dataDir, 'vortex.deployment.json'))) return 'Vortex';
  if (exists(path.join(paths.gameDir, 'ModOrganizer.exe'))) return 'Mod Organizer 2';
  return null;
}

module.exports = {
  APP_ID, gamePaths, isGameDir, detectGameDirs, steamPath, steamManifestPath, steamAutoUpdate,
  skseInfo, addressLibraryInfo, strInfo, sksePlugins, rootHooks, vortexMods, parseModFolderName, modManager,
  gameVersion: paths => shortVersion(peFileVersion(path.join(paths.gameDir, 'SkyrimSE.exe'))),
};
