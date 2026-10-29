'use strict';
/* global api */

// ---------- tiny helpers ----------
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = b => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b >= 1e3 ? Math.round(b / 1e3) + ' KB' : b + ' B';
const fmtDate = d => d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
const main = () => $('#main');

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 4000);
}

async function call(channel, ...args) {
  try {
    return await api.call(channel, ...args);
  } catch (e) {
    if (e.message === 'NO_GAME') { state.valid = false; render(); throw e; }
    toast(e.message, 'err');
    throw e;
  }
}

// Whatever should happen when the open modal is dismissed (Cancel, Esc, or a click outside it).
let modalOnDismiss = null;

function closeModal() {
  $('#modal').classList.add('hidden');
  const f = modalOnDismiss;
  modalOnDismiss = null;
  if (f) f();
}

/** Opens a modal. `onDismiss` runs if it's closed without the dialog handling it itself. */
function modal(html, onMount, onDismiss = null) {
  // Opening a new modal dismisses the previous one, so its caller isn't left waiting forever.
  if (modalOnDismiss) { const f = modalOnDismiss; modalOnDismiss = null; f(); }
  $('#modalCard').innerHTML = html;
  $('#modal').classList.remove('hidden');
  modalOnDismiss = onDismiss;
  const close = () => { modalOnDismiss = null; $('#modal').classList.add('hidden'); };
  $('#modalCard').querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  if (onMount) onMount($('#modalCard'), close);
  return close;
}

function confirmBox(title, body, okLabel = 'Continue') {
  return new Promise(resolve => {
    modal(`<h2>${esc(title)}</h2><div class="sub">${body}</div>
      <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="okBtn">${esc(okLabel)}</button></div>`,
    (card, close) => {
      card.querySelector('#okBtn').addEventListener('click', () => { close(); resolve(true); });
      card.querySelector('#okBtn').focus();
    }, () => resolve(false));
  });
}

function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> ${esc(label || 'Working…')}`; }
  else { btn.disabled = false; btn.innerHTML = btn.dataset.label || btn.innerHTML; }
}

function head(title, desc, actions = '') {
  return `<div class="page-head"><div><h1>${esc(title)}</h1>${desc ? `<p>${desc}</p>` : ''}</div><div class="row">${actions}</div></div>`;
}

function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard', 'ok'));
}

// ---------- state & routing ----------
const state = { page: 'dashboard', valid: false, gameDir: null, hasNexusKey: false, platform: 'win32', protonLauncher: null, timers: [] };
const isLinux = () => state.platform === 'linux';

function clearTimers() {
  state.timers.forEach(t => clearInterval(t));
  state.timers = [];
}

function go(page) {
  state.page = page;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  render();
}

document.querySelectorAll('#nav button').forEach(b => b.addEventListener('click', () => go(b.dataset.page)));

// Renders run one at a time, so a slow page that finishes late can't overwrite the page the user moved to.
let renderChain = Promise.resolve();
let renderQueued = false;
function render() {
  if (renderQueued) return renderChain;
  renderQueued = true;
  renderChain = renderChain.then(() => { renderQueued = false; return renderNow(); });
  return renderChain;
}

async function renderNow() {
  clearTimers();
  updateFoot();
  if (!state.valid) return renderWelcome();
  const pages = { dashboard, setup: setupPage, play, deck, mods, cleanup, config, friends, session, backups, logs, settings };
  main().innerHTML = `<div class="empty"><span class="spinner"></span> Loading…</div>`;
  try {
    await pages[state.page]();
  } catch (e) {
    if (e.message !== 'NO_GAME') main().innerHTML = `<div class="empty render-error">Something went wrong: ${esc(e.message)}</div>`;
  }
}

function updateFoot() {
  const upd = state.update && state.update.hasUpdate
    ? `<a id="getUpdate" class="update-link">⬆ Version ${esc(state.update.latest)} is available</a><br><br>` : '';
  $('#gameDirFoot').innerHTML = upd + (state.gameDir ? `Game folder:<br>${esc(state.gameDir)}<br><a id="openGameDir">Open folder</a>` : '');
  const a = $('#openGameDir');
  if (a) a.addEventListener('click', () => call('shell:openGameDir'));
  const u = $('#getUpdate');
  if (u) u.addEventListener('click', () => selfUpdate());
}

/** Updates the app in place (portable exe / AppImage) or opens the release page for other builds. */
async function selfUpdate() {
  const up = state.update;
  if (!up) return;
  if (!up.canSelfUpdate) return call('shell:external', up.url);
  if (!await confirmBox(`Update to ${up.latest}?`, 'STR Companion downloads the new version, checks it against the release checksum, and restarts. Your settings and backups stay.', 'Update now')) return;
  const close = modal('<h2>Updating…</h2><div class="sub"><span class="spinner"></span> Downloading and verifying the new version. The app restarts by itself.</div><div class="progress"><div id="selfProg"></div></div>');
  try { await api.call('app:selfUpdate'); } catch (e) { close(); toast(e.message, 'err'); }
}

function renderWelcome() {
  main().innerHTML = `<div class="welcome">
    <div class="brand-mark"><svg viewBox="0 0 32 32"><path d="M16 2 4 8v8c0 7 5 12 12 14 7-2 12-7 12-14V8L16 2Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 15h12M16 9v14" stroke="currentColor" stroke-width="2"/></svg></div>
    <h1>Welcome to STR Companion</h1>
    <p>Point the app at your Skyrim Special Edition folder — the one with <b>SkyrimSE.exe</b> in it. It's usually<br><span class="mono">${isLinux() ? '~/.local/share/Steam/steamapps/common/Skyrim Special Edition' : '…\\steamapps\\common\\Skyrim Special Edition'}</span></p>
    <p><button class="btn primary big" id="pick">Choose Skyrim folder</button></p>
  </div>`;
  $('#pick').addEventListener('click', async () => {
    const dir = await call('game:pickDir');
    if (dir) { state.gameDir = dir; state.valid = true; go('dashboard'); }
  });
}

// ---------- Dashboard ----------
async function dashboard() {
  const { snapshot: s, checks } = await call('health:get');
  const problems = checks.filter(c => c.level === 'error').length;
  const warnings = checks.filter(c => c.level === 'warn').length;
  const verdict = problems ? ['bad', `${problems} problem${problems > 1 ? 's' : ''}`, 'Fix these before playing']
    : warnings ? ['meh', 'Playable', `${warnings} thing${warnings > 1 ? 's' : ''} worth fixing`]
      : ['good', 'Ready to play', 'Everything checks out'];
  main().innerHTML = head('Dashboard', 'A health check of your Skyrim Together setup. Anything with a button can be fixed in one click — every change is backed up.',
    `<button class="btn" id="rescan">↻ Re-scan</button><button class="btn primary" id="toPlay">▶ Play</button>`) + `
    ${!s.str.installed ? '<div class="callout" style="margin-bottom:14px"><b>New here?</b> Paste your host&#39;s setup code in <a href="#" id="toSetup">Quick Setup</a> and the app installs and matches everything for you.</div>' : ''}
    <div class="grid stats">
      <div class="stat ${verdict[0]}"><div class="k">Status</div><div class="v">${verdict[1]}</div><div class="d">${verdict[2]}</div></div>
      <div class="stat"><div class="k">Skyrim</div><div class="v">${esc(s.gameVersion || '?')}</div><div class="d">${s.autoUpdate ? esc(s.autoUpdate.label) : ''}</div></div>
      <div class="stat ${s.str.installed ? '' : 'bad'}"><div class="k">Skyrim Together</div><div class="v">${s.str.installed ? esc(s.str.version || 'Installed') : 'Missing'}</div><div class="d">${s.manager ? 'Managed by ' + esc(s.manager) : ''}</div></div>
      <div class="stat"><div class="k">Plugins loaded</div><div class="v">${s.pluginCount}</div><div class="d">${s.ccRemovable ? s.ccRemovable + (s.ccRemovable === 1 ? ' Anniversary add-on' : ' Anniversary add-ons') : 'No extra AE content'}</div></div>
    </div>
    <div class="checks">${checks.map((c, i) => `
      <div class="check ${c.level}">
        <div class="dot">${{ ok: '✓', warn: '!', error: '✕', info: 'i' }[c.level]}</div>
        <div><div class="t">${esc(c.title)}</div>${c.detail ? `<div class="d">${esc(c.detail)}</div>` : ''}</div>
        <div>${c.fix ? `<button class="btn small ${c.level === 'error' ? 'primary' : ''}" data-fix="${i}">${esc(c.fix.label)}</button>` : ''}</div>
      </div>`).join('')}
    </div>`;
  $('#rescan').addEventListener('click', () => render());
  $('#toPlay').addEventListener('click', () => go('play'));
  if ($('#toSetup')) $('#toSetup').addEventListener('click', e => { e.preventDefault(); go('setup'); });
  main().querySelectorAll('[data-fix]').forEach(b => b.addEventListener('click', async () => {
    const fix = checks[Number(b.dataset.fix)].fix;
    if (fix.action === 'goto') {
      if (fix.page === 'logs' && fix.tab) logTab = fix.tab;
      return go(fix.page);
    }
    if (fix.action === 'backupCC') {
      const ok = await confirmBox('Move Anniversary Edition content to backup?', `The ${s.ccRemovable} paid/AE add-ons will be moved to the backup folder. The 4 free files USSEP needs stay. You can restore them any time from Backups.`, 'Move to backup');
      if (!ok) return;
    }
    busy(b, true);
    try {
      const r = await call('fix:run', fix);
      const msg = r && r.moved !== undefined ? `Moved ${r.moved} files to backup`
        : r && r.restored !== undefined ? `Restored ${r.restored} files`
          : fix.action === 'activatePlugins' ? `Switched on ${fix.names.join(' and ')}` : 'Done';
      toast(msg, 'ok');
      render();
    } catch { busy(b, false); }
  }));
}

// ---------- Quick Setup ----------
// Live progress from the main process, kept here so it survives page switches while setup runs.
const setupProgress = {};
let setupRunning = false;

api.on('setup:progress', ev => {
  if (ev.state === 'finished') {
    setupRunning = false;
    const s = ev.summary;
    toast(ev.inSync ? '✓ Setup finished — you match the host' : `Setup finished: ${s.installed.length} installed${s.failed.length ? `, ${s.failed.length} failed` : ''}`, ev.inSync ? 'ok' : '');
    if (state.page === 'setup') render();
    return;
  }
  setupProgress[ev.stepId] = ev;
  paintStep(ev.stepId);
});

const STEP_ICON = { done: '✓', needed: '●', update: '↑', vortex: 'V', blocked: '✕' };
const STEP_LEVEL = { done: 'ok', needed: 'info', update: 'warn', vortex: 'warn', blocked: 'error' };

function paintStep(id) {
  const el = document.querySelector(`[data-step="${CSS.escape(String(id))}"] .live`);
  const ev = setupProgress[id];
  if (!el || !ev) return;
  const icon = { working: '<span class="spinner"></span>', waiting: '⏳', done: '✓', failed: '✕' }[ev.state] || '';
  el.innerHTML = `<div class="sub" style="color:${ev.state === 'failed' ? 'var(--err)' : ev.state === 'done' ? 'var(--ok)' : 'var(--gold-2)'}">${icon} ${esc(ev.text || '')}
    ${ev.state === 'waiting' && ev.url ? ' <a href="#" class="reopen">Open the page again</a>' : ''}</div>
    ${typeof ev.p === 'number' ? `<div class="progress"><div style="width:${Math.round(ev.p * 100)}%"></div></div>` : ''}`;
  const a = el.querySelector('.reopen');
  if (a) a.addEventListener('click', e => { e.preventDefault(); call('shell:external', ev.url); });
}

async function setupPage() {
  const code = state.prefillSetupCode || '';
  state.prefillSetupCode = null;
  let d;
  // A bad code shows an error toast; fall back to the last good code so the page still works.
  try { d = await call('setup:plan', code); } catch { d = await call('setup:plan', ''); }
  setupRunning = setupRunning || d.running;
  const p = d.plan;
  const keyCard = !d.hasNexusKey ? `
      <div class="sub">The app uses your <b>personal Nexus API key</b> to find the exact files your host has. It's free and takes a minute:</div>
      <ol class="sub" style="margin:8px 0 10px 18px;padding:0">
        <li>Click <b>Open my API key page</b> and log in to Nexus Mods (free account is fine).</li>
        <li>Scroll to <b>Personal API Key</b>, copy it, and paste it here.</li>
      </ol>
      <div class="row"><button class="btn" id="getKey">Open my API key page</button>
        <input type="password" id="apikey" placeholder="Paste your Nexus API key" style="flex:1;min-width:220px" autocomplete="off">
        <button class="btn primary" id="saveKey">Save key</button></div>`
    : d.premium ? '<div class="callout blue">✓ <b>Premium account</b> — every mod downloads and installs automatically.</div>'
      : `<div class="sub">✓ Connected (free account). Nexus only lets Premium accounts download automatically, so free accounts click <b>"Slow download"</b> once per mod — the app does everything else.</div>
        <label class="row" style="cursor:pointer;margin-top:10px"><span class="switch"><input type="checkbox" id="nxmToggle" ${d.nxm.registered ? 'checked' : ''}><span></span></span>
          <span><b>Let STR Companion handle "Mod Manager Download" links</b><br><span class="sub">Each click on Nexus then installs the right file straight away.${d.nxm.owner ? ` Right now <b>${esc(d.nxm.owner)}</b> handles them — turning this on takes them over; ${esc(d.nxm.owner)} can take them back from its own settings.` : ''}</span></span></label>
        ${!d.nxm.registered ? '<div class="sub" style="margin-top:6px">Off: you click <b>Manual download</b> instead, and the app picks the file up from your Downloads folder.</div>' : ''}`;

  const stepsHtml = p ? p.steps.map(s => `
      <div class="check ${STEP_LEVEL[s.status] || 'info'}" data-step="${esc(s.id)}">
        <div class="dot">${STEP_ICON[s.status] || '•'}</div>
        <div><div class="t">${esc(s.title)}</div><div class="d">${esc(s.detail)}</div><div class="live"></div></div>
        <div>${s.kind === 'mod' && s.mod ? `<button class="btn small ghost" data-nexus="${Number(s.mod.nexusId)}">Nexus page</button>` : ''}</div>
      </div>`).join('') : '';
  const todo = p ? p.steps.filter(s => ['needed', 'update'].includes(s.status)) : [];
  const vortexSteps = p ? p.steps.filter(s => s.status === 'vortex') : [];

  main().innerHTML = head('Quick Setup', 'Paste your host\'s setup code and the app makes this PC match it: the same mods in the same versions, Anniversary content sorted, and the same load order.') + `
    <div class="card">
      <h2>1. Your host's setup code</h2>
      <div class="sub">Ask your host to copy it from <b>Friends Sync</b> (or the Copy invite message).</div>
      <textarea id="setupCode" rows="3" placeholder="STR2-…" style="margin-top:10px">${esc(d.code || '')}</textarea>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="check">${p ? 'Check again' : 'Check'}</button>
        ${d.host ? `<span class="sub">Host: <b>${esc(d.host.playerName || 'unnamed')}</b> · Skyrim ${esc(d.host.gameVersion)} · Skyrim Together ${esc(d.host.strVersion || '?')} · ${d.host.mods} mods · ${d.host.plugins} plugins</span>` : ''}</div>
    </div>
    <div class="card"><h2>2. Your Nexus Mods account</h2>${keyCard}</div>
    ${p ? `<div class="card">
      <div class="card-head"><div><h2>3. Set up</h2><div class="sub">${todo.length ? `${todo.length} thing${todo.length > 1 ? 's' : ''} to do.` : 'Everything already matches the host.'} Files that get replaced are backed up first, and nothing is deleted.</div></div>
        <div class="row">${setupRunning ? '<button class="btn danger" id="cancelSetup">Cancel</button>' : `<button class="btn primary big" id="runSetup" ${!d.hasNexusKey || !todo.length ? 'disabled' : ''}>Set up everything</button>`}</div></div>
      <label class="row sub" style="cursor:pointer;margin-bottom:12px"><span class="switch"><input type="checkbox" id="presetToo" checked><span></span></span>Also apply the co-op game settings (borderless window, dialogue subtitles)</label>
      ${vortexSteps.length ? `<div class="callout" style="margin-bottom:12px">${vortexSteps.length} mod${vortexSteps.length > 1 ? 's are' : ' is'} managed by Vortex at a different version — update ${vortexSteps.length > 1 ? 'them' : 'it'} in Vortex so the app doesn't install a second copy.</div>` : ''}
      <div class="checks">${stepsHtml}</div>
    </div>` : ''}`;

  Object.keys(setupProgress).forEach(paintStep);
  $('#check').addEventListener('click', async e => {
    busy(e.currentTarget, true, 'Checking…');
    try { state.prefillSetupCode = $('#setupCode').value.trim(); render(); } catch { busy(e.currentTarget, false); }
  });
  if ($('#getKey')) $('#getKey').addEventListener('click', () => call('nexus:openKeyPage'));
  if ($('#saveKey')) $('#saveKey').addEventListener('click', async e => {
    busy(e.currentTarget, true, 'Checking…');
    try {
      const r = await call('nexus:setKey', $('#apikey').value);
      toast(`Connected as ${r.name}${r.premium ? ' (Premium)' : ''}`, 'ok');
      render();
    } catch { busy(e.currentTarget, false); }
  });
  if ($('#nxmToggle')) $('#nxmToggle').addEventListener('change', async e => {
    try {
      const r = await call('nxm:set', e.target.checked);
      toast(r.registered ? 'Nexus "Mod Manager Download" links now open STR Companion' : 'STR Companion no longer handles Nexus links', 'ok');
    } catch { /* toast shown */ }
    render();
  });
  main().querySelectorAll('[data-nexus]').forEach(b => b.addEventListener('click', () => call('mods:openNexus', Number(b.dataset.nexus), 'files')));
  if ($('#cancelSetup')) $('#cancelSetup').addEventListener('click', async () => { await call('setup:cancel'); toast('Cancelling after the current step…'); });
  if ($('#runSetup')) $('#runSetup').addEventListener('click', async () => {
    const mods = todo.filter(s => s.kind === 'mod').length;
    const how = d.premium ? 'download and install automatically'
      : d.nxm.registered ? 'open each Nexus page in your browser — click "Slow download" and the app installs it'
        : 'open each Nexus page — click "Manual download" and the app installs it from your Downloads folder';
    if (!await confirmBox('Set up everything?', `${mods ? `<b>${mods} mod${mods > 1 ? 's' : ''}</b> will ${how}. ` : ''}Then Anniversary content and the load order are matched to the host${$('#presetToo').checked ? ', and the co-op game settings are applied' : ''}.<br><br>Keep Skyrim closed until it's done.`, 'Start')) return;
    for (const k of Object.keys(setupProgress)) delete setupProgress[k];
    setupRunning = true;
    const preset = $('#presetToo').checked;
    render();
    call('setup:run', { preset }).catch(() => { setupRunning = false; if (state.page === 'setup') render(); });
  });
}

