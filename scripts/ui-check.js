'use strict';
/**
 * Runs the app's screenshot mode (STRC_SHOTS) in several user scenarios and fails on any broken page,
 * broken tab or hidden programming error. Uses fake game folders; never touches a real install unless
 * --real is passed (then it only reads it, with a throwaway app profile).
 *
 *   node scripts/ui-check.js                 fixture scenarios
 *   node scripts/ui-check.js --real "<dir>"  also the real game (local use)
 *   xvfb-run -a node scripts/ui-check.js     on Linux CI
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const electron = require('electron');
const { fakeGame, addCrashLog } = require('../test/fixtures');
const share = require('../src/core/share');

const root = path.resolve(__dirname, '..');
const started = Date.now() - 1000;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'strc-uicheck-'));
const linux = process.platform === 'linux';

/** A host whose setup differs from the fixture: one extra mod and a different order. */
function hostCode(gameDir) {
  return share.makeCode({
    playerName: 'Test host', gameVersion: '1.6.1170', strVersion: '1.8.3', skseVersion: '2.2.6', addressLibrary: true,
    plugins: ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm', 'ccBGSSSE001-Fish.esm',
      'ccQDRSSE001-SurvivalMode.esl', 'ccBGSSSE037-Curios.esl', 'ccBGSSSE025-AdvDSGS.esm', '_ResourcePack.esl',
      'SkyrimTogether.esp', 'SkyrimTogetherQuestPatches.esp', 'USSEP.esp', 'SkyUI_SE.esp'],
    sksePlugins: [], nexusIds: { 'SkyUI_SE.esp': 12604, 'USSEP.esp': 266 },
    mods: [{ nexusId: 69993, version: '1.8.3', name: 'Skyrim Together Reborn' }, { nexusId: 12604, version: '5.2SE', name: 'SkyUI' }],
  });
}

function scenarios() {
  const list = [];
  const mk = name => {
    const { paths } = fakeGame({ root: path.join(work, name), proton: linux });
    // On Windows the app reads the real Documents folder, so a fixture crash log only shows on Linux.
    addCrashLog(paths);
    return paths.gameDir;
  };
  list.push({ name: 'fresh, no Nexus key', env: { STRC_GAME_DIR: mk('fresh') } });
  const free = mk('free');
  list.push({ name: 'free Nexus account', env: { STRC_GAME_DIR: free, STRC_NEXUS_MOCK: 'free' } });
  const prem = mk('premium');
  list.push({ name: 'Premium account, different host', env: { STRC_GAME_DIR: prem, STRC_NEXUS_MOCK: 'premium', STRC_COMPARE_CODE: hostCode(prem) } });
  const i = process.argv.indexOf('--real');
  if (i > 0 && process.argv[i + 1]) {
    list.push({ name: 'real game, no key', env: { STRC_GAME_DIR: process.argv[i + 1] } });
    list.push({ name: 'real game, free account', env: { STRC_GAME_DIR: process.argv[i + 1], STRC_NEXUS_MOCK: 'free' } });
  }
  return list;
}

function runApp(env, shots) {
  return new Promise(resolve => {
    const args = ['.', ...(linux ? ['--no-sandbox'] : [])];
    const child = spawn(electron, args, { cwd: root, env: { ...process.env, ...env, STRC_SHOTS: shots }, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), 150000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
}

(async () => {
  let failed = 0;
  for (const sc of scenarios()) {
    const shots = path.join(work, `shots-${sc.name.replace(/\W+/g, '-')}`);
    await runApp(sc.env, shots);
    let report = null;
    try { report = JSON.parse(fs.readFileSync(path.join(shots, 'report.json'), 'utf8')); } catch {}
    const problems = [];
    if (!report) problems.push('the app produced no report (crashed or hung)');
    else {
      for (const [step, r] of Object.entries(report)) {
        if (step === '__errors') continue;
        if (!r.h1) problems.push(`${step}: page didn't render`);
        if (r.error) problems.push(`${step}: ${r.error}`);
      }
      for (const e of report.__errors || []) problems.push(`hidden error: ${e}`);
      if (Object.keys(report).length < 13) problems.push(`only ${Object.keys(report).length - 1} steps ran`);
    }
    console.log(`${problems.length ? '✖' : '✔'} ${sc.name}${report ? ` (${Object.keys(report).length - 1} steps)` : ''}`);
    for (const p of problems) console.log(`    ${p}`);
    if (problems.length) failed++;
    if (process.env.STRC_KEEP_SHOTS) console.log(`    screenshots: ${shots}`);
  }
  // Clean up: our work folder and the throwaway app profiles the runs created.
  if (!process.env.STRC_KEEP_SHOTS) fs.rmSync(work, { recursive: true, force: true });
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!/^strc-shots-profile-/.test(name)) continue;
    const full = path.join(os.tmpdir(), name);
    try { if (fs.statSync(full).birthtimeMs >= started) fs.rmSync(full, { recursive: true, force: true }); } catch {}
  }
  process.exit(failed ? 1 : 0);
})();
