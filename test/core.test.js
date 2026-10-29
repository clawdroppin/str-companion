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
const { Installer, analyze, sevenZip } = require('../src/core/installer');
const share = require('../src/core/share');
const logs = require('../src/core/logs');
const configs = require('../src/core/configs');
const cleanup = require('../src/core/cleanup');
const health = require('../src/core/health');
const util = require('../src/core/util');
const { run } = util;

const { pluginBytes, fakeGame } = require('./fixtures');

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
  assert.deepStrictEqual(order.map(o => o.name).slice(-5), ['ccBGSSSE002-ExoticArrows.esl', 'USSEP.esp', 'Addon.esp', 'SkyrimTogether.esp', 'SkyrimTogetherQuestPatches.esp']);
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
  const r7 = await run(sevenZip().exe, ['a', archive, src]);
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
    assert.ok((await run(sevenZip().exe, ['a', out, src])).ok);
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

test('save snapshots copy, list and restore with a safety snapshot', async () => {
  const { paths } = fakeGame();
  fs.mkdirSync(paths.saves, { recursive: true });
  fs.writeFileSync(path.join(paths.saves, 'Save1.ess'), 'one');
  const store = new BackupStore(paths);
  const s = await store.snapshotSaves('test');
  assert.strictEqual(s.files, 1);
  fs.writeFileSync(path.join(paths.saves, 'Save1.ess'), 'broken');
  const r = await store.restoreSaveSnapshot(s.id);
  assert.strictEqual(r.restored, 1);
  assert.ok(r.safety);
  assert.strictEqual(fs.readFileSync(path.join(paths.saves, 'Save1.ess'), 'utf8'), 'one');
  assert.strictEqual(store.listSaveSnapshots().length, 2);
  await assert.rejects(store.restoreSaveSnapshot('../../evil'), /not found/);
});

test('automatic save snapshots are pruned, manual ones kept', async () => {
  const { paths } = fakeGame();
  const store = new BackupStore(paths);
  await store.snapshotSaves('manual');
  for (let i = 0; i < 4; i++) await store.snapshotSaves('auto', { auto: true, keepAuto: 2 });
  const list = store.listSaveSnapshots();
  assert.strictEqual(list.filter(x => x.auto).length, 2);
  assert.strictEqual(list.filter(x => !x.auto).length, 1);
  store.deleteSaveSnapshot(list[0].id);
  assert.strictEqual(store.listSaveSnapshots().length, 2);
  assert.ok(store.usage().saves > 0);
});

test('new ini files get Windows line endings', () => {
  const doc = new IniDoc('');
  doc.set('Display', 'bBorderless', '1');
  assert.strictEqual(doc.toString(), '[Display]\r\nbBorderless=1\r\n');
});