// A "Mod Manager Download" click the app didn't ask for: confirm before installing anything.
api.on('nxm:incoming', async ({ url, modId, fileId }) => {
  if (!await confirmBox('Install from Nexus?', `You clicked <b>Mod Manager Download</b> for Nexus mod <b>#${Number(modId)}</b> (file ${Number(fileId)}). Install it now?`, 'Install')) return;
  const close = modal('<h2>Installing…</h2><div class="sub"><span class="spinner"></span> Downloading from Nexus and installing.</div>');
  try {
    const r = await api.call('nxm:install', url);
    close();
    showInstallResult(`Nexus mod #${Number(modId)}`, r);
  } catch (e) { close(); toast(e.message, 'err'); }
});

// ---------- Play & Server ----------
async function play() {
  const [procs, net, prefs, deckState] = await Promise.all([call('launch:status'), call('net:info'), call('settings:set', {}), isLinux() ? call('deck:status').catch(() => null) : null]);
  const st = { ...procs, autoSnapshot: prefs.autoSnapshot };
  const viaSteamPlay = !!(deckState && deckState.play && deckState.play.launchOptionSet && !deckState.play.flags.solo);
  const pill = (on, label, onText = 'running', offText = 'not running') => `<span class="pill ${on ? 'ok' : ''}">● ${label}: ${on ? onText : offText}</span>`;
  main().innerHTML = head('Play & Server', 'Start your session from here. As host, start the server first, then launch the game and connect to it.') + `
    <div class="hero">
      <div class="card">
        <h2>Play</h2>
        <div class="sub">Opens the Skyrim Together launcher, which starts Skyrim with SKSE and the multiplayer mod.</div>
        <div class="status-line" id="procStatus">
          ${pill(st.steam, 'Steam')} ${pill(st.client || st.game, 'Skyrim')} ${pill(st.server, 'Server')}
          ${st.vortex ? '<span class="pill warn">Vortex is open — avoid deploying while playing</span>' : ''}
        </div>
        <div class="row"><button class="btn primary big" id="launch">▶ Launch Skyrim Together</button></div>
        <label class="row sub" style="cursor:pointer"><span class="switch"><input type="checkbox" id="autoSnap" ${st.autoSnapshot ? 'checked' : ''}><span></span></span>Snapshot my saves before every launch</label>
        ${viaSteamPlay ? '<div class="callout blue">Launching goes through Steam&#39;s <b>Play</b> button, set up on the <a href="#" id="toDeck">Steam &amp; Deck</a> page.</div>' : ''}
        ${isLinux() && !viaSteamPlay && state.protonLauncher === false ? `<div class="callout"><b>Easiest on Linux:</b> set up Steam's Play button on the <a href="#" id="toDeck">Steam &amp; Deck</a> page. Or install <b>protontricks</b> to start Skyrim Together inside Skyrim's Proton prefix. Install it from your distro or Flathub (<span class="mono">com.github.Matoking.protontricks</span>).</div>` : ''}
        <div class="callout blue"><b>Connecting:</b> In game, press <b>F2</b> (or Right-Ctrl) to open the Skyrim Together menu and use <b>Connect</b>. Friends enter your IP and port plus the join password.</div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Your server</h2><div class="row">
          <button class="btn primary" id="startSrv" ${st.server ? 'disabled' : ''}>Start server</button>
          <button class="btn danger" id="stopSrv" ${st.server ? '' : 'disabled'}>Stop</button></div></div>
        <div class="sub">Share these with your friends:</div>
        <div class="copyable"><code id="ipLine">Public IP hidden — click Show</code><button class="btn small" id="showIp">Show</button><button class="btn small" id="copyIp">Copy</button></div>
        <div class="sub">On the same Wi-Fi / LAN: <span class="mono">${esc(net.local.join(', ') || 'unknown')}</span></div>
        <div class="row"><button class="btn" id="invite">✉ Copy invite for your group chat</button></div>
        <div id="session"></div>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <h2>Friends can't connect?</h2>
      <div class="sub">
        1. Make sure the server says it started on port <b id="portLbl">10578</b> (see Logs → Server).<br>
        2. Forward that port (<b>UDP</b>) on your router to this PC, or use a VPN like Tailscale/ZeroTier and share that IP instead.<br>
        3. ${isLinux() ? 'If you run a firewall (ufw, firewalld), allow that UDP port.' : 'Allow <b>SkyrimTogetherServer.exe</b> through Windows Firewall when it asks.'}<br>
        4. Everyone must have the same mods — compare setup codes on the <a href="#" id="toFriends">Friends Sync</a> page.
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="card-head"><div><h2>Router</h2><div class="sub">Friends outside your home reach your server through your router. STR Companion can check it and open the port for you (UPnP).</div></div>
        <button class="btn" id="checkRouter">Check my router</button></div>
      <div id="routerResult"></div>
    </div>`;
  // A second copy of the game would just fail, so the button waits until Skyrim closes.
  const setLaunchState = s => {
    const b = $('#launch');
    if (!b || b.querySelector('.spinner')) return;
    const running = s.client || s.game;
    b.disabled = running;
    b.textContent = running ? 'Skyrim is running' : '▶ Launch Skyrim Together';
  };
  setLaunchState(st);
  let publicIp = null, port = 10578;
  const ipLine = () => { $('#ipLine').textContent = publicIp ? `${publicIp}:${port}` : 'Public IP hidden — click Show'; };
  $('#showIp').addEventListener('click', async () => { publicIp = await call('net:publicIp'); ipLine(); });
  $('#copyIp').addEventListener('click', async () => { if (!publicIp) publicIp = await call('net:publicIp'); ipLine(); copy(`${publicIp}:${port}`); });
  $('#toFriends').addEventListener('click', e => { e.preventDefault(); go('friends'); });
  main().querySelectorAll('#toDeck').forEach(a => a.addEventListener('click', e => { e.preventDefault(); go('deck'); }));
  const showRouter = async btn => {
    busy(btn, true, 'Asking the router…');
    try {
      const r = await call('upnp:status');
      const el = $('#routerResult');
      if (!el) return;
      if (!r.router) {
        el.innerHTML = '<div class="callout">No router answered. UPnP may be switched off in your router&#39;s settings — turn it on, or forward the port by hand (UDP <b>' + r.port + '</b> to <span class="mono">' + esc(net.local[0] || 'this PC') + '</span>). Or skip port forwarding entirely with Tailscale or ZeroTier.</div>';
        return;
      }
      const wan = { cgnat: '<div class="callout"><b>Your internet provider uses CGNAT</b> (your router&#39;s address ' + esc(r.wanIp) + ' is shared with other customers). Port forwarding can&#39;t work, so friends can&#39;t reach a server on this PC. Use <b>Tailscale</b> or <b>ZeroTier</b> and share that address instead, or let a friend host.</div>', 'double-nat': '<div class="callout"><b>There are two routers in a row</b> (yours reports ' + esc(r.wanIp) + '). Open the port on both, or put the first one in bridge mode — or use Tailscale/ZeroTier.</div>', public: '', unknown: '' }[r.wan] || '';
      el.innerHTML = wan + '<div class="check ' + (r.mapped ? 'ok' : 'warn') + '" style="margin-top:8px"><div class="dot">' + (r.mapped ? '✓' : '!') + '</div><div><div class="t">' + (r.mapped ? 'Port ' + r.port + ' (UDP) is open to this PC' : 'Port ' + r.port + ' (UDP) is not forwarded') + '</div><div class="d">Router ' + esc(r.routerIp) + ' · this PC ' + esc(r.localIp || '?') + (r.wanIp ? ' · internet address ' + esc(r.wanIp) : '') + '</div></div><div>' + (r.mapped ? '<button class="btn small" id="closePort">Close it</button>' : '<button class="btn small primary" id="openPort">Open it</button>') + '</div></div>';
      const op = $('#openPort'), cp = $('#closePort');
      if (op) op.addEventListener('click', async () => { busy(op, true); try { await call('upnp:open'); toast('Port opened on your router', 'ok'); } catch { /* toast shown */ } showRouter($('#checkRouter')); });
      if (cp) cp.addEventListener('click', async () => { busy(cp, true); try { await call('upnp:close'); toast('Port closed', 'ok'); } catch { /* toast shown */ } showRouter($('#checkRouter')); });
    } catch { /* toast shown */ } finally { busy(btn, false); }
  };
  $('#checkRouter').addEventListener('click', e => showRouter(e.currentTarget));
  $('#launch').addEventListener('click', async e => {
    busy(e.currentTarget, true, $('#autoSnap').checked ? 'Snapshotting saves…' : 'Launching…');
    try {
      const r = await call('launch:client');
      const snap = r.snapshot && !r.snapshot.error ? ` Saves snapshotted (${r.snapshot.files} files).` : '';
      toast((r.steamStarted ? 'Starting Steam and Skyrim Together…' : 'Launching Skyrim Together…') + snap, 'ok');
      if (r.snapshot && r.snapshot.error) toast(`Couldn't snapshot saves: ${r.snapshot.error}`, 'err');
    } catch { /* toast already shown */ } finally { setTimeout(() => busy($('#launch'), false), 3000); }
  });
  $('#autoSnap').addEventListener('change', e => call('settings:set', { autoSnapshot: e.target.checked }));
  $('#invite').addEventListener('click', async () => {
    if (!publicIp) { try { publicIp = await call('net:publicIp'); ipLine(); } catch { /* invite still works with a placeholder */ } }
    copy(await call('share:invite', publicIp));
  });
  $('#startSrv').addEventListener('click', async () => { await call('launch:server'); toast('Server starting in its own window', 'ok'); setTimeout(render, 2500); });
  $('#stopSrv').addEventListener('click', async () => {
    if (!await confirmBox('Stop the server?', 'Everyone connected will be disconnected. Make sure the party leader has saved.', 'Stop server')) return;
    await call('launch:stopServer'); toast('Server stopped'); setTimeout(render, 1500);
  });

  let lastProcs = st;
  // One poll for both the status pills and the player list, so the process list is read once per tick.
  const refresh = async () => {
    const [s, fresh] = await Promise.all([api.call('server:session').catch(() => null), api.call('launch:status').catch(() => null)]);
    // A failed check keeps the last known state instead of flashing "offline".
    const procs = fresh || lastProcs;
    lastProcs = procs;
    if (!$('#procStatus')) return;
    if (procs) {
      $('#procStatus').innerHTML = `${pill(procs.steam, 'Steam')} ${pill(procs.client || procs.game, 'Skyrim')} ${pill(procs.server, 'Server')} ${procs.vortex ? '<span class="pill warn">Vortex is open — avoid deploying while playing</span>' : ''}`;
      $('#startSrv').disabled = procs.server; $('#stopSrv').disabled = !procs.server;
      setLaunchState(procs);
    }
    renderSession(s, procs || {});
  };
  const renderSession = (s, procs) => {
    if (!s || !$('#session')) return;
    if (s.port) { port = s.port; $('#portLbl').textContent = s.port; ipLine(); }
    // The log keeps the last session's players after the server closes, so only trust it while it runs.
    if (!procs.server) {
      $('#session').innerHTML = `<h3>Server is offline</h3><div class="sub">Start it to host. Friends connect to your IP and port${s.port ? ` (${s.port})` : ''}.</div>`;
      return;
    }
    $('#session').innerHTML = `
      <h3>On the server now ${s.startedAt ? `<span class="pill">since ${esc(s.startedAt.slice(11, 16))}</span>` : ''}</h3>
      <div class="players">${s.players.length ? s.players.map(p => `<div class="player"><div class="avatar">${esc((p.name || '?')[0].toUpperCase())}</div><div><b>${esc(p.name)}</b><div class="sub">${p.mods} mods · joined ${esc((p.since || '').slice(11, 16))}</div></div></div>`).join('') : '<div class="sub">Nobody connected.</div>'}</div>
      ${s.events.length ? `<h3>Recent activity</h3><div class="events">${s.events.slice().reverse().map(e => `<div style="${e.warn ? 'color:var(--warn)' : ''}">${esc(e.ts.slice(11, 19))} — ${esc(e.text)}</div>`).join('')}</div>` : ''}`;
  };
  renderSession(await api.call('server:session').catch(() => null), st);
  state.timers.push(setInterval(refresh, 4000));
}

