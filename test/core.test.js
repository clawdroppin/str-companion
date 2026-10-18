'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { IniDoc } = require('../src/core/ini');
const plugins = require('../src/core/plugins');
const game = require('../src/core/game');
const { BackupStore } = require('../src/core/backup');
const { Installer, analyze } = require('../src/core/installer');
const share = require('../src/core/share');
const configs = require('../src/core/configs');
const cleanup = require('../src/core/cleanup');
const health = require('../src/core/health');
const { run } = require('../src/core/util');

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

function fakeGame() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strc-test-'));
  const gameDir = path.join(root, 'steamapps', 'common', 'Skyrim Special Edition');
  const data = path.join(gameDir, 'Data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'SkyrimSE.exe'), 'x');
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
  const local = path.join(root, 'local', 'Skyrim Special Edition');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, 'Plugins.txt'), '# This file is used by Skyrim\r\n*USSEP.esp\r\n*Addon.esp\r\n');
  const paths = game.gamePaths(gameDir, { documentsDir: path.join(root, 'docs'), localAppData: path.join(root, 'local') });
  return { root, paths };
}

test('ini round-trips byte for byte and edits in place', () => {
  const text = '[general]\r\n; How much detail\r\nsLogLevel=info\r\n\r\n[Gameplay]\r\nbEnablePvp=false\r\n';
  const doc = new IniDoc(text);
  assert.strictEqual(doc.toString(), text);
  assert.strictEqual(doc.entries()[0].doc, 'How much detail');
  doc.set('gameplay', 'benablepvp', 'true');
  doc.set('Gameplay', 'uNew', '3');
  doc.set('Brand', 'k', 'v');
  assert.strictEqual(doc.toString(), '[general]\r\n; How much detail\r\nsLogLevel=info\r\n\r\n[Gameplay]\r\nbEnablePvp=true\r\nuNew=3\r\n\r\n[Brand]\r\nk=v\r\n');
});

test('toml inline comments survive edits', () => {
  const doc = new IniDoc('[Patches]\niSaveGameMaxSize = 128                          # max save size\n', { toml: true });
  assert.strictEqual(doc.get('Patches', 'iSaveGameMaxSize'), '128');
  assert.strictEqual(doc.entries()[0].doc, 'max save size');
  doc.set('Patches', 'iSaveGameMaxSize', '256');
  assert.match(doc.toString(), /^iSaveGameMaxSize = 256\s+# max save size$/m);
});

test('reads plugin masters and flags', () => {
  const { paths } = fakeGame();
  const h = plugins.readHeader(path.join(paths.dataDir, 'Addon.esp'));
  assert.deepStrictEqual(h.masters, ['Skyrim.esm', 'USSEP.esp']);
  assert.strictEqual(h.isMaster, false);
  assert.strictEqual(h.author, 'Tester');
});

test('load order puts base, then Creation Club, then Plugins.txt; masters check passes', () => {
  const { paths } = fakeGame();
  const { order } = plugins.effectiveLoadOrder(paths.gameDir, paths.localAppDir);
  assert.deepStrictEqual(order.map(o => o.name).slice(-3), ['ccBGSSSE002-ExoticArrows.esl', 'USSEP.esp', 'Addon.esp']);
  assert.deepStrictEqual(plugins.checkMasters(paths.gameDir, order), []);
});

test('Creation Club report keeps the free four and never offers _ResourcePack', () => {
  const { paths } = fakeGame();
  const r = cleanup.creationClubReport(paths);
  assert.deepStrictEqual(r.removable.map(i => i.plugin), ['ccBGSSSE002-ExoticArrows.esl']);
  assert.strictEqual(r.keep.length, 4);
  assert.ok(!r.keep.concat(r.removable).some(i => i.plugin === '_ResourcePack.esl'));
});

test('backup moves files and plugin entries, restore puts them back', () => {
  const { paths } = fakeGame();
  const store = new BackupStore(paths);
  const r = store.backup(['Data/USSEP.esp', 'Data/USSEP - Textures.bsa'], { label: 'USSEP' });
  assert.strictEqual(r.moved, 2);
  assert.ok(!fs.existsSync(path.join(paths.dataDir, 'USSEP.esp')));
  assert.doesNotMatch(fs.readFileSync(path.join(paths.localAppDir, 'Plugins.txt'), 'utf8'), /USSEP/);

  const { order } = plugins.effectiveLoadOrder(paths.gameDir, paths.localAppDir);
  // Addon.esp still loads but its master is gone — exactly what the dashboard must flag.
  assert.deepStrictEqual(plugins.checkMasters(paths.gameDir, order), [{ plugin: 'Addon.esp', master: 'USSEP.esp', kind: 'missing' }]);

  const back = store.restore(store.list()[0].id);
  assert.strictEqual(back.restored, 2);
  assert.ok(fs.existsSync(path.join(paths.dataDir, 'USSEP.esp')));
  assert.match(fs.readFileSync(path.join(paths.localAppDir, 'Plugins.txt'), 'utf8'), /\*USSEP\.esp/);
  assert.strictEqual(store.list().length, 0);
});

test('missing master is reported and health offers a restore from backup', () => {
  const { paths } = fakeGame();
  const store = new BackupStore(paths);
  store.backup(['Data/ccBGSSSE001-Fish.esm', 'Data/ccBGSSSE001-Fish.bsa'], { label: 'cc' });
  const snap = health.snapshot(paths);
  assert.ok(snap.masterProblems.some(p => p.master === 'ccBGSSSE001-Fish.esm' && p.kind === 'missing'));
  const check = health.checks(paths, snap, store).find(c => /missing master/.test(c.title));
  assert.strictEqual(check.level, 'error');
  assert.strictEqual(check.fix.action, 'restoreFiles');
  assert.strictEqual(check.fix.items.length, 2);
});

test('adopts a hand-made backup folder', () => {
  const { paths } = fakeGame();
  const legacy = path.join(paths.gameDir, '_CoopBackup_2026-10-15', 'CreationClub');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'ccFoo-sse001.esl'), pluginBytes(['Skyrim.esm']));
  const store = new BackupStore(paths);
  const id = store.adoptFolder(legacy, { label: 'old' });
  assert.ok(id);
  assert.strictEqual(store.adoptFolder(legacy), null, 'adopting twice is a no-op');
  store.restore(id);
  assert.ok(fs.existsSync(path.join(paths.dataDir, 'ccFoo-sse001.esl')));
});

