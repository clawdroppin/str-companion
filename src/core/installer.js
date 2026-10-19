'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exists, readJson, writeJson, run, walkFiles, listDir, which, isInside, resolveCIStrict } = require('./util');
const fomod = require('./fomod');
const plugins = require('./plugins');

const DATA_DIRS = new Set(['meshes', 'textures', 'scripts', 'interface', 'sound', 'music', 'seq', 'skse', 'strings',
  'shadersfx', 'grass', 'lodsettings', 'video', 'source', 'skyrimtogetherreborn', 'skyrimtogetherrebornbehaviors',
  'dialogueviews', 'facegen', 'calientetools', 'netscriptframework', 'platform', 'bashtags', 'docs']);
const DATA_EXT = /\.(esp|esm|esl|bsa|ini|modgroups)$/i;
const ARCHIVE_EXT = /\.(7z|zip|rar)$/i;

/** Full 7-Zip if installed (it can open .rar); otherwise the bundled 7za, which handles .7z and .zip. */
function sevenZip() {
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      const full = path.join(base, '7-Zip', '7z.exe');
      if (exists(full)) return { exe: full, rar: true };
    }
  } else {
    // 7zz is the official 7-Zip for Linux; 7z is p7zip, which reads .rar when its rar plugin is installed.
    const full = which('7zz') || which('7z');
    if (full) return { exe: full, rar: true };
  }
  const bundled = require('7zip-bin').path7za.replace('app.asar', 'app.asar.unpacked');
  return { exe: process.platform === 'win32' ? bundled : executableCopy(bundled), rar: false };
}

/**
 * npm installs and packaging can drop the executable bit on Linux, and inside an AppImage the file is on
 * a read-only mount where chmod fails. Fix it in place when possible, otherwise run a temp copy.
 */