// ---------- Steam & Deck ----------
async function deck() {
  const d = await call('deck:status');
  const linux = d.platform === 'linux';
  const row = (ok, title, detail, action = '') => `
    <div class="check ${ok === true ? 'ok' : ok === false ? 'warn' : 'info'}">
      <div class="dot">${ok === true ? '✓' : ok === false ? '!' : 'i'}</div>
      <div><div class="t">${title}</div><div class="d">${detail}</div></div><div>${action}</div></div>`;
  const p = d.play;
  const playReady = p && p.wrapper && p.launchOptionSet;

  main().innerHTML = head('Steam & Deck', linux
    ? 'Make Steam\'s own <b>Play</b> button start Skyrim Together — in Gaming Mode too — and open STR Companion from your Steam library.'
    : 'Add STR Companion to your Steam library. The Play-button automation is for the Steam Deck and Linux; on Windows, launch from Play & Server.') + `
    ${d.gamingMode ? '<div class="callout" style="margin-bottom:14px"><b>You\'re in Gaming Mode.</b> Everything here works, but changing Steam\'s settings needs Desktop Mode (Steam button → Power → Switch to Desktop), because Steam has to close for a moment.</div>' : ''}
    ${linux ? `<div class="card">
      <div class="card-head"><div><h2>Press Play → co-op</h2><div class="sub">A small launch script goes next to SkyrimSE.exe, and Steam's launch options for Skyrim start it before the game. When you press Play it swaps Skyrim's normal launcher for Skyrim Together, which Proton runs like any Windows program. Your own launch options are kept.</div></div>
        <div class="row">${playReady ? '<button class="btn" id="undoPlay">Undo</button>' : `<button class="btn primary" id="setupPlay" ${d.steamFound ? '' : 'disabled'}>Set up Play button</button>`}</div></div>
      <div class="checks">
        ${row(d.isDeck ? true : null, d.isDeck ? 'Steam Deck detected' : 'Linux PC', d.isDeck ? 'Big buttons and the 1280×800 screen are supported — adjust the size in Settings.' : 'Works the same on any Linux PC with Steam.')}
        ${row(d.steamFound, d.steamFound ? 'Steam found' : 'Steam not found', d.steamFound ? (d.steamRunning ? 'Steam is running — it closes for a moment while its settings change, then reopens.' : 'Steam is closed.') : 'Install Steam, or start it once so it creates its folders.')}
        ${row(!!(p && p.wrapper), 'Launch script', p && p.wrapper ? 'Installed next to SkyrimSE.exe.' : 'Not installed yet.')}
        ${row(!!(p && p.launchOptionSet), 'Skyrim\'s launch options', p && p.launchOptionSet ? `Set for ${p.accounts} Steam account${p.accounts === 1 ? '' : 's'}.` : 'Not set yet.')}
      </div>
      ${playReady ? `<h3>When you press Play</h3>
        <label class="row" style="cursor:pointer;margin-bottom:10px"><span class="switch"><input type="checkbox" id="flagSnap" ${p.flags.autoSnapshot ? 'checked' : ''}><span></span></span><span><b>Snapshot my saves first</b><br><span class="sub">Same snapshots as on the Backups page; old automatic ones are pruned when you next open the app.</span></span></label>
        <label class="row" style="cursor:pointer"><span class="switch"><input type="checkbox" id="flagSolo" ${p.flags.solo ? 'checked' : ''}><span></span></span><span><b>Play solo (start normal Skyrim)</b><br><span class="sub">Play passes straight through to the normal launcher. Switch it off again for co-op — no Steam restart needed.</span></span></label>` : ''}
    </div>` : ''}
    <div class="card">
      <div class="card-head"><div><h2>Open STR Companion from Steam</h2><div class="sub">Adds this app to your Steam library as a non-Steam game${linux ? ', so you can open it in Gaming Mode to check your setup, sync with friends or start the server' : ''}.</div></div>
        <div class="row">${d.inSteam ? '<span class="pill ok">✓ In your Steam library</span>' : `<button class="btn primary" id="addToSteam" ${d.canAddToSteam && d.steamFound ? '' : 'disabled'}>Add to Steam</button>`}</div></div>
      ${!d.canAddToSteam ? '<div class="sub">Only the downloaded app can be added (the AppImage on Linux, the portable .exe on Windows).</div>' : ''}
    </div>
    ${linux ? `<div class="card"><h2>Steam Deck tips</h2><div class="sub">
      • In Gaming Mode, <b>STEAM + X</b> opens the on-screen keyboard (for Skyrim Together's connect box and console).<br>
      • Skyrim Together's menu opens with <b>F2</b> or <b>Right Ctrl</b> — bind one to a back button (L4/R4) in Skyrim's controller layout.<br>
      • If Skyrim won't start: Skyrim → ⚙ Properties → Compatibility → try <b>Proton Experimental</b>. Turn on <b>Play solo</b> to check that normal Skyrim starts.<br>
      • Updating STR Companion: the sidebar shows when a new version is out, and it can update itself.</div></div>` : ''}`;

  const steamChange = async (btn, channel, doneMsg) => {
    if (d.steamRunning && !await confirmBox('Steam will close for a moment', 'Steam rewrites its settings when it exits, so it has to close while they change. It reopens right after. Close any running games first.', 'Continue')) return;
    busy(btn, true, 'Working…');
    try { const r = await call(channel); toast(doneMsg(r), 'ok'); } catch { /* toast shown */ }
    render();
  };
  if ($('#setupPlay')) $('#setupPlay').addEventListener('click', e => steamChange(e.currentTarget, 'deck:setupPlay', r => `Play button set up${r.changed ? ` for ${r.changed} account${r.changed === 1 ? '' : 's'}` : ''} — press Play on Skyrim to start co-op`));
  if ($('#undoPlay')) $('#undoPlay').addEventListener('click', async e => {
    if (!await confirmBox('Undo the Play-button setup?', 'Removes the launch script and its launch option. Skyrim\'s Play button starts normal Skyrim again.', 'Undo')) return;
    steamChange(e.currentTarget, 'deck:undoPlay', () => 'Play button back to normal');
  });
  if ($('#addToSteam')) $('#addToSteam').addEventListener('click', e => steamChange(e.currentTarget, 'deck:addToSteam', r => r.added ? 'Added to your Steam library' : 'Already in your Steam library'));
  const flagsFrom = () => ({ autoSnapshot: $('#flagSnap').checked, solo: $('#flagSolo').checked });
  if ($('#flagSnap')) $('#flagSnap').addEventListener('change', async () => { await call('deck:setFlags', flagsFrom()); toast('Saved', 'ok'); });
  if ($('#flagSolo')) $('#flagSolo').addEventListener('change', async e => { await call('deck:setFlags', flagsFrom()); toast(e.target.checked ? 'Play now starts normal Skyrim' : 'Play now starts Skyrim Together', 'ok'); });
}

// ---------- Mods ----------
let modsTab = 'required';
let updates = null;

async function mods() {
  const data = await call('mods:list');
  const cats = [...data.categories, { id: 'custom', title: 'My mods', desc: 'Mods you added by Nexus link.' }, { id: 'other', title: 'Other installed', desc: 'Everything else Vortex or this app installed.' }];
  const updCount = updates ? Object.values(updates).filter(u => u.hasUpdate).length : 0;
  main().innerHTML = head('Mods', `Curated mods that work well with Skyrim Together, plus your own. <b>Every player needs the same plugins</b> — share setup codes on Friends Sync to check.`,
    `<button class="btn" id="fromFile">Install from file…</button><button class="btn" id="addCustom">+ Add a Nexus mod</button><button class="btn primary" id="checkUpd">${updates ? `↻ Updates (${updCount})` : 'Check for updates'}</button>`) +
    (!data.hasNexusKey ? `<div class="callout">Add your free Nexus API key in <a href="#" id="toSettings">Settings</a> to check for updates and see mod details. Installs still work without it.</div>` : '') +
    `<div class="tabs" id="modTabs">${cats.map(c => {
      const n = data.mods.filter(m => (m.category === c.id)).length;
      return n || ['required', 'custom'].includes(c.id) ? `<button data-tab="${c.id}" class="${modsTab === c.id ? 'active' : ''}">${esc(c.title)} <span class="pill">${n}</span></button>` : '';
    }).join('')}</div>
    <div class="sub" style="margin-bottom:12px">${esc((cats.find(c => c.id === modsTab) || {}).desc || '')}</div>
    <div class="mod-grid" id="modGrid"></div>`;

  const list = data.mods.filter(m => m.category === modsTab);
  $('#modGrid').innerHTML = list.length ? list.map(m => modCard(m, data)).join('') : '<div class="empty">Nothing here yet.</div>';

  $('#modTabs').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { modsTab = b.dataset.tab; render(); }));
  if ($('#toSettings')) $('#toSettings').addEventListener('click', e => { e.preventDefault(); go('settings'); });
  $('#checkUpd').addEventListener('click', async e => {
    busy(e.currentTarget, true, 'Checking…');
    try {
      updates = await call('mods:checkUpdates');
      const n = Object.values(updates).filter(u => u.hasUpdate).length;
      toast(n ? `${n} update${n > 1 ? 's' : ''} available` : 'Everything is up to date', 'ok');
      render();
    } catch { busy(e.currentTarget, false); }
  });
  $('#addCustom').addEventListener('click', addCustomMod);
  $('#fromFile').addEventListener('click', async () => {
    const file = await call('mods:pickArchive');
    if (file) installFile(file, {});
  });
  $('#modGrid').querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => modAction(b, data.mods.find(m => String(m.id) === b.dataset.id || m.registryKey === b.dataset.key))));
}