test('setup codes round-trip and report differences', () => {
  const mine = { playerName: 'A', gameVersion: '1.7.104', strVersion: '1.8.3', skseVersion: '2.3.1', addressLibrary: true, plugins: ['Skyrim.esm', 'USSEP.esp', 'X.esp'], sksePlugins: ['EngineFixes.dll'], nexusIds: { 'USSEP.esp': 266 }, mods: [{ nexusId: 266, version: '4.3.9c', name: 'Unofficial Skyrim Special Edition Patch', fileHint: '' }] };
  const code = share.makeCode(mine);
  assert.match(code, /^STR2-/);
  assert.throws(() => share.parseCode('STR2-garbage!!'), /isn't an STR Companion setup code/);
  assert.throws(() => share.parseCode('STR2-AAAA'), /damaged/);
  // Codes from 1.1.x (STR1, no Nexus ids) still parse.
  const v1 = 'STR1-' + require('zlib').deflateRawSync(Buffer.from(JSON.stringify({ n: 'B', g: '1', p: ['Skyrim.esm'] }))).toString('base64url');
  assert.deepStrictEqual(share.parseCode(v1).nexusIds, {});
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

// ---------- Linux / Proton ----------

test('Linux: game paths resolve inside the Proton prefix', () => {
  const { paths } = fakeGame({ proton: true });
  const norm = p => p.split(path.sep).join('/');
  assert.match(norm(paths.localAppDir), /compatdata\/489830\/pfx\/drive_c\/users\/steamuser\/AppData\/Local\/Skyrim Special Edition$/);
  assert.match(norm(paths.myGames), /steamuser\/Documents\/My Games\/Skyrim Special Edition$/);
  const snap = health.snapshot(paths);
  assert.strictEqual(snap.gameVersion, '1.6.1170');
  assert.strictEqual(snap.skse.version, '2.2.6');
  assert.ok(snap.addressLibrary.matchesGame);
  assert.ok(snap.str.installed);
  assert.strictEqual(snap.str.version, '1.8.3');
  assert.deepStrictEqual(snap.masterProblems, []);
  assert.strictEqual(configs.load(paths, 'prefs').entries.find(e => e.key === 'bBorderless').value, '0');
});

test('Linux: older Proton folder names are found', () => {
  const { root } = fakeGame({ proton: true });
  const user = game.protonUserDir(path.join(root, 'steamapps'));
  fs.renameSync(path.join(user, 'Documents'), path.join(user, 'My Documents'));
  const paths = game.gamePaths(path.join(root, 'steamapps', 'common', 'Skyrim Special Edition'), { platform: 'linux' });
  assert.match(paths.myGames.split(path.sep).join('/'), /My Documents\/My Games/);
});

test('case-insensitive files: lowercase plugins.txt and data folder still work', () => {
  const { paths } = fakeGame({ lowercasePluginsTxt: true });
  const { order } = plugins.effectiveLoadOrder(paths.gameDir, paths.localAppDir);
  assert.ok(order.some(p => p.name === 'USSEP.esp'), 'reads lowercase plugins.txt');
  plugins.addToPluginsTxt(paths.localAppDir, ['New.esp']);
  assert.ok(!fs.existsSync(path.join(paths.localAppDir, 'Plugins.txt')) || process.platform === 'win32', 'did not create a second, differently-cased file');
  assert.match(fs.readFileSync(path.join(paths.localAppDir, 'plugins.txt'), 'utf8'), /\*New\.esp/);
});

test('resolveCI and parsePsOutput', () => {
  const { paths } = fakeGame();
  assert.strictEqual(util.resolveCIStrict(paths.gameDir, 'DATA', 'skse', 'PLUGINS'), path.join(paths.gameDir, 'Data', 'SKSE', 'Plugins'));
  assert.strictEqual(util.resolveCIStrict(paths.gameDir, 'NotThere', 'x'), path.join(paths.gameDir, 'NotThere', 'x'));
  assert.ok(util.isInside(paths.gameDir, path.join(paths.gameDir, 'Data', 'x.esp')));
  assert.ok(!util.isInside(paths.gameDir, path.join(paths.gameDir, '..', 'evil.txt')));
  const names = util.parsePsOutput([
    '/home/me/.local/share/Steam/ubuntu12_32/steam -srt-logger-opened',
    String.raw`Z:\home\me\.local\share\Steam\steamapps\common\Skyrim Special Edition\SkyrimSE.exe`,
    '/usr/bin/wine /games/Skyrim Special Edition/Data/SkyrimTogetherReborn/SkyrimTogetherServer.exe',
  ].join('\n'));
  for (const n of ['steam', 'skyrimse.exe', 'skyrimtogetherserver.exe']) assert.ok(names.has(n), n);
});

test('Linux: bundled 7-Zip without the executable bit still runs', { skip: process.platform === 'win32' }, async () => {
  const { executableCopy } = require('../src/core/installer');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strc-7z-'));
  const copy = path.join(tmp, '7za');
  fs.copyFileSync(require('7zip-bin').path7za, copy);
  fs.chmodSync(copy, 0o644);
  const exe = executableCopy(copy);
  const r = await run(exe, ['i']);
  assert.ok(r.ok, r.stderr);
});

// ---------- 1.2.0: bug fixes ----------

test('version compare understands letter suffixes', () => {
  assert.strictEqual(util.compareVersions('4.3.9c', '4.3.9b'), 1);
  assert.strictEqual(util.compareVersions('4.3.9', '4.3.9c'), -1);
  assert.strictEqual(util.compareVersions('4.3.10', '4.3.9c'), 1);
  assert.strictEqual(util.compareVersions('v1.2.0', '1.2.0'), 0);
  assert.strictEqual(util.compareVersions('1.10.0', '1.9.9'), 1);
});

test('.esm without the master flag still loads with the masters', () => {
  const { paths } = fakeGame();
  fs.writeFileSync(path.join(paths.dataDir, 'Unflagged.esm'), pluginBytes(['Skyrim.esm'], 0));
  fs.appendFileSync(path.join(paths.localAppDir, 'Plugins.txt'), '*Unflagged.esm\r\n');
  const { order } = plugins.effectiveLoadOrder(paths.gameDir, paths.localAppDir);
  const names = order.map(o => o.name);
  assert.ok(names.indexOf('Unflagged.esm') < names.indexOf('USSEP.esp'));
});

test('plugin headers with an XXXX oversized field parse correctly', () => {
  const { paths } = fakeGame();
  const big = Buffer.alloc(70000, 0x41);
  const parts = [];
  const sub = (type, data, len = data.length) => {
    const h = Buffer.alloc(6);
    h.write(type, 0, 'latin1');
    h.writeUInt16LE(len & 0xffff, 4);
    parts.push(h, data);
  };
  sub('HEDR', Buffer.alloc(12));
  sub('MAST', Buffer.from('Skyrim.esm\0', 'latin1'));
  sub('DATA', Buffer.alloc(8));
  const xx = Buffer.alloc(4);
  xx.writeUInt32LE(big.length, 0);
  sub('XXXX', xx);
  sub('ONAM', big, 0);
  sub('SNAM', Buffer.from('after big field\0', 'latin1'));
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(24);
  head.write('TES4', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  head.writeUInt32LE(1, 8);
  const file = path.join(paths.dataDir, 'Big.esm');
  fs.writeFileSync(file, Buffer.concat([head, body]));
  const h = plugins.readHeader(file);
  assert.deepStrictEqual(h.masters, ['Skyrim.esm']);
  assert.strictEqual(h.description, 'after big field');
});

test('backups refuse paths outside the game folder', () => {
  const { root, paths } = fakeGame();
  fs.writeFileSync(path.join(root, 'outside.txt'), 'keep me');
  const store = new BackupStore(paths);
  const r = store.backup(['../../../outside.txt', '_STRCompanion_Backup/manifest.json']);
  assert.strictEqual(r.moved, 0);
  assert.strictEqual(r.errors.length, 2);
  assert.ok(fs.existsSync(path.join(root, 'outside.txt')));
});

test('restore drops files deleted from the backup by hand; batches can be deleted', () => {
  const { paths } = fakeGame();
  const store = new BackupStore(paths);
  const { id } = store.backup(['Data/USSEP.esp', 'Data/USSEP - Textures.bsa']);
  fs.unlinkSync(path.join(store.root, id, 'Data', 'USSEP - Textures.bsa'));
  const r = store.restore(id);
  assert.strictEqual(r.restored, 1);
  assert.strictEqual(r.missing, 1);
  assert.strictEqual(store.list().length, 0, 'batch finished');
  const b = store.backup(['Data/Addon.esp']);
  store.deleteBatch(b.id);
  assert.strictEqual(store.list().length, 0);
  assert.ok(!fs.existsSync(path.join(store.root, b.id)));
});

// ---------- 1.2.0: features ----------

test('load-order match plan and applying it', () => {
  const { paths } = fakeGame();
  fs.writeFileSync(path.join(paths.dataDir, 'Extra.esp'), pluginBytes(['Skyrim.esm']));
  fs.writeFileSync(path.join(paths.dataDir, 'Inactive.esp'), pluginBytes(['Skyrim.esm']));
  fs.appendFileSync(path.join(paths.localAppDir, 'Plugins.txt'), '*Extra.esp\r\nInactive.esp\r\n');
  const lo = plugins.effectiveLoadOrder(paths.gameDir, paths.localAppDir);
  const mine = { plugins: lo.order.map(p => p.name) };
  const implicit = lo.order.filter(p => p.source !== 'plugins.txt').map(p => p.name);
  const theirs = {
    plugins: [...implicit.filter(n => !/ExoticArrows/i.test(n)), 'SkyrimTogether.esp', 'SkyrimTogetherQuestPatches.esp', 'Inactive.esp', 'USSEP.esp', 'Addon.esp', 'NotHere.esp'],
    nexusIds: { 'NotHere.esp': 123 },
  };
  const onDisk = [...lo.order.map(p => p.name), ...lo.inactive];
  const plan = share.matchPlan(mine, theirs, { onDisk, implicit });
  assert.deepStrictEqual(plan.missing, [{ name: 'NotHere.esp', nexusId: 123 }]);
  assert.deepStrictEqual(plan.activate, ['Inactive.esp']);
  assert.deepStrictEqual(plan.deactivate, ['Extra.esp']);
  assert.deepStrictEqual(plan.extraImplicit, ['ccBGSSSE002-ExoticArrows.esl']);
  assert.ok(plan.reorder);

  plugins.applyLoadOrder(paths.gameDir, paths.localAppDir, plan.order);
  const after = plugins.effectiveLoadOrder(paths.gameDir, paths.localAppDir).order
    .filter(p => p.source === 'plugins.txt').map(p => p.name);
  assert.deepStrictEqual(after, ['SkyrimTogether.esp', 'SkyrimTogetherQuestPatches.esp', 'Inactive.esp', 'USSEP.esp', 'Addon.esp']);
  assert.match(fs.readFileSync(path.join(paths.localAppDir, 'Plugins.txt'), 'utf8'), /^Extra\.esp\r?$/m, 'extra plugin kept but switched off');
  assert.ok(share.pluginsMatch({ plugins: ['A.esp', 'b.esp'] }, { plugins: ['a.esp', 'B.esp'] }));
});

test('crash logs are summarized with likely culprits', () => {
  const { paths } = fakeGame();
  fs.mkdirSync(paths.skseLogs, { recursive: true });
  fs.writeFileSync(path.join(paths.skseLogs, 'crash-2026-10-18-10-00-00.log'), [
    'Skyrim SSE v1.6.1170',
    'Unhandled exception "EXCEPTION_ACCESS_VIOLATION" at 0x7FF71234 SkyrimSE.exe+0123456',
    '',
    'PROBABLE CALL STACK:',
    '\t[0] 0x7FF71234 SkyrimSE.exe+0123456',
    '\t[1] 0x7FFA0001 BadMod.dll+0001234',
    '\t[2] 0x7FFA0002 BadMod.dll+0005678',
    '\t[3] 0x7FFA0003 KERNELBASE.dll+0000001',
    '',
    'POSSIBLE RELEVANT OBJECTS:',
    '\tFile: "Addon.esp" Modified by: USSEP.esp -> Addon.esp',
    '',
    'PLUGINS:',
    '\t[00] Skyrim.esm', '\t[01] USSEP.esp', '\t[02] Addon.esp', '\t[03] MyAddon.esp',
  ].join('\n'));
  const [c] = logs.crashReports(paths, ['Skyrim.esm', 'USSEP.esp', 'Addon.esp', 'MyAddon.esp']);
  assert.match(c.exception, /EXCEPTION_ACCESS_VIOLATION at SkyrimSE\.exe\+0123456/);
  assert.deepStrictEqual(c.modules, [{ name: 'BadMod.dll', count: 2 }]);
  assert.deepStrictEqual(c.plugins[0], { name: 'Addon.esp', count: 2 });
  assert.ok(!c.plugins.some(p => p.name === 'MyAddon.esp'), 'the full plugin list at the end is ignored');
  const snap = health.snapshot(paths);
  assert.ok(health.checks(paths, snap, null).some(x => /Skyrim crashed/.test(x.title)));
  assert.ok(!health.checks(paths, snap, null, { crashAck: '2999-01-01' }).some(x => /Skyrim crashed/.test(x.title)));
});

test('health flags switched-off STR plugins, game updates and plugin counts', () => {
  const { paths } = fakeGame();
  plugins.removeFromLists(paths.localAppDir, ['SkyrimTogether.esp']);
  const snap = health.snapshot(paths);
  assert.deepStrictEqual(snap.strPluginsOff, ['SkyrimTogether.esp']);
  const list = health.checks(paths, snap, null, { lastSeen: { game: '1.6.640', str: '1.8.3' } });
  const off = list.find(x => /switched off/.test(x.title));
  assert.strictEqual(off.fix.action, 'activatePlugins');
  assert.ok(list.some(x => /updated from 1\.6\.640 to 1\.6\.1170/.test(x.title)));
  assert.ok(snap.counts.full > 0 && snap.counts.light > 0);
});

// ---------- Quick Setup ----------

test('setup plan: foundation mods first, exact versions, unknown plugins, cleanup and load order', () => {
  const setup = require('../src/core/setup');
  const host = {
    gameVersion: '1.7.104',
    plugins: ['Skyrim.esm', 'SkyrimTogether.esp', 'SkyUI_SE.esp', 'Mystery.esp'],
    nexusIds: { 'SkyrimTogether.esp': 69993, 'SkyUI_SE.esp': 12604 },
    mods: [
      { nexusId: 12604, version: '5.2SE', name: 'SkyUI', fileHint: 'SkyUI_5_2_SE' },
      { nexusId: 32444, version: '13', name: 'Address Library All in One', fileHint: '' },
      { nexusId: 69993, version: '1.8.3', name: 'Skyrim Together Reborn', fileHint: '' },
      { nexusId: 30379, version: null, name: 'SKSE', fileHint: '' },
    ],
  };
  const local = {
    gameVersion: '1.6.1170',
    mine: { plugins: ['Skyrim.esm', 'ccBGSSSE002-ExoticArrows.esl', 'SkyrimTogether.esp'] },
    onDisk: ['Skyrim.esm', 'ccBGSSSE002-ExoticArrows.esl', 'SkyrimTogether.esp'],
    implicit: ['Skyrim.esm', 'ccBGSSSE002-ExoticArrows.esl'],
    installed: new Map([[69993, { version: '1.8.2', manager: 'STR Companion' }], [30379, { version: '2.3.1', manager: 'Manual' }]]),
    ccExtra: ['ccBGSSSE002-ExoticArrows.esl'],
  };
  const { steps, remaining } = setup.buildPlan(host, local);
  assert.deepStrictEqual(steps.map(s => s.id), ['game', 'mod-69993', 'mod-30379', 'mod-32444', 'mod-12604', 'unknown', 'cleanup', 'loadorder']);
  const by = id => steps.find(s => s.id === id);
  assert.strictEqual(by('game').status, 'blocked');
  assert.strictEqual(by('mod-69993').status, 'update', 'STR 1.8.2 vs host 1.8.3');
  assert.strictEqual(by('mod-30379').status, 'done', 'host version unknown counts as match');
  assert.strictEqual(by('mod-32444').status, 'needed');
  assert.match(by('unknown').detail, /Mystery\.esp/);
  assert.deepStrictEqual(by('cleanup').plugins, ['ccBGSSSE002-ExoticArrows.esl']);
  assert.strictEqual(by('loadorder').status, 'needed');
  assert.strictEqual(remaining, 5);

  local.installed.set(69993, { version: '1.8.2', manager: 'Vortex' });
  assert.strictEqual(setup.buildPlan(host, local).steps.find(s => s.id === 'mod-69993').status, 'vortex');
});

test('pickFile prefers the host version, then the archive name, then main files', () => {
  const { pickFile } = require('../src/core/setup');
  const files = { files: [
    { file_id: 1, name: 'Main', file_name: 'Thing-1-2-0-1700000300.7z', version: '2.0', category_name: 'MAIN', uploaded_timestamp: 300 },
    { file_id: 2, name: 'Old', file_name: 'Thing-1-1-5-1700000100.7z', version: '1.5', category_name: 'OLD_VERSION', uploaded_timestamp: 100 },
    { file_id: 3, name: 'GOG build', file_name: 'Thing GOG-1-1-5-1700000101.7z', version: '1.5', category_name: 'OLD_VERSION', uploaded_timestamp: 101 },
    { file_id: 4, name: 'Gone', file_name: 'x.7z', version: '1.5', category_name: 'ARCHIVED' },
  ] };
  assert.deepStrictEqual(pickFile(files, { version: '1.5', fileHint: 'Thing' }), { file: files.files[1], exactVersion: true });
  assert.strictEqual(pickFile(files, { version: '1.5', fileHint: 'Thing GOG' }).file.file_id, 3);
  assert.deepStrictEqual(pickFile(files, { version: '9.9' }), { file: files.files[0], exactVersion: false });
  assert.strictEqual(pickFile({ files: [] }, {}), null);
  assert.strictEqual(pickFile(files, { version: '1.5', fileHint: 'Thing GOG-1-1-5-1700000101' }).file.file_id, 3, 'a full archive name works as the hint too');
});

test('parseNxm reads Nexus mod-manager links', () => {
  const { parseNxm } = require('../src/core/setup');
  assert.deepStrictEqual(parseNxm('nxm://skyrimspecialedition/mods/12604/files/35407?key=abc&expires=1700000000&user_id=42'),
    { game: 'skyrimspecialedition', modId: 12604, fileId: 35407, key: 'abc', expires: '1700000000', userId: '42' });
  assert.strictEqual(parseNxm('https://evil.example/x'), null);
  assert.strictEqual(parseNxm('nxm://skyrimspecialedition/mods/abc/files/1'), null);
});

function writeFomodMod(dir) {
  const files = {
    'Core/Core.esp': pluginBytes(['Skyrim.esm']),
    'Options/Big/textures/big.dds': 'big',
    'Options/Small/textures/small.dds': 'small',
    'Patches/USSEP Patch.esp': pluginBytes(['Skyrim.esm']),
    'Patches/Fallback.esp': pluginBytes(['Skyrim.esm']),
    'Extras/readme.txt': 'hi',
  };
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <moduleName>Fomod Test</moduleName>
  <requiredInstallFiles><file source="Core\\Core.esp" destination="Core.esp"/></requiredInstallFiles>
  <installSteps order="Explicit">
    <installStep name="Textures">
      <optionalFileGroups order="Explicit">
        <group name="Resolution" type="SelectExactlyOne">
          <plugins order="Explicit">
            <plugin name="Small"><description/><files><folder source="options/small" destination=""/></files>
              <typeDescriptor><type name="Optional"/></typeDescriptor></plugin>
            <plugin name="Big"><description/><files><folder source="Options\\Big" destination=""/></files>
              <conditionFlags><flag name="res">big</flag></conditionFlags>
              <typeDescriptor><type name="Recommended"/></typeDescriptor></plugin>
          </plugins>
        </group>
        <group name="Extras" type="SelectAny">
          <plugins order="Explicit">
            <plugin name="Readme"><description/><files><file source="Extras/readme.txt" destination="docs/"/></files>
              <typeDescriptor><type name="Optional"/></typeDescriptor></plugin>
          </plugins>
        </group>
      </optionalFileGroups>
    </installStep>
    <installStep name="Patches">
      <visible><flagDependency flag="res" value="big"/></visible>
      <optionalFileGroups order="Explicit">
        <group name="Patch" type="SelectAny">
          <plugins order="Explicit">
            <plugin name="USSEP patch"><description/><files><file source="Patches/USSEP Patch.esp" destination="USSEP Patch.esp"/></files>
              <typeDescriptor><dependencyType><defaultType name="Optional"/><patterns><pattern>
                <dependencies operator="And"><fileDependency file="USSEP.esp" state="Active"/></dependencies><type name="Recommended"/>
              </pattern></patterns></dependencyType></typeDescriptor></plugin>
          </plugins>
        </group>
      </optionalFileGroups>
    </installStep>
  </installSteps>
  <conditionalFileInstalls><patterns>
    <pattern><dependencies operator="And"><flagDependency flag="res" value="small"/></dependencies>
      <files><file source="Patches/Fallback.esp" destination="Fallback.esp"/></files></pattern>
  </patterns></conditionalFileInstalls>
</config>`;
  fs.mkdirSync(path.join(dir, 'fomod'), { recursive: true });
  // UTF-16 LE with a BOM, like many real installers.
  fs.writeFileSync(path.join(dir, 'fomod', 'ModuleConfig.xml'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
}

test('FOMOD installers run with their recommended options', () => {
  const fomod = require('../src/core/fomod');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strc-fomod-'));
  writeFomodMod(dir);
  const r = fomod.resolve(dir, { active: ['Skyrim.esm', 'USSEP.esp'], onDisk: ['Skyrim.esm', 'USSEP.esp'] });
  const to = r.files.map(f => f.to.split(path.sep).join('/')).sort();
  assert.deepStrictEqual(to, ['Core.esp', 'USSEP Patch.esp', 'textures/big.dds']);
  assert.deepStrictEqual(r.choices.map(c => c.option), ['Big', 'USSEP patch']);
  assert.strictEqual(r.moduleName, 'Fomod Test');
  // Without USSEP active, the patch is only "Optional" and isn't picked.
  const r2 = fomod.resolve(dir, { active: ['Skyrim.esm'], onDisk: ['Skyrim.esm'] });
  assert.ok(!r2.files.some(f => /USSEP Patch/.test(f.to)));
});

test('installing a FOMOD archive puts the chosen files in Data', async () => {
  const { root, paths } = fakeGame();
  const src = path.join(root, 'fomodsrc', 'Fomod Test');
  writeFomodMod(src);
  const archive = path.join(root, 'Fomod Test-999-1-0.7z');
  assert.ok((await run(sevenZip().exe, ['a', archive, src])).ok);
  const inst = new Installer(paths, path.join(root, 'appdata'), new BackupStore(paths));
  const res = await inst.installArchive(archive, { name: 'Fomod Test', nexusId: 999, version: '1.0' });
  assert.strictEqual(res.ok, true, res.message);
  assert.ok(fs.existsSync(path.join(paths.dataDir, 'Core.esp')));
  assert.ok(fs.existsSync(path.join(paths.dataDir, 'textures', 'big.dds')));
  assert.ok(fs.existsSync(path.join(paths.dataDir, 'USSEP Patch.esp')), 'USSEP.esp is active in the fixture');
  assert.ok(!fs.existsSync(path.join(paths.dataDir, 'textures', 'small.dds')));
  assert.ok(!fs.existsSync(path.join(paths.dataDir, 'fomod')));
  assert.ok(res.choices.length >= 1);
});

// ---------- 1.4.0: Steam & Deck, router, bug report, self-update ----------

const vdf = require('../src/core/vdf');
const steamdeck = require('../src/core/steamdeck');

function fakeSteam(root) {
  const steam = path.join(root, 'Steam');
  const cfg = path.join(steam, 'userdata', '12345', 'config');
  fs.mkdirSync(cfg, { recursive: true });
  fs.mkdirSync(path.join(steam, 'userdata', '0', 'config'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'localconfig.vdf'), [
    '"UserLocalConfigStore"', '{', '\t"Software"', '\t{', '\t\t"Valve"', '\t\t{', '\t\t\t"Steam"', '\t\t\t{',
    '\t\t\t\t"apps"', '\t\t\t\t{', '\t\t\t\t\t"489830"', '\t\t\t\t\t{', '\t\t\t\t\t\t"LastPlayed"\t\t"1700000000"',
    '\t\t\t\t\t\t"LaunchOptions"\t\t"gamemoderun %command% -skipintro"', '\t\t\t\t\t}', '\t\t\t\t}', '\t\t\t}', '\t\t}', '\t}',
    '\t"friends"', '\t{', '\t\t"name"\t\t"Me \\"quoted\\""', '\t}', '}', '',
  ].join('\n'));
  return { steam, cfg };
}

test('text VDF round-trips and keeps escapes', () => {
  const { cfg } = fakeSteam(fs.mkdtempSync(path.join(os.tmpdir(), 'strc-vdf-')));
  const o = vdf.parseText(fs.readFileSync(path.join(cfg, 'localconfig.vdf'), 'utf8'));
  assert.strictEqual(o.UserLocalConfigStore.friends.name, 'Me "quoted"');
  assert.deepStrictEqual(vdf.parseText(vdf.stringifyText(o)), o);
  assert.strictEqual(vdf.child(o.UserLocalConfigStore, 'software').Valve.Steam.apps['489830'].LastPlayed, '1700000000');
});

test('binary VDF round-trips and shortcut ids match Steam', () => {
  const data = { shortcuts: { 0: { appid: -123, AppName: 'X', Exe: '"/a/b"', IsHidden: 0, tags: { 0: 'Co-op' } } } };
  assert.deepStrictEqual(vdf.parseBinary(vdf.stringifyBinary(data)), data);
  assert.strictEqual(vdf.crc32(Buffer.from('123456789')), 0xcbf43926, 'standard CRC-32 check value');
  assert.ok(vdf.shortcutAppId('"/x"', 'Y') < 0, 'top bit set, stored as int32');
});

test('launch wrapper is added in front of %command% and removed cleanly', () => {
  const w = '/home/deck/.local/share/Steam/steamapps/common/Skyrim Special Edition/strc-launch.sh';
  assert.strictEqual(steamdeck.withWrapper('', w), `"${w}" %command%`);
  assert.strictEqual(steamdeck.withWrapper('gamemoderun %command% -skipintro', w), `gamemoderun "${w}" %command% -skipintro`);
  assert.strictEqual(steamdeck.withWrapper('-skipintro', w), `"${w}" %command% -skipintro`);
  assert.strictEqual(steamdeck.withWrapper(steamdeck.withWrapper('-x', w), w), `"${w}" %command% -x`, 'idempotent');
  assert.strictEqual(steamdeck.withoutWrapper(`gamemoderun "${w}" %command% -skipintro`), 'gamemoderun %command% -skipintro');
  assert.strictEqual(steamdeck.withoutWrapper(`"${w}" %command%`), '');
});

test('launch options and Steam library entries are written for every account, with backups', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strc-steam-'));
  const { steam, cfg } = fakeSteam(root);
  const backups = path.join(root, 'bk');
  const w = '/games/Skyrim Special Edition/strc-launch.sh';
  assert.strictEqual(steamdeck.updateLaunchOptions(steam, o => steamdeck.withWrapper(o, w), backups), 1);
  assert.deepStrictEqual(steamdeck.launchOptions(steam), [{ user: '12345', options: `gamemoderun "${w}" %command% -skipintro` }]);
  assert.strictEqual(fs.readdirSync(backups).length, 1);
  assert.strictEqual(steamdeck.updateLaunchOptions(steam, o => steamdeck.withWrapper(o, w), backups), 0, 'no change, no write');
  steamdeck.updateLaunchOptions(steam, o => steamdeck.withoutWrapper(o), backups);
  assert.strictEqual(steamdeck.launchOptions(steam)[0].options, 'gamemoderun %command% -skipintro');

  const exe = '/home/deck/Applications/STR-Companion/STR-Companion.AppImage';
  assert.strictEqual(steamdeck.addShortcut(steam, { name: 'STR Companion', exe, startDir: path.dirname(exe) }, backups), 1);
  assert.strictEqual(steamdeck.addShortcut(steam, { name: 'STR Companion', exe, startDir: path.dirname(exe) }, backups), 0, 'not added twice');
  assert.ok(steamdeck.hasShortcut(steam, exe));
  const sc = vdf.parseBinary(fs.readFileSync(path.join(cfg, 'shortcuts.vdf')));
  assert.strictEqual(sc.shortcuts['0'].AppName, 'STR Companion');
  assert.strictEqual(sc.shortcuts['0'].appid, vdf.shortcutAppId(`"${exe}"`, 'STR Companion'));
});

test('the Play wrapper swaps the launcher, snapshots saves and passes through in solo mode', { skip: process.platform === 'win32' }, async () => {
  const { paths } = fakeGame({ proton: true });
  const wrapper = steamdeck.writeWrapper(paths.gameDir, { autoSnapshot: true, solo: false });
  const launcher = path.join(paths.gameDir, 'SkyrimSELauncher.exe');
  let r = await run('sh', [wrapper, 'echo', 'proton', 'waitforexitandrun', launcher]);
  assert.strictEqual(r.stdout.trim(), `proton waitforexitandrun ${path.join(paths.gameDir, 'Data/SkyrimTogetherReborn/SkyrimTogether.exe')}`);
  const snaps = new BackupStore(paths).listSaveSnapshots();
  assert.strictEqual(snaps.length, 1);
  assert.strictEqual(snaps[0].auto, true);
  assert.ok(snaps[0].files >= 1);
  steamdeck.setFlags(paths.gameDir, { solo: true });
  r = await run('sh', [wrapper, 'echo', launcher]);
  assert.strictEqual(r.stdout.trim(), launcher);
  steamdeck.removeWrapper(paths.gameDir);
  assert.ok(!fs.existsSync(wrapper));
});

test('router replies and WAN addresses are understood', () => {
  const upnp = require('../src/core/upnp');
  assert.strictEqual(upnp.parseSsdp('HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.1:5000/rootDesc.xml\r\nST: x\r\n').location, 'http://192.168.1.1:5000/rootDesc.xml');
  const xml = `<root><URLBase>http://192.168.1.1:5000</URLBase><device><deviceList><device><deviceList><device><serviceList>
    <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service>
    </serviceList></device></deviceList></device></deviceList></device></root>`;
  assert.deepStrictEqual(upnp.findControlUrl(xml, 'http://192.168.1.1:5000/rootDesc.xml'),
    { url: 'http://192.168.1.1:5000/ctl/IPConn', serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1' });
  assert.strictEqual(upnp.classifyWanIp('100.72.1.5'), 'cgnat');
  assert.strictEqual(upnp.classifyWanIp('192.168.0.2'), 'double-nat');
  assert.strictEqual(upnp.classifyWanIp('84.10.20.30'), 'public');
  assert.strictEqual(upnp.classifyWanIp(''), 'unknown');
});

test('bug reports remove passwords and include logs', async () => {
  const report = require('../src/core/report');
  const clean = report.sanitizeIni('[GameServer]\r\nsPassword=hunter2\r\nsAdminPassword=root\r\nuPort=10578\r\n');
  assert.doesNotMatch(clean, /hunter2|root/);
  assert.match(clean, /uPort=10578/);
  const { root, paths } = fakeGame();
  fs.writeFileSync(path.join(paths.strDir, 'config', 'STServer.ini'), '[GameServer]\r\nsPassword=secret123\r\n');
  const snap = health.snapshot(paths);
  const file = await report.createReport(paths, { appVersion: '1.4.0', snapshot: snap, checks: health.checks(paths, snap, null), vortexMods: [], outDir: path.join(root, 'out'), zipExe: sevenZip().exe });
  assert.ok(fs.existsSync(file));
  const list = await run(sevenZip().exe, ['l', file]);
  assert.match(list.stdout, /diagnostics\.txt/);
  assert.match(list.stdout, /STServer\.ini/);
  const x = path.join(root, 'x');
  await run(sevenZip().exe, ['x', file, `-o${x}`, '-y']);
  assert.doesNotMatch(fs.readFileSync(path.join(x, 'STServer.ini'), 'utf8'), /secret123/);
});

test('self-update picks the right file and reads checksums', () => {
  const su = require('../src/core/selfupdate');
  assert.strictEqual(su.assetFor('win32', '1.4.0', { portableExe: 'C:/x.exe' }), 'STR-Companion-1.4.0.exe');
  assert.strictEqual(su.assetFor('linux', '1.4.0', { appImage: '/a.AppImage' }), 'STR-Companion-1.4.0-linux-x86_64.AppImage');
  assert.strictEqual(su.assetFor('linux', '1.4.0', {}), null, 'tar.gz installs update through the installer');
  const h = 'a'.repeat(64);
  assert.deepStrictEqual(su.parseSums(`${h}  STR-Companion-1.4.0.exe\n${'b'.repeat(64)} *other.tar.gz\njunk\n`), { 'STR-Companion-1.4.0.exe': h, 'other.tar.gz': 'b'.repeat(64) });
  assert.match(su.windowsSwapScript('C:\\a\\new.exe', 'C:\\a\\app.exe'), /move \/y "C:\\a\\new\.exe" "C:\\a\\app\.exe"/);
});

test('save snapshots can be mirrored to an extra folder', async () => {
  const { root, paths } = fakeGame();
  const extra = path.join(root, 'usb');
  const r = await new BackupStore(paths).snapshotSaves('m', { mirrorDir: extra });
  assert.strictEqual(r.mirrored, true);
  assert.ok(fs.existsSync(path.join(extra, 'STR-Companion-saves', r.id, 'Save1.ess')));
});