function executableCopy(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
  try { fs.chmodSync(file, 0o755); fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
  const copy = path.join(os.tmpdir(), `strc-${path.basename(file)}-${fs.statSync(file).size}`);
  if (!exists(copy)) fs.copyFileSync(file, copy);
  fs.chmodSync(copy, 0o755);
  return copy;
}

async function extract(archive, destDir) {
  const zip = sevenZip();
  if (/\.rar$/i.test(archive) && !zip.rar) {
    throw new Error(process.platform === 'win32' ? 'Opening .rar files needs 7-Zip (free, 7-zip.org). Install it, or install this mod with Vortex.' : 'Opening .rar files needs 7-Zip: install the 7zip package (7zz) or p7zip with its rar plugin.');
  }
  fs.mkdirSync(destDir, { recursive: true });
  const r = await run(zip.exe, ['x', archive, `-o${destDir}`, '-y', '-bso0', '-bsp0']);
  if (!r.ok) throw new Error(`Could not extract ${path.basename(archive)}: ${r.stderr.trim() || 'unknown error'}`);
}

/**
 * Decides where an extracted mod goes.
 * Returns { root: folder to copy from, target: 'game' | 'data', fomod: bool }.
 */
function analyze(dir) {
  let root = dir;
  // Many archives wrap everything in one folder named after the mod.
  for (;;) {
    const entries = listDir(root);
    if (entries.length === 1 && entries[0].isDirectory() && !DATA_DIRS.has(entries[0].name.toLowerCase()) && entries[0].name.toLowerCase() !== 'data') {
      root = path.join(root, entries[0].name);
    } else break;
  }
  const entries = listDir(root);
  const names = entries.map(e => e.name.toLowerCase());
  if (names.includes('fomod') && exists(resolveCIStrict(root, 'fomod', 'ModuleConfig.xml'))) {
    return { root, target: 'data', fomod: true };
  }
  if (names.includes('data')) return { root, target: 'game', fomod: false };
  const hasDataStuff = entries.some(e => (e.isDirectory() && DATA_DIRS.has(e.name.toLowerCase())) || (e.isFile() && DATA_EXT.test(e.name)));
  const hasRootStuff = entries.some(e => e.isFile() && /\.(exe|dll)$/i.test(e.name));
  if (hasRootStuff && !hasDataStuff) return { root, target: 'game', fomod: false };
  if (hasDataStuff) return { root, target: 'data', fomod: false };
  return { root, target: null, fomod: false };
}

class Installer {
  constructor(paths, appDataDir, backups) {
    this.paths = paths;
    this.registryFile = path.join(appDataDir, 'installed.json');
    this.backups = backups;
  }

  registry() {
    return readJson(this.registryFile, {});
  }

  /**
   * Installs a .7z/.zip/.rar. Files the mod would overwrite are moved to a backup batch first.
   * @param meta {name, nexusId, version}
   */
  async installArchive(archive, meta = {}) {
    if (!ARCHIVE_EXT.test(archive)) throw new Error('Pick a .7z, .zip or .rar file.');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strc-'));
    try {
      await extract(archive, tmp);
      const a = analyze(tmp);
      if (!a.target) {
        return { ok: false, reason: 'unknown-layout', message: "Couldn't tell where this mod's files go. Install it with Vortex instead." };
      }
      let files;
      let choices = null;
      if (a.fomod) {
        // Run the mod's own installer with its recommended options.
        let r;
        try {
          const lo = plugins.effectiveLoadOrder(this.paths.gameDir, this.paths.localAppDir);
          r = fomod.resolve(a.root, { active: lo.order.map(p => p.name), onDisk: [...lo.order.map(p => p.name), ...lo.inactive] });
        } catch (e) {
          return { ok: false, reason: 'fomod', message: `This mod's installer couldn't be read (${e.message}). Install it with Vortex instead.` };
        }
        if (!r.files.length) return { ok: false, reason: 'fomod', message: "This mod's installer didn't select any files with its default options. Install it with Vortex so you can pick them." };
        files = r.files.map(f => ({ from: f.from, rel: path.join('Data', f.to) }));
        choices = r.choices;
      } else {
        const prefix = a.target === 'data' ? 'Data' : '';
        files = walkFiles(a.root)
          // Skip installer metadata, and SKSE's bundled source code which the game never uses.
          .filter(f => !/^fomod[\\/]/i.test(f) && !(a.target === 'game' && /^src[\\/]/i.test(f)))
          .map(f => ({ from: path.join(a.root, f), rel: path.join(prefix, f) }));
      }
      // An archive with "../" entries must not write outside the game folder.
      files = files.filter(f => isInside(this.paths.gameDir, path.join(this.paths.gameDir, f.rel)));

      const key = meta.nexusId ? `nexus-${meta.nexusId}` : `local-${path.basename(archive).replace(ARCHIVE_EXT, '')}`;
      const reg = this.registry();
      const previous = reg[key];
      const ownFiles = new Set((previous ? previous.files : []).map(f => f.toLowerCase()));
      const newRels = new Set(files.map(f => f.rel.toLowerCase()));

      // Updating a mod this app installed: its own old files are simply replaced, and files the new
      // version dropped are moved to backup. Only files from *other* mods get backed up before overwriting.
      if (previous) {
        const dropped = previous.files.filter(r => !newRels.has(r.toLowerCase()));
        if (dropped.length) this.backups.backup(dropped, { label: `Removed by ${previous.name} update`, category: 'overwritten' });
      }
      const overwritten = files.map(f => f.rel).filter(r => !ownFiles.has(r.toLowerCase()) && exists(path.join(this.paths.gameDir, r)));
      const replacedBackups = previous ? [...(previous.replacedBackups || [])] : [];
      if (overwritten.length) {
        replacedBackups.push(this.backups.backup(overwritten, { label: `Replaced by ${meta.name || path.basename(archive)}`, category: 'overwritten' }).id);
      }
      // Async copies: texture packs can be gigabytes, and sync copies would freeze the app window.
      for (const f of files) {
        const dest = path.join(this.paths.gameDir, f.rel);
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.copyFile(f.from, dest);
      }
      const newPlugins = files.map(f => f.rel).filter(r => /^data[\\/][^\\/]+\.(esp|esm|esl)$/i.test(r)).map(r => path.basename(r));
      if (newPlugins.length) plugins.addToPluginsTxt(this.paths.localAppDir, newPlugins);

      reg[key] = {
        name: meta.name || path.basename(archive).replace(ARCHIVE_EXT, ''),
        nexusId: meta.nexusId || null,
        version: meta.version || null,
        fileName: path.basename(archive),
        installedAt: new Date().toISOString(),
        files: files.map(f => f.rel),
        plugins: newPlugins,
        replacedBackups,
      };
      writeJson(this.registryFile, reg);
      return { ok: true, key, files: files.length, plugins: newPlugins, replaced: overwritten.length, target: a.target, choices };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** "Uninstall" = move the mod's files into a backup batch, so it can be restored. */
  uninstall(key) {
    const reg = this.registry();
    const entry = reg[key];
    if (!entry) throw new Error('Not installed by STR Companion');
    const r = this.backups.backup(entry.files, { label: `Uninstalled ${entry.name}`, category: 'uninstalled' });
    // Put back whatever the mod had replaced when it was installed.
    let originalsRestored = 0;
    const live = new Set(this.backups.list().map(b => b.id));
    for (const id of entry.replacedBackups || []) {
      if (live.has(id)) originalsRestored += this.backups.restore(id).restored;
    }
    delete reg[key];
    writeJson(this.registryFile, reg);
    return { ...r, originalsRestored };
  }
}

module.exports = { Installer, analyze, extract, sevenZip, executableCopy, ARCHIVE_EXT };
