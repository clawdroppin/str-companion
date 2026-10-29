'use strict';
const fs = require('fs');
const path = require('path');
const { exists, readJson, writeJson, moveFile, timestampId, removeEmptyDirs, walkFiles, isInside, dirSize } = require('./util');
const plugins = require('./plugins');

/**
 * Moves files out of the game folder into <game>/_STRCompanion_Backup/<batch id>/ (same drive, so moves
 * are instant), keeping their relative paths and a manifest so every batch can be restored.
 */
class BackupStore {
  constructor(paths) {
    this.paths = paths;
    this.root = path.join(paths.gameDir, '_STRCompanion_Backup');
    this.manifestFile = path.join(this.root, 'manifest.json');
  }

  _load() {
    return readJson(this.manifestFile, { batches: [] });
  }

  _save(m) {
    writeJson(this.manifestFile, m);
  }

  list() {
    // Batches whose folder was removed by hand can't be restored, so don't offer them.
    return this._load().batches.filter(b => exists(b.dir || path.join(this.root, b.id))).map(b => ({
      ...b,
      size: b.files.reduce((s, f) => s + (f.size || 0), 0),
    }));
  }

  /**
   * @param relPaths paths relative to the game folder, e.g. "Data/ccbgssse002-exoticarrows.esl"
   */
  backup(relPaths, { label, category = 'manual' } = {}) {
    const id = `${timestampId()}_${Math.random().toString(36).slice(2, 6)}`;
    const batchDir = path.join(this.root, id);
    const moved = [];
    const errors = [];
    const pluginNames = relPaths
      .filter(r => /^data[\\/][^\\/]+\.(esp|esm|esl)$/i.test(r))
      .map(r => path.basename(r));
    for (const rel of relPaths) {
      const src = path.join(this.paths.gameDir, rel);
      // Never touch anything outside the game folder, or the backup folder itself.
      if (!isInside(this.paths.gameDir, src) || isInside(this.root, src) || path.resolve(src) === path.resolve(this.paths.gameDir)) {
        errors.push({ rel, error: 'Outside the game folder' });
        continue;
      }
      if (!exists(src)) continue;
      try {
        const size = fs.statSync(src).size;
        moveFile(src, path.join(batchDir, rel));
        moved.push({ rel, size });
        removeEmptyDirs(path.dirname(src), this.paths.dataDir);
      } catch (e) {
        errors.push({ rel, error: e.message });
      }
    }
    const deactivated = pluginNames.length ? plugins.removeFromLists(this.paths.localAppDir, pluginNames) : [];
    if (moved.length) {
      const m = this._load();
      m.batches.unshift({ id, label: label || `${moved.length} files`, category, createdAt: new Date().toISOString(), files: moved, deactivated });
      this._save(m);
    }
    return { id, moved: moved.length, errors };
  }

  /** Moves a batch (or some files of it) back into the game folder. Existing files are never overwritten. */
  restore(id, onlyRel = null) {
    const m = this._load();
    const batch = m.batches.find(b => b.id === id);
    if (!batch) throw new Error('Backup not found');
    const batchDir = batch.dir || path.join(this.root, id);
    const want = onlyRel ? new Set(onlyRel) : null;
    const restored = [];
    const conflicts = [];
    const missing = [];
    for (const f of batch.files) {
      if (want && !want.has(f.rel)) continue;
      const src = path.join(batchDir, f.relInBackup || f.rel);
      const dest = path.join(this.paths.gameDir, f.rel);
      if (!isInside(this.paths.gameDir, dest)) { conflicts.push(f.rel); continue; }
      if (exists(dest)) { conflicts.push(f.rel); continue; }
      // Deleted from the backup by hand: drop it from the manifest so the batch can still finish.
      if (!exists(src)) { missing.push(f.rel); continue; }
      moveFile(src, dest);
      restored.push(f.rel);
    }
    const restoredPlugins = restored.filter(r => /\.(esp|esm|esl)$/i.test(r)).map(r => path.basename(r));
    const reactivate = (batch.deactivated || []).filter(n => restoredPlugins.some(p => p.toLowerCase() === n.toLowerCase()));
    if (reactivate.length) plugins.addToPluginsTxt(this.paths.localAppDir, reactivate);

    batch.files = batch.files.filter(f => !restored.includes(f.rel) && !missing.includes(f.rel));
    if (!batch.files.length) {
      m.batches = m.batches.filter(b => b !== batch);
      if (!batch.dir) fs.rmSync(path.join(this.root, id), { recursive: true, force: true });
    }
    this._save(m);
    return { restored: restored.length, conflicts, missing: missing.length };
  }