function modCard(m, data) {
  const u = updates && m.id ? updates[m.id] : null;
  const compat = m.compat ? `<span class="pill ${m.compat === 'safe' ? 'ok' : m.compat === 'likely' ? 'gold' : 'warn'}" title="${esc(data.compatLabels[m.compat])}">${esc({ safe: 'STR-safe', likely: 'Likely OK', test: 'Test first' }[m.compat])}</span>` : '';
  const inst = m.installed ? `<span class="pill ok">✓ Installed${m.installedVersion ? ' ' + esc(m.installedVersion) : ''}</span>` : '<span class="pill">Not installed</span>';
  const upd = u && u.hasUpdate ? `<span class="pill gold">Update: ${esc(u.latest)}</span>` : u && u.latest && m.installed ? '<span class="pill">Up to date</span>' : '';
  const mgr = m.manager ? `<span class="pill">${esc(m.manager)}</span>` : '';
  const lock = m.loadStatus === 'loaded' ? ''
    : m.loadStatus === 'failed' ? `<div class="sub" style="color:var(--err)">Didn't load last launch — you probably need the build for Skyrim ${esc(data.gameVersion)}.</div>`
      : m.versionLocked ? `<div class="sub" style="color:var(--warn)">Needs a build for Skyrim ${esc(data.gameVersion)} — check the file name on Nexus.</div>` : '';
  const loaded = m.loadStatus === 'loaded' ? '<span class="pill ok">Loads on your game</span>' : '';
  const idAttr = m.id ? `data-id="${m.id}"` : `data-key="${esc(m.registryKey)}"`;
  return `<div class="mod ${m.installed ? 'installed' : ''}">
    <div class="row"><div class="name">${esc(m.name)}</div><div class="spacer"></div>${compat}</div>
    <div class="desc">${esc(m.desc || '')}</div>${lock}
    <div class="meta">${inst}${loaded}${upd}${mgr}</div>
    <div class="row">
      ${m.id ? `<button class="btn small ${!m.installed || (u && u.hasUpdate) ? 'primary' : ''}" data-act="install" ${idAttr}>${m.installed ? (u && u.hasUpdate ? 'Update' : 'Reinstall') : 'Install'}</button>
      <button class="btn small" data-act="nexus" ${idAttr}>Nexus page</button>` : ''}
      ${m.registryKey ? `<button class="btn small danger" data-act="uninstall" ${idAttr}>Uninstall</button>` : ''}
      ${m.custom ? `<button class="btn small ghost" data-act="remove" ${idAttr}>Remove from list</button>` : ''}
      ${m.altUrl ? `<button class="btn small ghost" data-act="alt" ${idAttr}>Official site</button>` : ''}
    </div>
  </div>`;
}

async function modAction(btn, m) {
  if (!m) return;
  const act = btn.dataset.act;
  if (act === 'nexus') return call('mods:openNexus', m.id);
  if (act === 'alt') return call('shell:external', m.altUrl);
  if (act === 'remove') { await call('mods:removeCustom', m.id); return render(); }
  if (act === 'uninstall') {
    if (!await confirmBox(`Uninstall ${m.name}?`, 'Its files are moved to the backup folder, so you can restore them from Backups.', 'Uninstall')) return;
    const r = await call('mods:uninstall', m.registryKey);
    toast(`Moved ${r.moved} files to backup${r.originalsRestored ? `, put back ${r.originalsRestored} original files it had replaced` : ''}`, 'ok');
    return render();
  }
  if (act === 'install') {
    if (m.manager === 'Vortex') {
      const ok = await confirmBox(`${m.name} is managed by Vortex`, 'To update it, use <b>Mod Manager Download</b> on the Nexus page so Vortex keeps track of it. Installing here as well would give you two copies.', 'Open Nexus page');
      if (ok) call('mods:openNexus', m.id, 'files');
      return;
    }
    busy(btn, true, 'Starting…');
    try {
      const r = await call('mods:install', m.id);
      if (r.manual) return manualDownload(m);
      showInstallResult(m.name, r);
    } finally { busy(btn, false); }
  }
}

/** Free Nexus accounts can't download through the API, so: open the page, watch Downloads, install when it lands. */
async function manualDownload(m) {
  await call('downloads:watch', m.id, m.name);
  await call('mods:openNexus', m.id, 'files');
  modal(`<h2>Download ${esc(m.name)}</h2>
    <div class="sub">The Nexus files page is open in your browser.</div>
    <ol class="sub">
      <li>Click <b>Manual download</b> on the main file${m.versionLocked ? ' that matches your game version' : ''}.</li>
      <li>Leave it in your <b>Downloads</b> folder.</li>
      <li>This app spots the file and offers to install it.</li>
    </ol>
    <div class="row"><span class="spinner"></span><span class="sub">Watching your Downloads folder…</span></div>
    <div class="actions"><button class="btn" id="pickInstead">I already have the file…</button><button class="btn" data-close id="stopWatch">Cancel</button></div>`,
  (card, close) => {
    card.querySelector('#stopWatch').addEventListener('click', () => call('downloads:stop'));
    card.querySelector('#pickInstead').addEventListener('click', async () => {
      const file = await call('mods:pickArchive');
      if (!file) return;
      call('downloads:stop'); close();
      installFile(file, { name: m.name, nexusId: m.id });
    });
  });
}

