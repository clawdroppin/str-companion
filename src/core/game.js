'use strict';
const path = require('path');
const os = require('os');
const { exists, readText, readJson, listDir, findCaseInsensitive, resolveCI, peFileVersion, shortVersion, run } = require('./util');

const APP_ID = '489830';

/**
 * The Windows user folder inside Proton's prefix for Skyrim on Linux:
 * <library>/steamapps/compatdata/489830/pfx/drive_c/users/steamuser
 */
function protonUserDir(steamappsDir) {
  return path.join(steamappsDir, 'compatdata', APP_ID, 'pfx', 'drive_c', 'users', 'steamuser');
}

/** First of several candidate folder names that exists (older Proton used different names). */
function firstExisting(base, candidates) {
  for (const c of candidates) {
    const p = resolveCI(base, ...c);
    if (exists(p)) return p;
  }
  return resolveCI(base, ...candidates[0]);
}

/**
 * Folders the game uses outside its install directory. On Windows these are the real Documents and
 * LocalAppData; on Linux they live inside the Proton prefix next to the game's Steam library.
 */
function gamePaths(gameDir, env = {}) {
  const platform = env.platform || process.platform;
  const steamappsDir = path.resolve(gameDir, '..', '..');
  let documents = env.documentsDir;
  let localAppData = env.localAppData;
  if (platform !== 'win32') {
    const user = protonUserDir(steamappsDir);
    documents = documents || firstExisting(user, [['Documents'], ['My Documents']]);
    localAppData = localAppData || firstExisting(user, [['AppData', 'Local'], ['Local Settings', 'Application Data']]);
  } else {
    documents = documents || path.join(os.homedir(), 'Documents');
    localAppData = localAppData || process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  }
  const myGames = resolveCI(documents, 'My Games', 'Skyrim Special Edition');
  const dataDir = resolveCI(gameDir, 'Data');
  return {
    platform,
    gameDir,
    dataDir,
    strDir: resolveCI(dataDir, 'SkyrimTogetherReborn'),
    myGames,
    skseLogs: resolveCI(myGames, 'SKSE'),
    saves: resolveCI(myGames, 'Saves'),
    localAppDir: resolveCI(localAppData, 'Skyrim Special Edition'),
    steamappsDir,
  };
}

function isGameDir(dir) {
  return !!dir && !!findCaseInsensitive(dir, 'SkyrimSE.exe') && !!findCaseInsensitive(dir, 'Data');
}

/** Parses Steam's libraryfolders.vdf for library paths. */
function steamLibraries(steamPath) {
  const vdf = readText(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'), '');
  const libs = [steamPath];
  for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.push(m[1].replace(/\\\\/g, '\\'));
  return [...new Set(libs.map(p => path.normalize(p)))];
}

/** Steam's install folders: from the registry on Windows; the usual native/Flatpak/Snap spots on Linux. */
async function steamPaths() {
  if (process.platform === 'win32') {
    const r = await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
    const m = r.stdout.match(/SteamPath\s+REG_SZ\s+(.+)/);
    const found = m ? [path.normalize(m[1].trim())] : [];
    return found.concat(['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'].filter(exists));
  }
  const home = os.homedir();
  return [
    ['.steam', 'steam'],
    ['.local', 'share', 'Steam'],
    ['.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'],
    ['snap', 'steam', 'common', '.local', 'share', 'Steam'],
  ].map(p => path.join(home, ...p)).filter(p => exists(path.join(p, 'steamapps')));
}

/** Looks through every Steam library for Skyrim Special Edition. */
async function detectGameDirs() {
  const libs = new Set();
  for (const sp of await steamPaths()) for (const lib of steamLibraries(sp)) libs.add(lib);
  const dirs = [...libs]
    .map(lib => resolveCI(lib, 'steamapps', 'common', 'Skyrim Special Edition'))
    .filter(isGameDir);
  // ~/.steam/steam is usually a symlink to ~/.local/share/Steam, so the same game can show up twice.
  const seen = new Set();
  return dirs.filter(d => {
    let real = d;
    try { real = require('fs').realpathSync(d); } catch {}
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
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
  const loaderPath = findCaseInsensitive(paths.gameDir, 'skse64_loader.exe');
  const loader = !!loaderPath;
  const builtFor = dlls.map(d => d.match(/skse64_(\d+)_(\d+)_(\d+)/i).slice(1).join('.'));
  return {
    installed: loader && dlls.length > 0,
    loader,
    builtFor,
    version: loader ? skseVersionString(peFileVersion(loaderPath)) : null,
  };
}

/** SKSE stamps its loader as 0.major.minor.build, e.g. "0.2.3.1" -> "2.3.1". */
function skseVersionString(v) {
  if (!v) return null;
  const parts = v.split('.');
  return (parts[0] === '0' ? parts.slice(1) : parts).join('.');
}

function addressLibraryInfo(paths, gameVersion) {
  const dir = resolveCI(paths.dataDir, 'SKSE', 'Plugins');
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
    plugins: ['SkyrimTogether.esp', 'SkyrimTogetherQuestPatches.esp'].filter(p => findCaseInsensitive(paths.dataDir, p)),
    configFile: resolveCI(paths.strDir, 'config', 'STServer.ini'),
  };
}

/** SKSE plugin DLLs installed in Data/SKSE/Plugins. */
function sksePlugins(paths) {
  return listDir(resolveCI(paths.dataDir, 'SKSE', 'Plugins'))
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
  APP_ID, gamePaths, protonUserDir, isGameDir, detectGameDirs, steamPaths, steamManifestPath, steamAutoUpdate,
  skseInfo, addressLibraryInfo, strInfo, sksePlugins, rootHooks, vortexMods, parseModFolderName, modManager,
  gameVersion: paths => shortVersion(peFileVersion(resolveCI(paths.gameDir, 'SkyrimSE.exe'))),
};