  /** Permanently deletes a batch the user no longer wants (they confirm this in the UI). */
  deleteBatch(id) {
    const m = this._load();
    const batch = m.batches.find(b => b.id === id);
    if (!batch) throw new Error('Backup not found');
    const dir = batch.dir || path.join(this.root, id);
    // Adopted folders live outside our backup folder; only delete inside the game folder either way.
    if (isInside(this.paths.gameDir, dir) && path.resolve(dir) !== path.resolve(this.paths.gameDir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    m.batches = m.batches.filter(b => b !== batch);
    this._save(m);
    return { deleted: batch.files.length };
  }

  /** Space used by batches, save snapshots and config history. */
  usage() {
    const batches = this.list().reduce((s, b) => s + b.size, 0);
    const saves = this.listSaveSnapshots().reduce((s, x) => s + (x.size || 0), 0);
    const configs = dirSize(path.join(this.root, 'config-history'));
    return { batches, saves, configs, total: batches + saves + configs };
  }

  /**
   * Adopts a backup folder made by hand (e.g. "_CoopBackup_2026-10-15/CreationClub" with files directly
   * inside) so it shows up and can be restored. Files are assumed to belong in Data/.
   */
  adoptFolder(dir, { label, category = 'imported', targetPrefix = 'Data' } = {}) {
    const m = this._load();
    if (m.batches.some(b => b.dir && path.resolve(b.dir) === path.resolve(dir))) return null;
    const files = walkFiles(dir).map(rel => ({
      rel: path.join(targetPrefix, rel),
      relInBackup: rel,
      size: fs.statSync(path.join(dir, rel)).size,
    }));
    if (!files.length) return null;
    const id = `${timestampId()}_import`;
    m.batches.push({ id, label: label || path.basename(dir), category, createdAt: fs.statSync(dir).mtime.toISOString(), files, deactivated: [], dir });
    this._save(m);
    return id;
  }

  /**
   * Copies the whole Saves folder (never moves it). Async so a big Saves folder doesn't freeze the app.
   * `auto` snapshots (taken before each launch) are pruned to the newest `keepAuto`; manual ones are kept.
   */
  async snapshotSaves(note = '', { auto = false, keepAuto = 10, mirrorDir = null } = {}) {
    const files = walkFiles(this.paths.saves);
    if (!files.length) throw new Error('No saves found yet.');
    const id = `${timestampId()}_${Math.random().toString(36).slice(2, 6)}`;
    const dir = path.join(this.root, 'saves', id);
    let size = 0;
    for (const rel of files) {
      const dest = path.join(dir, rel);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(path.join(this.paths.saves, rel), dest);
      size += (await fs.promises.stat(dest)).size;
    }
    writeJson(path.join(dir, 'snapshot.json'), { note, auto, createdAt: new Date().toISOString(), files: files.length, size });
    const pruned = auto ? this.pruneAutoSnapshots(keepAuto) : 0;
    // A second copy somewhere else (SD card, USB stick, synced cloud folder). Failing here never
    // loses the main snapshot, so it's reported rather than thrown.
    let mirrored = null;
    if (mirrorDir) {
      try {
        await fs.promises.cp(dir, path.join(mirrorDir, 'STR-Companion-saves', id), { recursive: true });
        mirrored = true;
      } catch (e) {
        mirrored = e.message;
      }
    }
    return { id, files: files.length, size, pruned, mirrored };
  }

  listSaveSnapshots() {
    const dir = path.join(this.root, 'saves');
    if (!exists(dir)) return [];
    return fs.readdirSync(dir)
      .map(id => ({ id, ...(readJson(path.join(dir, id, 'snapshot.json'), {})) }))
      .filter(s => s.createdAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Keeps the newest `keep` automatic snapshots. Manual snapshots are never pruned. */
  pruneAutoSnapshots(keep) {
    const old = this.listSaveSnapshots().filter(s => s.auto).slice(Math.max(0, keep));
    for (const s of old) this.deleteSaveSnapshot(s.id);
    return old.length;
  }

  deleteSaveSnapshot(id) {
    const dir = path.join(this.root, 'saves', id);
    if (!/^[\w-]+$/.test(id) || !exists(path.join(dir, 'snapshot.json'))) throw new Error('Snapshot not found');
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** Copies a snapshot back over the Saves folder, after snapshotting the current saves first. */
  async restoreSaveSnapshot(id) {
    const dir = path.join(this.root, 'saves', id);
    if (!/^[\w-]+$/.test(id) || !exists(path.join(dir, 'snapshot.json'))) throw new Error('Snapshot not found');
    let safety = null;
    try { safety = (await this.snapshotSaves(`Automatic, before restoring a snapshot`)).id; } catch { /* no current saves */ }
    let restored = 0;
    for (const rel of walkFiles(dir).filter(r => r !== 'snapshot.json')) {
      const dest = path.join(this.paths.saves, rel);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(path.join(dir, rel), dest);
      restored++;
    }
    return { restored, safety };
  }

  /** Copies config files (not moves) before the app edits them. */
  snapshotConfig(file) {
    if (!exists(file)) return null;
    // Same-second saves of different files share a folder; same file gets a suffix rather than overwriting.
    let dest = path.join(this.root, 'config-history', timestampId(), path.basename(file));
    for (let i = 2; exists(dest); i++) dest = path.join(path.dirname(dest), `${path.basename(file)}.${i}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    return dest;
  }
}

module.exports = { BackupStore };