// Premium downloads report progress; show it on the mod's Install button.
api.on('progress', ({ id, p }) => {
  if (id === 'self') { const bar = document.getElementById('selfProg'); if (bar) bar.style.width = `${Math.round(p * 100)}%`; return; }
  const b = document.querySelector(`[data-act="install"][data-id="${Number(id)}"]`);
  if (b && b.disabled) b.innerHTML = `<span class="spinner"></span> Downloading ${Math.round(p * 100)}%`;
});

api.on('download:found', ({ file, modId, name, size }) => {
  modal(`<h2>Download finished</h2>
    <div class="sub">Found <b>${esc(file.split(/[\\/]/).pop())}</b> (${fmtSize(size)}). Install it as <b>${esc(name)}</b>?</div>
    <div class="actions"><button class="btn" data-close>Not now</button><button class="btn primary" id="doInstall">Install</button></div>`,
  (card, close) => card.querySelector('#doInstall').addEventListener('click', () => { close(); installFile(file, { name, nexusId: modId }); }));
});

async function installFile(file, meta) {
  const close = modal(`<h2>Installing…</h2><div class="sub"><span class="spinner"></span> Extracting and copying files. Anything it replaces is backed up first.</div>`);
  try {
    const r = await api.call('mods:installArchive', file, meta);
    close();
    showInstallResult(meta.name || file.split(/[\\/]/).pop(), r);
  } catch (e) { close(); toast(e.message, 'err'); }
}

function showInstallResult(name, r) {
  if (!r.ok) {
    modal(`<h2>Couldn't install automatically</h2><div class="sub">${esc(r.message)}</div><div class="actions"><button class="btn primary" data-close>OK</button></div>`);
    return;
  }
  modal(`<h2>${esc(name)} installed</h2>
    <div class="sub">Copied ${r.files} files to ${r.target === 'data' ? 'the Data folder' : 'the game folder'}.
    ${r.plugins.length ? `<br>Enabled: <span class="mono">${r.plugins.map(esc).join(', ')}</span>` : ''}
    ${r.replaced ? `<br>${r.replaced} existing files were replaced — the originals are in Backups.` : ''}
    <br><br>Remember: your friends need the same mod.</div>
    <div class="actions"><button class="btn primary" data-close>Done</button></div>`);
  if (state.page === 'mods') render();
}

function addCustomMod() {
  modal(`<h2>Add a Nexus mod</h2>
    <div class="sub">Paste the mod's Nexus link. It's added to <b>My mods</b> so you can install it and check for updates like the others.</div>
    <p><input type="text" id="ref" placeholder="https://www.nexusmods.com/skyrimspecialedition/mods/12345" style="width:100%"></p>
    <div class="callout">Only mods that change visuals, sounds or the UI are safe for one player alone. Anything that adds a plugin (.esp/.esm/.esl) must be installed by every player.</div>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="addBtn">Add</button></div>`,
  (card, close) => {
    card.querySelector('#ref').focus();
    card.querySelector('#addBtn').addEventListener('click', async e => {
      busy(e.currentTarget, true);
      try {
        const r = await call('mods:addCustom', card.querySelector('#ref').value);
        close(); toast(`Added ${r.name}`, 'ok'); modsTab = 'custom'; render();
      } catch { busy(e.currentTarget, false); }
    });
  });
}

// ---------- Cleanup ----------
async function cleanup() {
  const r = await call('cleanup:report');
  const ccSize = r.cc.removable.reduce((s, i) => s + i.size, 0);
  main().innerHTML = head('Cleanup', 'Move content that causes trouble in co-op into a backup folder. Nothing is deleted — restore anything from Backups.') + `
    <div class="card">
      <div class="card-head"><div><h2>Anniversary Edition content</h2>
        <div class="sub">The Skyrim Together team recommends disabling these, and every player would need the exact same set otherwise.</div></div>
        ${r.cc.removable.length ? `<button class="btn primary" id="ccMove">Move ${r.cc.removable.length} add-ons to backup (${fmtSize(ccSize)})</button>` : ''}</div>
      ${r.cc.removable.length ? `<details><summary class="sub" style="cursor:pointer">Show the ${r.cc.removable.length} add-ons</summary><div class="table-wrap" style="margin-top:10px"><table><thead><tr><th><input type="checkbox" id="ccAll" checked aria-label="Select all"></th><th>Plugin</th><th>Size</th></tr></thead><tbody>
        ${r.cc.removable.map(i => `<tr><td><input type="checkbox" class="ccPick" value="${esc(i.plugin)}" checked></td><td class="mono">${esc(i.plugin)}</td><td>${fmtSize(i.size)}</td></tr>`).join('')}
      </tbody></table></div></details>` : '<div class="callout blue">✓ No extra Anniversary Edition content is installed.</div>'}
      ${r.cc.keep.length ? `<div class="sub" style="margin-top:10px">Kept (USSEP needs these, and every copy of the game has them): <span class="mono">${r.cc.keep.map(i => esc(i.plugin)).join(', ')}</span></div>` : ''}
    </div>
    ${r.issues.length ? `<div class="card"><h2>Known problem mods</h2>${r.issues.map((k, i) => `<div class="check warn" style="margin-top:8px"><div class="dot">!</div><div><div class="t">${esc(k.name)} <span class="mono sub">${esc(k.file)}</span></div><div class="d">${esc(k.why)}</div></div><div><button class="btn small" data-issue="${i}">Move to backup</button></div></div>`).join('')}</div>` : ''}
    <div class="card">
      <div class="card-head"><div><h2>Your plugins</h2><div class="sub">Tick mods you don't need and move them to backup, or just switch them off.${r.manager === 'Vortex' ? ' <b>Vortex-managed mods are better disabled in Vortex</b>, or it will put them back on the next deploy.' : ''}</div></div>
        <button class="btn" id="plMove" disabled>Move selected to backup</button></div>
      <div class="table-wrap"><table><thead><tr><th></th><th>#</th><th>Plugin</th><th>On</th><th>From</th><th>Size</th><th>Needed by</th></tr></thead><tbody>
        ${r.plugins.map(p => `<tr>
          <td>${p.protected ? '<span title="Base game / required" class="sub">🔒</span>' : `<input type="checkbox" class="plPick" value="${esc(p.name)}" aria-label="Select ${esc(p.name)}">`}</td>
          <td class="num">${p.index ?? ''}</td>
          <td><span class="mono">${esc(p.name)}</span>${p.light ? ' <span class="pill">ESL</span>' : ''}</td>
          <td>${p.source === 'base' || p.source === 'creation-club' ? '<span class="sub">always</span>' : `<label class="switch"><input type="checkbox" class="plOn" data-name="${esc(p.name)}" ${p.active ? 'checked' : ''}><span></span></label>`}</td>
          <td class="sub">${esc(p.manager || (p.source === 'base' ? 'Base game' : p.creationClub ? 'Creation Club' : 'Manual'))}</td>
          <td class="sub">${fmtSize(p.size)}</td>
          <td class="sub deps">${p.dependents.length ? esc(p.dependents.slice(0, 3).join(', ')) + (p.dependents.length > 3 ? ` +${p.dependents.length - 3}` : '') : ''}</td>
        </tr>`).join('')}
      </tbody></table></div>
    </div>`;

  const ccMove = $('#ccMove');
  if (ccMove) ccMove.addEventListener('click', async () => {
    const picks = [...main().querySelectorAll('.ccPick:checked')].map(c => c.value);
    if (!picks.length) return toast('Nothing selected');
    if (!await confirmBox('Move Anniversary content to backup?', `${picks.length} add-ons will be moved to the backup folder. Start a new character afterwards — old saves that used them may not load.`, 'Move to backup')) return;
    busy(ccMove, true);
    const res = await call('cleanup:backupCC', picks);
    toast(`Moved ${res.moved} files to backup`, 'ok');
    render();
  });
  const ccAll = $('#ccAll');
  if (ccAll) ccAll.addEventListener('change', () => main().querySelectorAll('.ccPick').forEach(c => { c.checked = ccAll.checked; }));
  main().querySelectorAll('[data-issue]').forEach(b => b.addEventListener('click', async () => {
    const k = r.issues[Number(b.dataset.issue)];
    await call('fix:run', { action: 'backupFiles', rels: [k.rel], label: k.name });
    toast(`${k.name} moved to backup`, 'ok'); render();
  }));
  const plMove = $('#plMove');
  const sync = () => { plMove.disabled = !main().querySelector('.plPick:checked'); };
  main().querySelectorAll('.plPick').forEach(c => c.addEventListener('change', sync));
  plMove.addEventListener('click', async () => {
    const names = [...main().querySelectorAll('.plPick:checked')].map(c => c.value);
    const needed = r.plugins.filter(p => names.includes(p.name) && p.dependents.some(d => !names.includes(d)));
    const warn = needed.length ? `<br><br><b style="color:var(--warn)">Warning:</b> ${needed.map(p => esc(p.name) + ' is needed by ' + esc(p.dependents.join(', '))).join('; ')}. Those would stop working.` : '';
    if (!await confirmBox(`Move ${names.length} mod${names.length > 1 ? 's' : ''} to backup?`, `Their plugins and archives go to the backup folder.${warn}`, 'Move to backup')) return;
    const res = await call('cleanup:backupPlugins', names);
    toast(`Moved ${res.moved} files to backup`, 'ok'); render();
  });
  main().querySelectorAll('.plOn').forEach(c => c.addEventListener('change', async () => {
    await call('cleanup:setActive', c.dataset.name, c.checked);
    toast(`${c.dataset.name} ${c.checked ? 'enabled' : 'disabled'}`, 'ok');
  }));
}

// ---------- Config editor ----------
let cfgTab = 'server';
let cfgShowAll = false;