test('installer detects Data vs game-root layouts and FOMODs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strc-layout-'));
  const mk = (name, files) => {
    const d = path.join(tmp, name);
    for (const f of files) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), 'x'); }
    return d;
  };
  assert.strictEqual(analyze(mk('str', ['SkyrimTogether.esp', 'SkyrimTogetherReborn/SkyrimTogether.exe'])).target, 'data');
  assert.strictEqual(analyze(mk('skse', ['skse64_2_3_1/skse64_loader.exe', 'skse64_2_3_1/skse64_1_7_104.dll', 'skse64_2_3_1/Data/Scripts/a.pex'])).target, 'game');
  assert.strictEqual(analyze(mk('addr', ['SKSE/Plugins/versionlib-1-7-104-0.bin'])).target, 'data');
  assert.strictEqual(analyze(mk('preload', ['d3dx9_42.dll'])).target, 'game');
  assert.strictEqual(analyze(mk('fomod', ['fomod/ModuleConfig.xml', 'Core/x.esp'])).fomod, true);
});

test('installs an archive, backs up what it replaces, uninstall moves it to backup', async () => {
  const { root, paths } = fakeGame();
  const src = path.join(root, 'modsrc', 'Cool Mod');
  fs.mkdirSync(path.join(src, 'meshes'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Cool.esp'), pluginBytes(['Skyrim.esm']));
  fs.writeFileSync(path.join(src, 'meshes', 'a.nif'), 'new');
  fs.mkdirSync(path.join(paths.dataDir, 'meshes'), { recursive: true });
  fs.writeFileSync(path.join(paths.dataDir, 'meshes', 'a.nif'), 'old');
  const archive = path.join(root, 'Cool Mod-123-1-0.7z');
  const r7 = await run(require('7zip-bin').path7za, ['a', archive, src]);
  assert.ok(r7.ok, r7.stderr);

  const store = new BackupStore(paths);
  const inst = new Installer(paths, path.join(root, 'appdata'), store);
  const res = await inst.installArchive(archive, { name: 'Cool Mod', nexusId: 123, version: '1.0' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.target, 'data');
  assert.strictEqual(res.replaced, 1);
  assert.strictEqual(fs.readFileSync(path.join(paths.dataDir, 'meshes', 'a.nif'), 'utf8'), 'new');
  assert.match(fs.readFileSync(path.join(paths.localAppDir, 'Plugins.txt'), 'utf8'), /\*Cool\.esp/);

  inst.uninstall(res.key);
  assert.ok(!fs.existsSync(path.join(paths.dataDir, 'Cool.esp')));
  assert.deepStrictEqual(Object.keys(inst.registry()), []);
});

test('updating an app-installed mod replaces its own files and backs up only dropped ones; uninstall restores originals', async () => {
  const { root, paths } = fakeGame();
  const mkArchive = async (name, files) => {
    const src = path.join(root, 'src-' + name, 'Mod');
    for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true }); fs.writeFileSync(path.join(src, f), body); }
    const out = path.join(root, `${name}.7z`);
    assert.ok((await run(require('7zip-bin').path7za, ['a', out, src])).ok);
    return out;
  };
  fs.mkdirSync(path.join(paths.dataDir, 'textures'), { recursive: true });
  fs.writeFileSync(path.join(paths.dataDir, 'textures', 'shared.dds'), 'vanilla');

  const store = new BackupStore(paths);
  const inst = new Installer(paths, path.join(root, 'appdata'), store);
  const v1 = await mkArchive('v1', { 'Mod.esp': 'p', 'textures/shared.dds': 'v1', 'textures/old.dds': 'old' });
  await inst.installArchive(v1, { name: 'Mod', nexusId: 7, version: '1' });
  assert.strictEqual(store.list().length, 1, 'vanilla shared.dds backed up once');

  const v2 = await mkArchive('v2', { 'Mod.esp': 'p2', 'textures/shared.dds': 'v2' });
  const r = await inst.installArchive(v2, { name: 'Mod', nexusId: 7, version: '2' });
  assert.strictEqual(r.replaced, 0, 'own files are not re-backed-up on update');
  assert.ok(!fs.existsSync(path.join(paths.dataDir, 'textures', 'old.dds')), 'dropped file removed');
  assert.ok(store.list().some(b => /Removed by Mod update/.test(b.label)));

  const u = inst.uninstall('nexus-7');
  assert.strictEqual(u.originalsRestored, 1);
  assert.strictEqual(fs.readFileSync(path.join(paths.dataDir, 'textures', 'shared.dds'), 'utf8'), 'vanilla');
});

