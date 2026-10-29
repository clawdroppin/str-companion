'use strict';
/**
 * Builds fake Skyrim installs for tests and CI. Never touches a real game.
 *   node test/fixtures.js <dir>   -> creates a Proton-style (Linux) fake install in <dir>, prints the game folder
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const plugins = require('../src/core/plugins');
const game = require('../src/core/game');

/** Minimal TES4 header with the given masters and flags. */
function pluginBytes(masters = [], flags = 0) {
  const subs = [];
  const sub = (type, data) => {
    const h = Buffer.alloc(6);
    h.write(type, 0, 'latin1');
    h.writeUInt16LE(data.length, 4);
    subs.push(h, data);
  };
  sub('HEDR', Buffer.alloc(12));
  sub('CNAM', Buffer.from('Tester\0', 'latin1'));
  for (const m of masters) { sub('MAST', Buffer.from(m + '\0', 'latin1')); sub('DATA', Buffer.alloc(8)); }
  const body = Buffer.concat(subs);
  const head = Buffer.alloc(24);
  head.write('TES4', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  head.writeUInt32LE(flags, 8);
  return Buffer.concat([head, body]);
}

/** A PE-ish file with just a VS_FIXEDFILEINFO block, enough for peFileVersion(). */
function exeWithVersion(v) {
  const [a, b, c, d] = v.split('.').map(Number);
  const buf = Buffer.alloc(64);
  buf.write('MZ', 0, 'latin1');
  Buffer.from([0xbd, 0x04, 0xef, 0xfe]).copy(buf, 16);
  buf.writeUInt32LE(0x00010000, 20);
  buf.writeUInt32LE(((a << 16) | b) >>> 0, 24);
  buf.writeUInt32LE(((c << 16) | d) >>> 0, 28);
  return buf;
}

/**
 * @param opts.proton  lay out Documents/AppData inside steamapps/compatdata like Proton does
 * @param opts.lowercasePluginsTxt  write "plugins.txt" instead of "Plugins.txt"
 */
function fakeGame(opts = {}) {
  const root = opts.root || fs.mkdtempSync(path.join(os.tmpdir(), 'strc-test-'));
  const steamapps = path.join(root, 'steamapps');
  const gameDir = path.join(steamapps, 'common', 'Skyrim Special Edition');
  const data = path.join(gameDir, 'Data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'SkyrimSE.exe'), exeWithVersion('1.6.1170.0'));
  for (const m of plugins.BASE_MASTERS) fs.writeFileSync(path.join(data, m), pluginBytes(m === 'Skyrim.esm' ? [] : ['Skyrim.esm'], 1));
  const cc = ['ccBGSSSE001-Fish.esm', 'ccQDRSSE001-SurvivalMode.esl', 'ccBGSSSE037-Curios.esl', 'ccBGSSSE025-AdvDSGS.esm', '_ResourcePack.esl', 'ccBGSSSE002-ExoticArrows.esl'];
  fs.writeFileSync(path.join(gameDir, 'Skyrim.ccc'), cc.join('\r\n') + '\r\n');
  for (const c of cc) {
    fs.writeFileSync(path.join(data, c), pluginBytes(['Skyrim.esm'], 1));
    fs.writeFileSync(path.join(data, c.replace(/\.es[ml]$/, '.bsa')), 'bsa');
  }
  fs.writeFileSync(path.join(data, 'USSEP.esp'), pluginBytes(['Skyrim.esm', 'ccBGSSSE001-Fish.esm']));
  fs.writeFileSync(path.join(data, 'USSEP - Textures.bsa'), 'bsa');
  fs.writeFileSync(path.join(data, 'Addon.esp'), pluginBytes(['Skyrim.esm', 'USSEP.esp']));

  // Skyrim Together, as the Nexus archive lays it out.
  const str = path.join(data, 'SkyrimTogetherReborn');
  fs.mkdirSync(path.join(str, 'config'), { recursive: true });
  fs.mkdirSync(path.join(str, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(str, 'SkyrimTogether.exe'), 'x');
  fs.writeFileSync(path.join(str, 'SkyrimTogetherServer.exe'), 'x');
  fs.writeFileSync(path.join(data, 'SkyrimTogether.esp'), pluginBytes(['Skyrim.esm', 'Update.esm']));
  fs.writeFileSync(path.join(data, 'SkyrimTogetherQuestPatches.esp'), pluginBytes(['Skyrim.esm', 'Update.esm'], 0x200));
  fs.writeFileSync(path.join(str, 'config', 'STServer.ini'), '[Gameplay]\r\n; Enables pvp\r\nbEnablePvp=false\r\nuDifficulty=4\r\n\r\n[GameServer]\r\nsPassword=\r\nuPort=10578\r\n');
  fs.writeFileSync(path.join(str, 'logs', 'STServerOut.log'), "[2026-10-11 01:43:35.804] [info] [tid 1]  Server v1.8.3 started on port 10578\n");

  // SKSE + Address Library
  fs.writeFileSync(path.join(gameDir, 'skse64_loader.exe'), exeWithVersion('0.2.2.6'));
  fs.writeFileSync(path.join(gameDir, 'skse64_1_6_1170.dll'), 'x');
  fs.mkdirSync(path.join(data, 'SKSE', 'Plugins'), { recursive: true });
  fs.writeFileSync(path.join(data, 'SKSE', 'Plugins', 'versionlib-1-6-1170-0.bin'), 'x');

  let documentsDir, localAppData;
  if (opts.proton) {
    const user = game.protonUserDir(steamapps);
    documentsDir = path.join(user, 'Documents');
    localAppData = path.join(user, 'AppData', 'Local');
  } else {
    documentsDir = path.join(root, 'docs');
    localAppData = path.join(root, 'local');
  }
  const local = path.join(localAppData, 'Skyrim Special Edition');
  fs.mkdirSync(local, { recursive: true });
  const pluginsName = opts.lowercasePluginsTxt ? 'plugins.txt' : 'Plugins.txt';
  fs.writeFileSync(path.join(local, pluginsName), '# This file is used by Skyrim\r\n*USSEP.esp\r\n*Addon.esp\r\n*SkyrimTogether.esp\r\n*SkyrimTogetherQuestPatches.esp\r\n');
  const myGames = path.join(documentsDir, 'My Games', 'Skyrim Special Edition');
  fs.mkdirSync(path.join(myGames, 'Saves'), { recursive: true });
  fs.writeFileSync(path.join(myGames, 'SkyrimPrefs.ini'), '[Display]\r\nbBorderless=0\r\nbFull Screen=1\r\n[Interface]\r\nbDialogueSubtitles=0\r\n');
  fs.writeFileSync(path.join(myGames, 'Saves', 'Save1.ess'), 'save');

  const paths = opts.proton
    ? game.gamePaths(gameDir, { platform: 'linux' })
    : game.gamePaths(gameDir, { documentsDir, localAppData });
  return { root, paths };
}

/** A sample Crash Logger report, so the crash reader has something to show. */
function addCrashLog(paths) {
  fs.mkdirSync(paths.skseLogs, { recursive: true });
  fs.writeFileSync(path.join(paths.skseLogs, 'crash-2026-10-18-21-00-00.log'), [
    'Unhandled exception "EXCEPTION_ACCESS_VIOLATION" at 0x7FF712345678 SkyrimSE.exe+0ABCDEF',
    '', 'PROBABLE CALL STACK:', '\t[0] 0x7FF712345678 SkyrimSE.exe+0ABCDEF', '\t[1] 0x7FFA00001234 ExampleMod.dll+0001234',
    '', 'POSSIBLE RELEVANT OBJECTS:', '\tFile: "Addon.esp"', '', 'PLUGINS:', '\t[00] Skyrim.esm',
  ].join('\n'));
}

module.exports = { pluginBytes, exeWithVersion, fakeGame, addCrashLog };

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'strc-fake-')));
  fs.mkdirSync(dir, { recursive: true });
  const { paths } = fakeGame({ root: dir, proton: true });
  // A sample crash report, so the UI check covers the crash reader too.
  addCrashLog(paths);
  process.stdout.write(paths.gameDir + '\n');
}