async function config() {
  const files = (await call('config:list')).filter(f => f.exists);
  if (!files.some(f => f.id === cfgTab)) cfgTab = files[0] ? files[0].id : null;
  if (!cfgTab) { main().innerHTML = head('Config Editor', '') + '<div class="empty">No config files found yet — launch the game once.</div>'; return; }
  const [doc, presets] = await Promise.all([call('config:load', cfgTab), call('config:presets', cfgTab)]);
  const changes = new Map();

  const shown = doc.entries.filter(e => cfgShowAll || e.featured);
  const groups = [];
  for (const e of shown) { let g = groups.find(x => x.name === e.group); if (!g) groups.push(g = { name: e.group, items: [] }); g.items.push(e); }

  main().innerHTML = head('Config Editor', esc(doc.note), `<button class="btn" id="openRaw">Open file</button>`) + `
    <div class="tabs" id="cfgTabs">${files.map(f => `<button data-tab="${f.id}" class="${f.id === cfgTab ? 'active' : ''}">${esc(f.title)}</button>`).join('')}</div>
    <div class="grid" style="grid-template-columns: minmax(0, 1fr) 320px; align-items:start">
      <div class="card">
        <div class="card-head"><div class="sub mono">${esc(doc.file)}</div>
          <label class="row sub" style="cursor:pointer"><span class="switch"><input type="checkbox" id="showAll" ${cfgShowAll ? 'checked' : ''}><span></span></span>Show every setting (${doc.entries.length})</label></div>
        ${groups.length ? groups.map(g => `<div class="settings-group"><h3>${esc(g.name)}</h3>${g.items.map(settingRow).join('')}</div>`).join('') : '<div class="empty">No friendly settings for this file — switch on "Show every setting".</div>'}
        <div class="savebar" id="savebar" style="display:none"><span id="changeCount"></span><div class="spacer"></div><button class="btn" id="discard">Discard</button><button class="btn primary" id="save">Save changes</button></div>
      </div>
      <div>
        <div class="card">
          <h2>Presets</h2>
          <div class="sub" style="margin-bottom:10px">One click applies a whole set of settings. The old file is snapshotted first.</div>
          ${presets.length ? presets.map((p, i) => `<div class="preset"><div style="flex:1"><b>${esc(p.name)}</b>${p.builtin ? '' : ' <span class="pill">yours</span>'}<div class="pd">${esc(p.description || '')}</div></div>
            <div class="row" style="flex-direction:column;gap:4px"><button class="btn small" data-preset="${i}">Apply</button>${p.builtin ? '' : `<button class="btn small ghost" data-delpreset="${i}">Delete</button>`}</div></div>`).join('') : '<div class="sub">No presets for this file.</div>'}
          <div class="row" style="margin-top:12px"><input type="text" id="presetName" placeholder="Name your current settings" style="flex:1"><button class="btn small" id="savePreset">Save</button></div>
        </div>
      </div>
    </div>`;

  function settingRow(e) {
    const id = `${e.section}/${e.key}`;
    const v = e.value;
    let control;
    if (e.type === 'bool' || e.type === 'bool01') {
      const on = e.type === 'bool' ? /^true$/i.test(v) : v === '1';
      control = `<label class="switch"><input type="checkbox" data-k="${esc(id)}" data-type="${e.type}" ${on ? 'checked' : ''}><span></span></label>`;
    } else if (e.type === 'enum') {
      const opts = e.options.map(o => Array.isArray(o) ? o : [o, o]);
      control = `<select data-k="${esc(id)}">${opts.map(([val, lab]) => `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
    } else if (e.type === 'int' || e.type === 'float') {
      control = `<input type="number" data-k="${esc(id)}" value="${esc(v)}" ${e.min !== undefined ? `min="${e.min}"` : ''} ${e.max !== undefined ? `max="${e.max}"` : ''} step="${e.step || (e.type === 'int' ? 1 : 'any')}">`;
    } else if (e.type === 'secret') {
      control = `<input type="password" data-k="${esc(id)}" value="${esc(v)}" autocomplete="off"><button class="btn small ghost" data-reveal="${esc(id)}">Show</button>`;
    } else {
      control = `<input type="text" data-k="${esc(id)}" value="${esc(v)}">`;
    }
    return `<div class="setting" data-row="${esc(id)}">
      <div><div class="label">${esc(e.label)}${e.label !== e.key ? `<span class="key">${esc(e.key)}</span>` : ''}${e.missing ? ' <span class="pill">not set</span>' : ''}</div>
        ${e.desc ? `<div class="help">${esc(e.desc)}</div>` : ''}${e.warn ? `<div class="help warn">⚠ ${esc(e.warn)}</div>` : ''}</div>
      <div class="control">${control}</div></div>`;
  }

  const entryFor = id => doc.entries.find(e => `${e.section}/${e.key}` === id);
  const updateBar = () => {
    const bar = $('#savebar');
    bar.style.display = changes.size ? 'flex' : 'none';
    $('#changeCount').textContent = `${changes.size} unsaved change${changes.size === 1 ? '' : 's'}`;
  };
  main().querySelectorAll('[data-k]').forEach(inp => {
    const handler = () => {
      const id = inp.dataset.k;
      const e = entryFor(id);
      let val = inp.value;
      if (inp.type === 'checkbox') val = inp.dataset.type === 'bool' ? (inp.checked ? 'true' : 'false') : (inp.checked ? '1' : '0');
      if (e.type === 'float' && /^\d+\.\d{4}$/.test(e.value) && val !== '' && !isNaN(val)) val = Number(val).toFixed(4);
      if (val === e.value) changes.delete(id); else changes.set(id, { section: e.section, key: e.key, value: val });
      main().querySelector(`[data-row="${CSS.escape(id)}"]`).classList.toggle('changed', changes.has(id));
      updateBar();
    };
    inp.addEventListener('change', handler);
    inp.addEventListener('input', handler);
  });
  main().querySelectorAll('[data-reveal]').forEach(b => b.addEventListener('click', () => {
    const inp = main().querySelector(`[data-k="${CSS.escape(b.dataset.reveal)}"]`);
    inp.type = inp.type === 'password' ? 'text' : 'password';
    b.textContent = inp.type === 'password' ? 'Show' : 'Hide';
  }));
  $('#cfgTabs').querySelectorAll('button').forEach(b => b.addEventListener('click', async () => {
    if (changes.size && !await confirmBox('Discard unsaved changes?', 'You have changes in this file that are not saved.', 'Discard')) return;
    cfgTab = b.dataset.tab; render();
  }));
  $('#showAll').addEventListener('change', async e => {
    if (changes.size && !await confirmBox('Discard unsaved changes?', 'Switching views reloads the settings, and your unsaved changes would be lost.', 'Discard')) {
      e.target.checked = cfgShowAll;
      return;
    }
    cfgShowAll = e.target.checked;
    render();
  });
  $('#openRaw').addEventListener('click', () => call('config:openFile', cfgTab));
  $('#discard').addEventListener('click', () => render());
  $('#save').addEventListener('click', async e => {
    const btn = e.currentTarget;
    busy(btn, true, 'Saving…');
    try {
      const r = await call('config:save', cfgTab, [...changes.values()]);
      toast(`Saved ${r.changed} setting${r.changed === 1 ? '' : 's'}`, 'ok');
      await offerServerRestart(r);
      render();
    } catch { busy(btn, false); }
  });
  main().querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', async () => {
    const p = presets[Number(b.dataset.preset)];
    const n = Object.keys(p.values).length;
    if (!await confirmBox(`Apply "${p.name}"?`, `${esc(p.description || '')}<br><br>Changes up to ${n} settings. The current file is snapshotted first.`, 'Apply preset')) return;
    const r = await call('config:applyPreset', cfgTab, p.name);
    toast(r.changed ? `Applied — ${r.changed} setting${r.changed === 1 ? '' : 's'} changed` : 'Already using these settings', 'ok');
    if (r.changed) await offerServerRestart(r);
    render();
  }));
  main().querySelectorAll('[data-delpreset]').forEach(b => b.addEventListener('click', async () => {
    await call('config:deletePreset', cfgTab, presets[Number(b.dataset.delpreset)].name); render();
  }));
  $('#savePreset').addEventListener('click', async () => {
    const name = $('#presetName').value.trim();
    if (!name) return toast('Give the preset a name');
    await call('config:savePreset', cfgTab, name);
    toast(`Saved preset "${name}"`, 'ok'); render();
  });
}

/** Server settings only apply on start, so offer a restart when it's running. */
async function offerServerRestart(r) {
  if (!r.serverRunning || !r.changed) return;
  if (!await confirmBox('Restart the server now?', 'Server settings apply when it starts. Restarting disconnects everyone — make sure the party leader has saved.', 'Restart server')) return;
  await call('launch:restartServer');
  toast('Server restarting', 'ok');
}

// ---------- Friends Sync ----------
async function friends() {
  const [mine, party] = await Promise.all([call('share:mine'), call('party:list')]);
  main().innerHTML = head('Friends Sync', 'Mismatched setups are the #1 cause of desync in Skyrim Together. Everyone copies their setup code into your group chat; paste a friend\'s code here to see what differs — and match the host\'s load order in one click.') + `
    <div class="grid two">
      <div class="card">
        <h2>Your setup code</h2>
        <div class="sub">Your game version, Skyrim Together version, plugin list (with Nexus links where known) and SKSE plugins — nothing personal.</div>
        <div class="row" style="margin:12px 0"><span class="sub">Your name in codes:</span><input type="text" id="pname" value="${esc(mine.setup.playerName || '')}" style="flex:1"></div>
        <div class="copyable"><code>${esc(mine.code)}</code><button class="btn primary small" id="copyCode">Copy</button></div>
        <h3>What's in it</h3>
        <div class="sub">Skyrim ${esc(mine.setup.gameVersion)} · Skyrim Together ${esc(mine.setup.strVersion || '?')} · SKSE ${esc(mine.setup.skseVersion || 'none')} · ${mine.setup.plugins.length} plugins · ${mine.setup.sksePlugins.length} SKSE plugins</div>
      </div>
      <div class="card">
        <h2>Compare with a friend</h2>
        <textarea id="theirCode" rows="4" placeholder="Paste a friend's STR2-… code here"></textarea>
        <div class="row" style="margin-top:10px"><button class="btn primary" id="compare">Compare</button><button class="btn" id="saveParty">Save to party</button></div>
        <div id="result" style="margin-top:14px"></div>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="card-head"><div><h2>Your party</h2><div class="sub">Saved setup codes, re-checked against your setup every time you open this page. Ask friends for a fresh code after they change mods.</div></div></div>
      ${party.length ? `<div class="players">${party.map((m, i) => `
        <div class="player">
          <div class="avatar">${esc((m.name || '?')[0].toUpperCase())}</div>
          <div style="flex:1"><b>${esc(m.name)}</b>
            <div class="sub">${m.invalid ? esc(m.invalid) : `Skyrim ${esc(m.theirs.gameVersion)} · STR ${esc(m.theirs.strVersion || '?')} · ${m.theirs.plugins} plugins`} · code saved ${fmtDate(m.savedAt)}</div></div>
          ${m.invalid ? '<span class="pill err">Bad code</span>' : m.errors ? `<span class="pill err">${m.errors} to fix</span>` : m.warnings ? `<span class="pill warn">In sync · ${m.warnings} minor</span>` : '<span class="pill ok">✓ In sync</span>'}
          <button class="btn small" data-pcompare="${i}">Compare</button>
          <button class="btn small ghost" data-premove="${i}">Remove</button>
        </div>`).join('')}</div>` : '<div class="sub">No one saved yet. Paste a friend\'s code above and click <b>Save to party</b>.</div>'}
    </div>`;

  $('#copyCode').addEventListener('click', () => copy(mine.code));
  $('#pname').addEventListener('change', async e => { await call('settings:set', { playerName: e.target.value.trim() }); render(); });
  $('#compare').addEventListener('click', () => compareCode($('#theirCode').value));
  $('#saveParty').addEventListener('click', async () => {
    const r = await call('party:save', $('#theirCode').value);
    toast(`Saved ${r.name} to your party`, 'ok');
    render();
  });
  main().querySelectorAll('[data-pcompare]').forEach(b => b.addEventListener('click', () => {
    const m = party[Number(b.dataset.pcompare)];
    $('#theirCode').value = m.code;
    compareCode(m.code);
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }));
  main().querySelectorAll('[data-premove]').forEach(b => b.addEventListener('click', async () => {
    const m = party[Number(b.dataset.premove)];
    if (!await confirmBox(`Remove ${m.name}?`, 'Their saved setup code is removed from your party list.', 'Remove')) return;
    await call('party:remove', m.name);
    render();
  }));
}