test('save snapshots copy, list and restore with a safety snapshot', () => {
  const { paths } = fakeGame();
  fs.mkdirSync(paths.saves, { recursive: true });
  fs.writeFileSync(path.join(paths.saves, 'Save1.ess'), 'one');
  const store = new BackupStore(paths);
  const s = store.snapshotSaves('test');
  assert.strictEqual(s.files, 1);
  fs.writeFileSync(path.join(paths.saves, 'Save1.ess'), 'broken');
  const r = store.restoreSaveSnapshot(s.id);
  assert.strictEqual(r.restored, 1);
  assert.ok(r.safety);
  assert.strictEqual(fs.readFileSync(path.join(paths.saves, 'Save1.ess'), 'utf8'), 'one');
  assert.strictEqual(store.listSaveSnapshots().length, 2);
});

test('new ini files get Windows line endings', () => {
  const doc = new IniDoc('');
  doc.set('Display', 'bBorderless', '1');
  assert.strictEqual(doc.toString(), '[Display]\r\nbBorderless=1\r\n');
});

test('setup codes round-trip and report differences', () => {
  const mine = { playerName: 'A', gameVersion: '1.7.104', strVersion: '1.8.3', skseVersion: '2.3.1', addressLibrary: true, plugins: ['Skyrim.esm', 'USSEP.esp', 'X.esp'], sksePlugins: ['EngineFixes.dll'] };
  const code = share.makeCode(mine);
  assert.match(code, /^STR1-/);
  assert.deepStrictEqual(share.parseCode(code), mine);
  assert.deepStrictEqual(share.compare(mine, mine), []);
  const theirs = { ...mine, gameVersion: '1.6.1170', plugins: ['Skyrim.esm', 'USSEP.esp'], sksePlugins: [] };
  const d = share.compare(mine, theirs);
  assert.ok(d.some(x => x.level === 'error' && /Game version/.test(x.text)));
  assert.ok(d.some(x => /missing X\.esp/.test(x.text)));
  const reordered = { ...mine, plugins: ['Skyrim.esm', 'X.esp', 'USSEP.esp'] };
  assert.ok(share.compare(mine, reordered).some(x => /load order/.test(x.text)));
});

test('parses Vortex folder names', () => {
  assert.deepStrictEqual(game.parseModFolderName('Skyrim Together Reborn 69993 1.8.3 2026-10-03T20-22Z Ks18n0UzJ'), { name: 'Skyrim Together Reborn', nexusId: 69993, version: '1.8.3' });
  assert.deepStrictEqual(game.parseModFolderName('Alternate Start - Live Another Life-272-4-2-6a-1772996477'), { name: 'Alternate Start - Live Another Life', nexusId: 272, version: '4.2.6a' });
});

test('config save snapshots the old file and presets apply', () => {
  const { paths } = fakeGame();
  const cfg = path.join(paths.strDir, 'config', 'STServer.ini');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, '[Gameplay]\r\n; Enables pvp\r\nbEnablePvp=false\r\nuDifficulty=4\r\n');
  const store = new BackupStore(paths);
  const loaded = configs.load(paths, 'server');
  const pvp = loaded.entries.find(e => e.key === 'bEnablePvp');
  assert.strictEqual(pvp.label, 'PvP');
  assert.strictEqual(pvp.type, 'bool');
  const r = configs.save(paths, 'server', [{ section: 'Gameplay', key: 'bEnablePvp', value: 'true' }], store);
  assert.strictEqual(r.changed, 1);
  assert.ok(fs.existsSync(r.snapshot));
  const preset = configs.presets('server', os.tmpdir()).find(p => p.name.startsWith('Story Co-op'));
  configs.save(paths, 'server', configs.presetToChanges(preset.values), store);
  const after = fs.readFileSync(cfg, 'utf8');
  assert.match(after, /uMaxPlayerCount=3/);
  assert.match(after, /bEnablePvp=false/);
  assert.match(after, /\r\n/);
});
