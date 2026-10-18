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

function modal(html, onMount) {
  $('#modalCard').innerHTML = html;
  $('#modal').classList.remove('hidden');
  const close = () => $('#modal').classList.add('hidden');
  $('#modalCard').querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  if (onMount) onMount($('#modalCard'), close);
  return close;
}

function confirmBox(title, body, okLabel = 'Continue') {
  return new Promise(resolve => {
    modal(`<h2>${esc(title)}</h2><div class="sub">${body}</div>
      <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="okBtn">${esc(okLabel)}</button></div>`,
    (card, close) => {
      card.querySelector('[data-close]').addEventListener('click', () => resolve(false));
      card.querySelector('#okBtn').addEventListener('click', () => { close(); resolve(true); });
    });
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
  const pages = { dashboard, play, mods, cleanup, config, friends, session, backups, logs, settings };
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
  if (u) u.addEventListener('click', () => call('shell:external', state.update.url));
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
    <div class="grid stats">
      <div class="stat ${verdict[0]}"><div class="k">Status</div><div class="v">${verdict[1]}</div><div class="d">${verdict[2]}</div></div>
      <div class="stat"><div class="k">Skyrim</div><div class="v">${esc(s.gameVersion || '?')}</div><div class="d">${s.autoUpdate ? esc(s.autoUpdate.label) : ''}</div></div>
      <div class="stat ${s.str.installed ? '' : 'bad'}"><div class="k">Skyrim Together</div><div class="v">${s.str.installed ? esc(s.str.version || 'Installed') : 'Missing'}</div><div class="d">${s.manager ? 'Managed by ' + esc(s.manager) : ''}</div></div>
      <div class="stat"><div class="k">Plugins loaded</div><div class="v">${s.pluginCount}</div><div class="d">${s.ccRemovable ? s.ccRemovable + ' Anniversary add-ons' : 'No extra AE content'}</div></div>
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
  main().querySelectorAll('[data-fix]').forEach(b => b.addEventListener('click', async () => {
    const fix = checks[Number(b.dataset.fix)].fix;
    if (fix.action === 'goto') return go(fix.page);
    if (fix.action === 'backupCC') {
      const ok = await confirmBox('Move Anniversary Edition content to backup?', `The ${s.ccRemovable} paid/AE add-ons will be moved to the backup folder. The 4 free files USSEP needs stay. You can restore them any time from Backups.`, 'Move to backup');
      if (!ok) return;
    }
    busy(b, true);
    try {
      const r = await call('fix:run', fix);
      toast(r && r.moved !== undefined ? `Moved ${r.moved} files to backup` : r && r.restored !== undefined ? `Restored ${r.restored} files` : 'Done', 'ok');
      render();
    } catch { busy(b, false); }
  }));
}

// ---------- Play & Server ----------
async function play() {
  const [st, net] = await Promise.all([call('launch:status'), call('net:info')]);
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
        ${isLinux() && state.protonLauncher === false ? `<div class="callout"><b>protontricks is needed on Linux</b> to start Skyrim Together inside Skyrim's Proton prefix. Install it from your distro or Flathub (<span class="mono">com.github.Matoking.protontricks</span>).</div>` : ''}
        <div class="callout blue"><b>Connecting:</b> In game, press <b>F2</b> (or Right-Ctrl) to open the Skyrim Together menu and use <b>Connect</b>. Friends enter your IP and port plus the join password.</div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Your server</h2><div class="row">
          <button class="btn primary" id="startSrv" ${st.server ? 'disabled' : ''}>Start server</button>
          <button class="btn danger" id="stopSrv" ${st.server ? '' : 'disabled'}>Stop</button></div></div>
        <div class="sub">Share these with your friends:</div>
        <div class="copyable"><code id="ipLine">Public IP hidden — click Show</code><button class="btn small" id="showIp">Show</button><button class="btn small" id="copyIp">Copy</button></div>
        <div class="sub">On the same Wi-Fi / LAN: <span class="mono">${esc(net.local.join(', ') || 'unknown')}</span></div>
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
  $('#launch').addEventListener('click', async e => {
    busy(e.currentTarget, true, 'Launching…');
    try {
      const r = await call('launch:client');
      toast(r.steamStarted ? 'Starting Steam and Skyrim Together…' : 'Launching Skyrim Together…', 'ok');
    } finally { setTimeout(() => busy($('#launch'), false), 3000); }
  });
  $('#startSrv').addEventListener('click', async () => { await call('launch:server'); toast('Server starting in its own window', 'ok'); setTimeout(render, 2500); });
  $('#stopSrv').addEventListener('click', async () => {
    if (!await confirmBox('Stop the server?', 'Everyone connected will be disconnected. Make sure the party leader has saved.', 'Stop server')) return;
    await call('launch:stopServer'); toast('Server stopped'); setTimeout(render, 1500);
  });

  const refreshSession = async () => {
    const [s, procs] = await Promise.all([api.call('server:session').catch(() => null), api.call('launch:status').catch(() => ({}))]);
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
  await refreshSession();
  state.timers.push(setInterval(refreshSession, 5000));
  state.timers.push(setInterval(async () => {
    const s = await api.call('launch:status').catch(() => null);
    if (!s || !$('#procStatus')) return;
    $('#procStatus').innerHTML = `${pill(s.steam, 'Steam')} ${pill(s.client || s.game, 'Skyrim')} ${pill(s.server, 'Server')} ${s.vortex ? '<span class="pill warn">Vortex is open — avoid deploying while playing</span>' : ''}`;
    $('#startSrv').disabled = s.server; $('#stopSrv').disabled = !s.server;
    setLaunchState(s);
  }, 4000));
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
  $('#showAll').addEventListener('change', e => { cfgShowAll = e.target.checked; render(); });
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
  const mine = await call('share:mine');
  main().innerHTML = head('Friends Sync', 'Mismatched setups are the #1 cause of desync in Skyrim Together. Each player copies their setup code and posts it in your group chat; paste a friend\'s code here to see what differs.') + `
    <div class="grid two">
      <div class="card">
        <h2>Your setup code</h2>
        <div class="sub">Contains your game version, Skyrim Together version, plugin list and SKSE plugins — nothing personal.</div>
        <div class="row" style="margin:12px 0"><span class="sub">Your name in codes:</span><input type="text" id="pname" value="${esc(mine.setup.playerName || '')}" style="flex:1"></div>
        <div class="copyable"><code>${esc(mine.code)}</code><button class="btn primary small" id="copyCode">Copy</button></div>
        <h3>What's in it</h3>
        <div class="sub">Skyrim ${esc(mine.setup.gameVersion)} · Skyrim Together ${esc(mine.setup.strVersion || '?')} · SKSE ${esc(mine.setup.skseVersion || 'none')} · ${mine.setup.plugins.length} plugins · ${mine.setup.sksePlugins.length} SKSE plugins</div>
      </div>
      <div class="card">
        <h2>Compare with a friend</h2>
        <textarea id="theirCode" rows="4" placeholder="Paste a friend's STR1-… code here"></textarea>
        <div class="row" style="margin-top:10px"><button class="btn primary" id="compare">Compare</button></div>
        <div id="result" style="margin-top:14px"></div>
      </div>
    </div>`;
  $('#copyCode').addEventListener('click', () => copy(mine.code));
  $('#pname').addEventListener('change', async e => { await call('settings:set', { playerName: e.target.value.trim() }); render(); });
  $('#compare').addEventListener('click', async () => {
    const r = await call('share:compare', $('#theirCode').value);
    const who = esc(r.theirs.playerName || 'Your friend');
    $('#result').innerHTML = !r.diffs.length
      ? `<div class="callout blue">✓ <b>${who}</b> has exactly the same setup. You're good to go.</div>`
      : `<div class="sub" style="margin-bottom:8px"><b>${who}</b> — ${r.diffs.filter(d => d.level === 'error').length} must-fix, ${r.diffs.filter(d => d.level !== 'error').length} minor</div>` +
        r.diffs.map(d => `<div class="diff ${d.level}"><div class="lvl">${{ error: 'Fix', warn: 'Check', info: 'FYI' }[d.level]}</div><div>${esc(d.text)}</div></div>`).join('');
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
  const [list, snaps] = await Promise.all([call('backups:list'), call('saves:list')]);
  main().innerHTML = head('Backups', 'Your campaign saves, plus everything this app moved or replaced. Restoring puts files back exactly where they were.', '<button class="btn" id="openB">Open backup folder</button>') + `
    <div class="card">
      <div class="card-head"><div><h2>Save snapshots</h2><div class="sub">A copy of your whole Saves folder. Take one before each session — a bad sync or crash can't cost you the campaign.</div></div>
        <div class="row"><button class="btn" id="openSaves">Open Saves folder</button><button class="btn primary" id="snapNow">Snapshot saves now</button></div></div>
      ${snaps.length ? `<div class="table-wrap"><table><thead><tr><th>Taken</th><th>Files</th><th>Size</th><th>Note</th><th></th></tr></thead><tbody>
        ${snaps.map((s, i) => `<tr><td>${fmtDate(s.createdAt)}</td><td class="sub">${s.files}</td><td class="sub">${fmtSize(s.size)}</td><td class="sub">${esc(s.note || '')}</td><td style="text-align:right"><button class="btn small" data-snap="${i}">Restore</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="sub">No snapshots yet.</div>'}
    </div>
    <h3>Moved and replaced files</h3>` +
    (list.length ? list.map((b, i) => `<div class="card">
      <div class="card-head"><div><h2>${esc(b.label)}</h2><div class="sub">${fmtDate(b.createdAt)} · ${b.files.length} files · ${fmtSize(b.size)} · <span class="pill">${esc(b.category)}</span></div></div>
        <button class="btn primary" data-restore="${i}">Restore all</button></div>
      <details><summary class="sub" style="cursor:pointer">Files</summary><div class="table-wrap" style="margin-top:8px"><table><tbody>
        ${b.files.map(f => `<tr><td class="mono">${esc(f.rel)}</td><td class="sub">${fmtSize(f.size || 0)}</td><td style="text-align:right"><button class="btn small" data-one="${i}" data-rel="${esc(f.rel)}">Restore</button></td></tr>`).join('')}
      </tbody></table></div></details></div>`).join('') : '<div class="empty">No backups yet.</div>');
  $('#openB').addEventListener('click', () => call('backups:open'));
  $('#openSaves').addEventListener('click', () => call('saves:open'));
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
  const done = r => { toast(`Restored ${r.restored} files${r.conflicts.length ? ` — ${r.conflicts.length} skipped because a file with that name already exists` : ''}`, r.conflicts.length ? '' : 'ok'); render(); };
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
  const cur = files.find(f => f.id === logTab) || files[0];
  const text = cur.exists ? await call('logs:tail', cur.id) : '';
  main().innerHTML = head('Logs', 'The last 300 lines of each log. Useful when something doesn\'t load or a friend can\'t connect.', `<button class="btn" id="refresh">↻ Refresh</button><button class="btn" id="openLog" ${cur.exists ? '' : 'disabled'}>Open in editor</button>`) + `
    <div class="tabs" id="logTabs">${files.map(f => `<button data-tab="${f.id}" class="${f.id === cur.id ? 'active' : ''}">${esc(f.title)}${f.exists ? '' : ' <span class="pill">none</span>'}</button>`).join('')}</div>
    <div class="sub" style="margin-bottom:8px">${cur.exists ? `${esc(cur.file)} · updated ${fmtDate(cur.updatedAt)}` : 'This log doesn\'t exist yet — it appears after the game or server runs.'}</div>
    <pre class="log" id="logText">${esc(text)}</pre>`;
  const pre = $('#logText');
  pre.scrollTop = pre.scrollHeight;
  $('#logTabs').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { logTab = b.dataset.tab; render(); }));
  $('#refresh').addEventListener('click', () => render());
  $('#openLog').addEventListener('click', () => call('logs:open', cur.id));
}

// ---------- Settings ----------
async function settings() {
  const init = await call('app:init');
  const nexus = await call('nexus:status');
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
      <h2>About</h2>
      <div class="sub">STR Companion ${esc(init.version)} — an unofficial helper for Skyrim Together Reborn. Not affiliated with the Tilted Phoques team, Bethesda or Nexus Mods.</div>
    </div>`;
  $('#changeDir').addEventListener('click', async () => {
    const dir = await call('game:pickDir');
    if (dir) { state.gameDir = dir; toast('Game folder updated', 'ok'); render(); }
  });
  $('#getKey').addEventListener('click', () => call('nexus:openKeyPage'));
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
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#modal').classList.add('hidden'); });
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });

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