async function compareCode(code) {
  const r = await call('share:compare', code);
  if (!$('#result')) return;
  const whoRaw = r.theirs.playerName || 'Your friend';
  const who = esc(whoRaw);
  const p = r.plan;
  const pluginIssues = p.changes || p.missing.length || p.extraImplicit.length;
  const planHtml = pluginIssues ? `
    <div class="card" style="margin-top:12px;padding:14px 16px">
      <h3 style="margin-top:0">Match ${who}'s load order</h3>
      <div class="sub">Use this when ${who} is the host or party leader. Your Plugins.txt is snapshotted first and nothing is deleted — plugins they don't use are just switched off.</div>
      <ul class="sub" style="margin:8px 0 0 18px;padding:0">
        ${p.reorder ? '<li>Reorder your plugins to match theirs</li>' : ''}
        ${p.activate.length ? `<li>Switch on: <span class="mono">${p.activate.map(esc).join(', ')}</span></li>` : ''}
        ${p.deactivate.length ? `<li>Switch off: <span class="mono">${p.deactivate.map(esc).join(', ')}</span></li>` : ''}
      </ul>
      ${p.missing.length ? `<div class="sub" style="margin-top:10px"><b style="color:var(--warn)">You need to install ${p.missing.length} mod${p.missing.length > 1 ? 's' : ''} first:</b></div>
        <div class="players" style="margin-top:6px">${p.missing.map(m => `<div class="player"><span class="mono" style="flex:1">${esc(m.name)}</span>${m.nexusId ? `<button class="btn small" data-nexus="${Number(m.nexusId)}">Nexus page</button>` : '<span class="sub">ask them which mod this is</span>'}</div>`).join('')}</div>` : ''}
      ${p.extraImplicit.length ? `<div class="sub" style="margin-top:10px">You have Creation Club content they don't (<span class="mono">${p.extraImplicit.map(esc).join(', ')}</span>). It can't be switched off — move it to backup on the <a href="#" id="toCleanup">Cleanup</a> page.</div>` : ''}
      <div class="row" style="margin-top:12px">${p.missing.length ? '<button class="btn primary" id="toQuickSetup">Install everything with Quick Setup</button>' : ''}${p.changes ? `<button class="btn ${p.missing.length ? '' : 'primary'}" id="applyMatch">Match their load order</button>` : ''}</div>
    </div>` : '';
  $('#result').innerHTML = (!r.diffs.length
    ? `<div class="callout blue">✓ <b>${who}</b> has exactly the same setup. You're good to go.</div>`
    : `<div class="sub" style="margin-bottom:8px"><b>${who}</b> — ${r.diffs.filter(d => d.level === 'error').length} must-fix, ${r.diffs.filter(d => d.level !== 'error').length} minor</div>` +
      r.diffs.map(d => `<div class="diff ${d.level}"><div class="lvl">${{ error: 'Fix', warn: 'Check', info: 'FYI' }[d.level]}</div><div>${esc(d.text)}</div></div>`).join('')) + planHtml;
  $('#result').querySelectorAll('[data-nexus]').forEach(b => b.addEventListener('click', () => call('mods:openNexus', Number(b.dataset.nexus), 'files')));
  const qs = $('#toQuickSetup');
  if (qs) qs.addEventListener('click', () => { state.prefillSetupCode = code; go('setup'); });
  const tc = $('#toCleanup');
  if (tc) tc.addEventListener('click', e => { e.preventDefault(); go('cleanup'); });
  const apply = $('#applyMatch');
  if (apply) apply.addEventListener('click', async () => {
    const lines = [p.reorder && 'reorder your plugins', p.activate.length && `switch on ${p.activate.length}`, p.deactivate.length && `switch off ${p.deactivate.length}`].filter(Boolean).join(', ');
    if (!await confirmBox(`Match ${whoRaw}'s load order?`, `This will ${esc(lines)}. Your current Plugins.txt is saved to Backups first.${p.missing.length ? `<br><br><b>${p.missing.length} of their mods are still missing</b> — install them too, or the setups won't fully match.` : ''}`, 'Match load order')) return;
    const res = await call('share:applyMatch', code);
    toast('Load order updated to match', 'ok');
    if (res.manager === 'Vortex') toast('Vortex may re-sort plugins on its next deploy — lock the load order or turn off auto-sort in Vortex.', '');
    compareCode(code);
  });
}

// ---------- Session checklist ----------
const CHECKLIST = [
  { id: 'same', who: 'Everyone', what: 'Setup codes match (Friends Sync page)' },
  { id: 'followers', who: 'Everyone', what: 'Dismiss followers before connecting' },
  { id: 'steam', who: 'Everyone', what: 'Steam is in online mode and Skyrim is fully updated (or all on the same version)' },
  { id: 'snapshot', who: 'Everyone', what: 'Snapshot your saves (Backups page) so a bad session can be undone' },
  { id: 'server', who: 'Host', what: 'Server started and friends can see the IP, port and password' },
  { id: 'leader', who: 'Party', what: 'Pick one party leader for the whole campaign — they talk to quest NPCs and pick up quest items' },
  { id: 'save', who: 'Leader', what: 'Save before quest scenes, boss fights and entering new dungeons' },
  { id: 'together', who: 'Everyone', what: 'Stay in the same area for quest scenes, and let the leader start dialogue' },
  { id: 'stuck', who: 'Leader', what: 'If a quest step doesn\'t advance for someone, have them reload or reconnect before trying console fixes' },
  { id: 'end', who: 'Everyone', what: 'Everyone saves before the host stops the server' },
];

async function session() {
  const s = (await call('settings:set', {})).checklist || {};
  main().innerHTML = head('Session Checklist', 'A quick run-through before each session keeps quests in sync.', '<button class="btn" id="reset">Reset for next session</button>') + `
    <div class="card checklist">${CHECKLIST.map(c => `
      <label class="${s[c.id] ? 'done' : ''}"><input type="checkbox" data-c="${c.id}" ${s[c.id] ? 'checked' : ''}><div><div class="who">${esc(c.who)}</div><div class="what">${esc(c.what)}</div></div></label>`).join('')}
    </div>
    <div class="card"><h2>Stuck quest?</h2><div class="sub">Quest progress syncs from the party leader. If someone's journal is behind, open the console (<span class="mono">~</span>) on <b>their</b> game and type:
      <div class="copyable" style="margin:8px 0"><code>setstage &lt;QuestID&gt; &lt;Stage&gt;</code></div>
      Get the quest ID and the leader's current stage by typing <span class="mono">sqv &lt;QuestID&gt;</span> on the leader's game, or look the quest up on the UESP wiki. Save first.</div></div>`;
  main().querySelectorAll('[data-c]').forEach(c => c.addEventListener('change', async () => {
    s[c.dataset.c] = c.checked;
    c.closest('label').classList.toggle('done', c.checked);
    await call('settings:set', { checklist: s });
  }));
  $('#reset').addEventListener('click', async () => { await call('settings:set', { checklist: {} }); render(); });
}

// ---------- Backups ----------
async function backups() {
  const [list, snaps, usage, prefs] = await Promise.all([call('backups:list'), call('saves:list'), call('backups:usage'), call('settings:set', {})]);
  main().innerHTML = head('Backups', `Your campaign saves, plus everything this app moved or replaced. Restoring puts files back exactly where they were. Using <b>${fmtSize(usage.total)}</b> of disk space.`, '<button class="btn" id="openB">Open backup folder</button>') + `
    <div class="card">
      <div class="card-head"><div><h2>Save snapshots</h2><div class="sub">A copy of your whole Saves folder${usage.saves ? ` (${fmtSize(usage.saves)} in total)` : ''}. A bad sync or crash can't cost you the campaign.</div></div>
        <div class="row"><button class="btn" id="openSaves">Open Saves folder</button><button class="btn primary" id="snapNow">Snapshot saves now</button></div></div>
      <div class="row sub" style="margin-bottom:12px">
        <label class="row" style="cursor:pointer"><span class="switch"><input type="checkbox" id="autoSnap" ${prefs.autoSnapshot ? 'checked' : ''}><span></span></span>Snapshot automatically before every launch</label>
        <span class="spacer"></span>Keep the newest <input type="number" id="keepAuto" min="1" max="100" value="${Number(prefs.keepAutoSnapshots) || 10}" style="width:70px"> automatic ones (yours are never removed)
      </div>
      <div class="row sub" style="margin-bottom:12px">
        <span>Extra copy of every snapshot: ${prefs.extraBackupDir ? `<span class="mono">${esc(prefs.extraBackupDir)}</span>` : '<i>off</i>'}</span>
        <span class="spacer"></span>
        <button class="btn small" id="pickExtra">${prefs.extraBackupDir ? 'Change…' : 'Choose a folder…'}</button>
        ${prefs.extraBackupDir ? '<button class="btn small ghost" id="clearExtra">Turn off</button>' : ''}
      </div>
      ${snaps.length ? `<div class="table-wrap"><table><thead><tr><th>Taken</th><th>Files</th><th>Size</th><th>Note</th><th></th></tr></thead><tbody>
        ${snaps.map((s, i) => `<tr><td>${fmtDate(s.createdAt)} ${s.auto ? '<span class="pill">auto</span>' : ''}</td><td class="sub">${s.files}</td><td class="sub">${fmtSize(s.size)}</td><td class="sub">${esc(s.note || '')}</td>
          <td style="text-align:right;white-space:nowrap"><button class="btn small" data-snap="${i}">Restore</button> <button class="btn small ghost" data-delsnap="${i}" title="Delete this snapshot">✕</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="sub">No snapshots yet.</div>'}
    </div>
    <h3>Moved and replaced files · ${fmtSize(usage.batches)}</h3>` +
    (list.length ? list.map((b, i) => `<div class="card">
      <div class="card-head"><div><h2>${esc(b.label)}</h2><div class="sub">${fmtDate(b.createdAt)} · ${b.files.length} files · ${fmtSize(b.size)} · <span class="pill">${esc(b.category)}</span></div></div>
        <div class="row"><button class="btn ghost danger" data-delbatch="${i}">Delete…</button><button class="btn primary" data-restore="${i}">Restore all</button></div></div>
      <details><summary class="sub" style="cursor:pointer">Files</summary><div class="table-wrap" style="margin-top:8px"><table><tbody>
        ${b.files.map(f => `<tr><td class="mono">${esc(f.rel)}</td><td class="sub">${fmtSize(f.size || 0)}</td><td style="text-align:right"><button class="btn small" data-one="${i}" data-rel="${esc(f.rel)}">Restore</button></td></tr>`).join('')}
      </tbody></table></div></details></div>`).join('') : '<div class="empty">No backups yet.</div>');
  $('#openB').addEventListener('click', () => call('backups:open'));
  $('#openSaves').addEventListener('click', () => call('saves:open'));
  $('#autoSnap').addEventListener('change', e => call('settings:set', { autoSnapshot: e.target.checked }));
  $('#pickExtra').addEventListener('click', async () => {
    const dir = await call('settings:pickBackupDir');
    if (dir) { toast('Every new snapshot is now also copied there', 'ok'); render(); }
  });
  if ($('#clearExtra')) $('#clearExtra').addEventListener('click', async () => { await call('settings:set', { extraBackupDir: null }); render(); });
  $('#keepAuto').addEventListener('change', async e => {
    const r = await call('settings:set', { keepAutoSnapshots: e.target.value });
    e.target.value = r.keepAutoSnapshots;
    toast(`Keeping the newest ${r.keepAutoSnapshots} automatic snapshots`, 'ok');
  });
  main().querySelectorAll('[data-delsnap]').forEach(b => b.addEventListener('click', async () => {
    const s = snaps[Number(b.dataset.delsnap)];
    if (!await confirmBox('Delete this save snapshot?', `The copy from ${fmtDate(s.createdAt)} (${fmtSize(s.size)}) is deleted for good. Your current saves aren't touched.`, 'Delete snapshot')) return;
    await call('saves:delete', s.id);
    toast('Snapshot deleted', 'ok');
    render();
  }));
  main().querySelectorAll('[data-delbatch]').forEach(b => b.addEventListener('click', async () => {
    const batch = list[Number(b.dataset.delbatch)];
    if (!await confirmBox(`Delete "${batch.label}" for good?`, `<b>This can't be undone.</b> The ${batch.files.length} backed-up files (${fmtSize(batch.size)}) are permanently deleted, so you won't be able to restore them. Only do this if you're sure you don't need them.`, 'Delete permanently')) return;
    await call('backups:delete', batch.id);
    toast('Backup deleted', 'ok');
    render();
  }));
  $('#snapNow').addEventListener('click', async e => {
    busy(e.currentTarget, true, 'Copying…');
    try {
      const r = await call('saves:snapshot', 'Manual');
      toast(`Snapshot taken: ${r.files} files, ${fmtSize(r.size)}`, 'ok');
      render();
    } catch { busy(e.currentTarget, false); }
  });
  main().querySelectorAll('[data-snap]').forEach(b => b.addEventListener('click', async () => {
    const s = snaps[Number(b.dataset.snap)];
    if (!await confirmBox('Restore this save snapshot?', `Copies the ${s.files} files from ${fmtDate(s.createdAt)} back into your Saves folder. Your current saves are snapshotted first, so nothing is lost.`, 'Restore saves')) return;
    const r = await call('saves:restore', s.id);
    toast(`Restored ${r.restored} save files`, 'ok');
    render();
  }));
  const done = r => {
    const notes = [
      r.conflicts.length && `${r.conflicts.length} skipped because a file with that name already exists`,
      r.missing && `${r.missing} were no longer in the backup folder`,
    ].filter(Boolean).join('; ');
    toast(`Restored ${r.restored} files${notes ? ` — ${notes}` : ''}`, notes ? '' : 'ok');
    render();
  };
  main().querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', async () => {
    const batch = list[Number(b.dataset.restore)];
    if (!await confirmBox(`Restore "${batch.label}"?`, `${batch.files.length} files go back into the game folder.${batch.category === 'creation-club' ? ' Every player would then need the same Creation Club content.' : ''}`, 'Restore')) return;
    done(await call('backups:restore', batch.id));
  }));
  main().querySelectorAll('[data-one]').forEach(b => b.addEventListener('click', async () => {
    done(await call('backups:restore', list[Number(b.dataset.one)].id, [b.dataset.rel]));
  }));
}

// ---------- Logs ----------
let logTab = 'server';
async function logs() {
  const files = await call('logs:list');
  const tabs = `<div class="tabs" id="logTabs">
      <button data-tab="crashes" class="${logTab === 'crashes' ? 'active' : ''}">Crash reports</button>
      ${files.map(f => `<button data-tab="${f.id}" class="${f.id === logTab ? 'active' : ''}">${esc(f.title)}${f.exists ? '' : ' <span class="pill">none</span>'}</button>`).join('')}</div>`;
  const bindTabs = () => {
    $('#logTabs').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { logTab = b.dataset.tab; render(); }));
    $('#bugReport').addEventListener('click', e => createBugReport(e.currentTarget));
  };

  if (logTab === 'crashes') {
    const c = await call('logs:crashes');
    main().innerHTML = head('Logs', 'Crash reports are summarized here: the error, and the mods that show up most in the crash. A mod being mentioned is a lead, not proof — but it\'s where to start.',
      `<button class="btn" id="bugReport">🐞 Create bug report</button><button class="btn" id="refresh">↻ Refresh</button><button class="btn" id="ack">Mark all as seen</button>`) + tabs +
      (c.reports.length ? c.reports.map((r, i) => `<div class="card">
        <div class="card-head"><div><h2>${fmtDate(r.at)} ${!c.ack || r.at > c.ack ? '<span class="pill warn">new</span>' : ''}</h2>
          <div class="sub mono">${esc(r.name)} · ${esc(r.source)}</div></div>
          <button class="btn small" data-open="${i}">Open full log</button></div>
        ${r.exception ? `<div class="diff error"><div class="lvl">Error</div><div class="mono">${esc(r.exception)}</div></div>` : ''}
        <div class="grid two" style="margin-top:8px">
          <div><h3>SKSE plugins in the call stack</h3>${r.modules.length ? r.modules.map(m => `<div class="diff warn"><div class="lvl">${m.count}×</div><div class="mono">${esc(m.name)}</div></div>`).join('') : '<div class="sub">Only game and Windows code — often a bad mesh, texture or save.</div>'}</div>
          <div><h3>Plugins mentioned</h3>${r.plugins.length ? r.plugins.map(p => `<div class="diff info"><div class="lvl">${p.count}×</div><div class="mono">${esc(p.name)}</div></div>`).join('') : '<div class="sub">No plugins mentioned.</div>'}</div>
        </div></div>`).join('')
        : `<div class="empty">No crash reports found.${c.clientCrashed ? ' Skyrim Together did record a crash in its last session, but there\'s no crash logger to say why.' : ''}<br>Install <b>Crash Logger SSE AE VR</b> from Mods → Stability so the next crash leaves a report.</div>`);
    bindTabs();
    $('#refresh').addEventListener('click', () => render());
    $('#ack').addEventListener('click', async () => { await call('logs:ackCrashes'); toast('Crashes marked as seen', 'ok'); render(); });
    main().querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => call('logs:openCrash', c.reports[Number(b.dataset.open)].file)));
    return;
  }

  const cur = files.find(f => f.id === logTab) || files[0];
  const text = cur.exists ? await call('logs:tail', cur.id) : '';
  main().innerHTML = head('Logs', 'The last 300 lines of each log. Useful when something doesn\'t load or a friend can\'t connect.', `<button class="btn" id="bugReport">🐞 Create bug report</button><button class="btn" id="refresh">↻ Refresh</button><button class="btn" id="openLog" ${cur.exists ? '' : 'disabled'}>Open in editor</button>`) + tabs + `
    <div class="sub" style="margin-bottom:8px">${cur.exists ? `${esc(cur.file)} · updated ${fmtDate(cur.updatedAt)}` : 'This log doesn\'t exist yet — it appears after the game or server runs.'}</div>
    <pre class="log" id="logText">${esc(text)}</pre>`;
  const pre = $('#logText');
  pre.scrollTop = pre.scrollHeight;
  bindTabs();
  $('#refresh').addEventListener('click', () => render());
  $('#openLog').addEventListener('click', () => call('logs:open', cur.id));
}

/** One zip with logs, crash reports and diagnostics (passwords removed), saved to the Desktop. */
async function createBugReport(btn) {
  busy(btn, true, 'Collecting…');
  try {
    const file = await call('report:create');
    toast(`Bug report saved: ${file.split(/[\/]/).pop()} (on your Desktop). Passwords are removed.`, 'ok');
  } catch { /* toast shown */ } finally { busy(btn, false); }
}

// ---------- Settings ----------
async function settings() {
  const [init, nexus, prefs] = await Promise.all([call('app:init'), call('nexus:status'), call('settings:set', {})]);
  main().innerHTML = head('Settings', '') + `
    <div class="card">
      <h2>Skyrim folder</h2>
      <div class="row" style="margin-top:8px"><code class="mono" style="flex:1">${esc(init.gameDir)}</code><button class="btn" id="changeDir">Change…</button></div>
      ${init.detected.length > 1 ? `<div class="sub" style="margin-top:6px">Also found: ${init.detected.filter(d => d !== init.gameDir).map(esc).join(', ')}</div>` : ''}
    </div>
    <div class="card">
      <h2>Nexus Mods</h2>
      <div class="sub">Your personal API key lets the app check for updates and read mod details. It's free — get it from your Nexus account's API keys page. It's stored encrypted with ${isLinux() ? 'your system keyring' : "Windows' secure storage"} and only ever sent to nexusmods.com.
        ${nexus.premium ? '<br><b>Premium detected:</b> installs download directly.' : '<br>Free accounts: installs open the Nexus page, and the app picks up the file from your Downloads folder.'}</div>
      <div class="row" style="margin-top:10px">
        ${nexus.configured && !nexus.error ? `<span class="pill ok">✓ Connected as ${esc(nexus.name)}${nexus.premium ? ' (Premium)' : ''}</span>` : nexus.error ? `<span class="pill err">${esc(nexus.error)}</span>` : '<span class="pill">Not connected</span>'}
      </div>
      <div class="row" style="margin-top:10px">
        <input type="password" id="apikey" placeholder="Paste your Nexus API key" style="flex:1" autocomplete="off">
        <button class="btn primary" id="saveKey">Save key</button>
        <button class="btn" id="getKey">Get my key</button>
        ${nexus.configured ? '<button class="btn ghost" id="clearKey">Remove</button>' : ''}
      </div>
    </div>
    <div class="card">
      <h2>Display</h2>
      <div class="row" style="margin-top:8px"><span class="sub">Size of everything</span>
        <input type="range" id="uiScale" min="0.8" max="1.5" step="0.05" value="${Number(prefs.uiScale) || 1}" style="flex:1;accent-color:var(--gold)" aria-label="Interface size">
        <span class="mono" id="uiScaleVal">${Math.round((Number(prefs.uiScale) || 1) * 100)}%</span></div>
      <div class="sub" style="margin-top:6px">Bigger for the Steam Deck's screen or a TV, smaller to fit more at once.</div>
    </div>
    <div class="card">
      <h2>Help</h2>
      <div class="row" style="margin-top:8px"><button class="btn" id="bugReport">🐞 Create bug report</button>
        <span class="sub">A zip with logs, crash reports and diagnostics on your Desktop — passwords removed — to send to whoever helps you.</span></div>
    </div>
    <div class="card">
      <h2>About</h2>
      <div class="sub">STR Companion ${esc(init.version)} — an unofficial helper for Skyrim Together Reborn. Not affiliated with the Tilted Phoques team, Bethesda or Nexus Mods.</div>
    </div>`;
  $('#changeDir').addEventListener('click', async () => {
    const dir = await call('game:pickDir');
    if (dir) { state.gameDir = dir; toast('Game folder updated', 'ok'); render(); }
  });
  $('#getKey').addEventListener('click', () => call('nexus:openKeyPage'));
  $('#uiScale').addEventListener('input', e => { $('#uiScaleVal').textContent = `${Math.round(e.target.value * 100)}%`; });
  $('#uiScale').addEventListener('change', e => call('settings:set', { uiScale: Number(e.target.value) }));
  $('#bugReport').addEventListener('click', e => createBugReport(e.currentTarget));
  $('#saveKey').addEventListener('click', async e => {
    busy(e.currentTarget, true, 'Checking…');
    try {
      const r = await call('nexus:setKey', $('#apikey').value);
      toast(r.cleared ? 'Key removed' : `Connected as ${r.name}${r.premium ? ' (Premium)' : ''}`, 'ok');
      render();
    } catch { busy(e.currentTarget, false); }
  });
  if ($('#clearKey')) $('#clearKey').addEventListener('click', async () => { await call('nexus:setKey', ''); render(); });
}

// ---------- boot ----------
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal(); });
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

(async () => {
  const init = await api.call('app:init');
  state.gameDir = init.gameDir;
  state.valid = init.valid;
  state.hasNexusKey = init.hasNexusKey;
  state.platform = init.platform;
  state.protonLauncher = init.protonLauncher;
  render();
  // Quietly check GitHub for a newer release; no network, no problem.
  api.call('app:checkUpdate').then(u => { state.update = u; updateFoot(); }).catch(() => {});
})();
