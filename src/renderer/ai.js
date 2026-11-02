'use strict';
/* global api, call, esc, toast, go, render, state, $, busy */
// ---------- AI helper panel ----------
// A chat with the user's own model (Ollama, LM Studio…), docked on the right so it stays open while the
// AI moves between pages. The conversation and the tools live in the main process (ai:* channels);
// this file only shows it and answers the Allow/Deny questions.

const aiUi = { open: false, view: 'chat', settings: null, items: [], busy: false, draft: '', conn: null, paintQueued: false };

const AI_ASKS = [
  ['🩺 What\'s wrong with my setup?', 'Check my setup and tell me if anything is wrong or risky for co-op, and how to fix it.'],
  ['🤝 Get me ready for co-op', 'Get my game ready to play Skyrim Together with my friends: check everything, tell me what you would change, then do it.'],
  ['💥 Why did my game crash?', 'Look at my latest crash report and logs and tell me the most likely cause and what to do.'],
  ['🖧 Help me host a server', 'I want to host the server for my friends. Check my server settings, port and network, and tell me what my friends need to connect.'],
  ['⚙ Explain my server settings', 'Explain my current Skyrim Together server settings in plain words and suggest anything worth changing for a story playthrough.'],
];

// Friendly words for what the AI is doing.
const AI_TOOL_WORDS = {
  get_overview: 'Checked your setup', get_load_order: 'Read the load order', list_mods: 'Looked at your mods', check_mod_updates: 'Checked Nexus for updates',
  cleanup_report: 'Looked at what can be cleaned up', read_config: 'Read a config file', list_presets: 'Looked at presets', list_backups: 'Looked at backups',
  read_log: 'Read a log', get_crash_reports: 'Read crash reports', get_server_session: 'Checked the server', get_network_info: 'Checked the network',
  get_my_setup_code: 'Got your setup code', compare_setup_code: 'Compared setup codes', list_party: 'Looked at your party', quick_setup_plan: 'Planned Quick Setup',
  get_steam_status: 'Checked Steam', get_app_settings: 'Read app settings', open_page: 'Opened a page',
};

/** Minimal, safe Markdown: everything is escaped first, then a few constructs are turned back on. */
function aiMarkdown(src) {
  const blocks = [];
  let s = String(src || '').replace(/```[^\n]*\n([\s\S]*?)(?:```|$)/g, (_, code) => { blocks.push(code); return `\n\u0000${blocks.length - 1}\u0000\n`; });
  s = esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/gm, '$1<i>$2</i>');
  const out = [];
  let list = null;
  for (const line of s.split('\n')) {
    const block = line.match(/^\u0000(\d+)\u0000$/);
    const li = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)/);
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (li) {
      const tag = li[1] ? 'ol' : 'ul';
      if (list !== tag) { if (list) out.push(`</${list}>`); out.push(`<${tag}>`); list = tag; }
      out.push(`<li>${li[2]}</li>`);
      continue;
    }
    if (list) { out.push(`</${list}>`); list = null; }
    if (block) out.push(`<pre><code>${esc(blocks[Number(block[1])].replace(/\n$/, ''))}</code></pre>`);
    else if (h) out.push(`<h4>${h[1]}</h4>`);
    else if (line.trim()) out.push(`<p>${line}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join('');
}

/** Splits inline <think>…</think> (Qwen and other reasoning models) from the answer, and hides text-mode tool calls. */
function aiSplit(text) {
  let thinking = '', answer = String(text || '');
  const m = answer.match(/^\s*<think>([\s\S]*?)(?:<\/think>|$)/);
  if (m) { thinking = m[1].trim(); answer = answer.slice(m[0].length); }
  answer = answer.replace(/```tool[^\n]*\n[\s\S]*?(?:```|$)|<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, '').trim();
  return { thinking, answer };
}

function aiItemHtml(it, i) {
  if (it.kind === 'user') return `<div class="ai-msg user">${esc(it.text)}</div>`;
  if (it.kind === 'notice') return `<div class="ai-note">${esc(it.text)}</div>`;
  if (it.kind === 'error') return `<div class="ai-note err">⚠ ${esc(it.text)}</div>`;
  if (it.kind === 'assistant') {
    const { thinking, answer } = aiSplit(it.text);
    const think = (it.thinking || '') + (thinking ? (it.thinking ? '\n' : '') + thinking : '');
    if (!answer && !think) return aiUi.busy && i === aiUi.items.length - 1 ? '<div class="ai-msg bot"><span class="spinner"></span></div>' : '';
    return `<div class="ai-msg bot">${think ? `<details class="ai-think"><summary>${answer ? 'Thought about it' : 'Thinking…'}</summary>${esc(think)}</details>` : ''}${aiMarkdown(answer)}</div>`;
  }
  if (it.kind === 'tool') {
    const read = it.risk === 'read';
    const label = read ? (AI_TOOL_WORDS[it.name] || it.name.replace(/_/g, ' ')) : (it.text || it.name.replace(/_/g, ' '));
    if (it.status === 'confirm') {
      return `<div class="ai-confirm ${it.risk === 'ask' ? 'strong' : ''}">
        <div><b>The AI wants to:</b> ${esc(it.text)}</div>
        <div class="sub">${it.risk === 'ask' ? 'This one always asks.' : 'Anything it changes is backed up first, so it can be undone from Backups.'}</div>
        <div class="row"><button class="btn small primary" data-approve="${esc(it.id)}">Allow</button><button class="btn small" data-deny="${esc(it.id)}">Don't</button></div></div>`;
    }
    const icon = { running: '<span class="spinner"></span>', done: '✓', error: '✕', denied: '⊘' }[it.status] || '•';
    return `<div class="ai-tool ${esc(it.status)}"><span class="i">${icon}</span><span>${esc(label)}${it.status === 'denied' ? ' — you said no' : ''}${it.error ? `<span class="sub"> — ${esc(it.error)}</span>` : ''}</span></div>`;
  }
  return '';
}

function aiPaint() {
  if (aiUi.paintQueued) return;
  aiUi.paintQueued = true;
  requestAnimationFrame(() => {
    aiUi.paintQueued = false;
    const list = $('#aiList');
    if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.innerHTML = aiUi.items.length ? aiUi.items.map(aiItemHtml).join('') : aiEmptyHtml();
    if (nearBottom) list.scrollTop = list.scrollHeight;
    const send = $('#aiSend');
    if (send) { send.textContent = aiUi.busy ? 'Stop' : 'Send'; send.classList.toggle('danger', aiUi.busy); }
  });
}

function aiEmptyHtml() {
  const s = aiUi.settings || {};
  return `<div class="ai-empty">
    <p>Ask anything about your Skyrim Together setup. The AI can look at every part of the app${s.allowChanges ? ' and make changes for you — ' + (s.autoApprove ? 'without asking each time' : 'after you allow each one') : ' (changes are off: it only looks and explains)'}.</p>
    <div class="ai-asks">${AI_ASKS.map(([label], i) => `<button class="btn small" data-ask="${i}">${esc(label)}</button>`).join('')}</div>
  </div>`;
}

function aiPanelHtml() {
  const s = aiUi.settings || {};
  const head = `<div class="ai-head"><b>✧ AI Helper</b>${s.model ? `<span class="pill" title="Model">${esc(s.model)}</span>` : ''}<span class="spacer"></span>
    <button class="btn ghost small" id="aiNew" title="Start a new chat">New chat</button>
    <button class="btn ghost small" id="aiCfg" title="AI settings">⚙</button>
    <button class="btn ghost small" id="aiClose" title="Close (Ctrl+K)">✕</button></div>`;
  if (aiUi.view === 'settings' || !s.url) return head + aiSettingsHtml();
  return head + `<div class="ai-list" id="aiList"></div>
    <div class="ai-compose"><textarea id="aiInput" rows="2" placeholder="Ask about your setup, or tell it what to do…">${esc(aiUi.draft)}</textarea>
    <button class="btn primary" id="aiSend">${aiUi.busy ? 'Stop' : 'Send'}</button></div>`;
}

function aiSettingsHtml() {
  const s = aiUi.settings || {};
  const c = aiUi.conn;
  const models = c && c.models ? c.models : (s.model ? [s.model] : []);
  return `<div class="ai-settings">
    <h3>Connect your own AI</h3>
    <div class="sub">The helper uses a model running on your computer (or your home network) — nothing goes to the cloud. Install <b>Ollama</b> (ollama.com) and run <code>ollama pull qwen3:8b</code>, or load a model in <b>LM Studio</b> and start its server. Models with tool support work best: Qwen 3, Llama 3.1+, Mistral Small.</div>
    <div class="row" style="margin-top:10px">${(s.presets || []).map(p => `<button class="btn small" data-preset="${esc(p.url)}">${esc(p.name)}</button>`).join('')}</div>
    <div class="row" style="margin-top:8px"><input type="text" id="aiUrl" value="${esc(c && c.url !== undefined ? c.url : s.url || '')}" placeholder="http://localhost:11434" style="flex:1"><button class="btn" id="aiConnect">Connect</button></div>
    <div id="aiConnMsg" class="sub" style="margin-top:6px">${c && c.error ? `<span class="pill err">${esc(c.error)}</span>` : c && c.kind ? `<span class="pill ok">✓ Connected (${c.kind === 'ollama' ? 'Ollama' : 'OpenAI-compatible server'}, ${c.models.length} model${c.models.length === 1 ? '' : 's'})</span>` : ''}
      ${c && c.local === false ? '<div class="pill err" style="margin-top:6px">This address isn\'t on your computer or home network: your questions and setup details will be sent there.</div>' : ''}</div>
    <details style="margin-top:8px" ${s.hasKey ? 'open' : ''}><summary class="sub" style="cursor:pointer">API key ${s.hasKey ? '(saved)' : '(only if your server asks for one)'}</summary>
      <div class="row" style="margin-top:6px"><input type="password" id="aiKey" value="${esc(aiUi.pendingKey || '')}" placeholder="${s.hasKey ? 'Saved — type to replace' : 'Usually not needed for Ollama or LM Studio'}" style="flex:1" autocomplete="off">${s.hasKey ? '<button class="btn small ghost" id="aiKeyClear">Remove</button>' : ''}</div></details>
    <label class="sub" style="display:block;margin-top:10px">Model</label>
    <select id="aiModel" style="width:100%">${models.length ? '' : '<option value="">Connect first (or leave empty for the server\'s first model)</option>'}${models.map(m => `<option ${m === s.model ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
    ${(c ? c.kind : null) === 'ollama' || /:11434/.test(s.url || '') ? `<label class="sub" style="display:block;margin-top:10px">Memory (context size) — more lets it read more, but needs more RAM/VRAM</label>
    <select id="aiCtx" style="width:100%">${[8192, 16384, 32768, 65536].map(n => `<option value="${n}" ${n === (s.numCtx || 16384) ? 'selected' : ''}>${n / 1024}K tokens${n === 16384 ? ' (recommended)' : ''}</option>`).join('')}</select>` : '<div class="sub" style="margin-top:8px">LM Studio: load the model with a context length of 16K or more.</div>'}
    <label class="row toggle" style="margin-top:14px;cursor:pointer"><span class="switch"><input type="checkbox" id="aiAllow" ${s.allowChanges ? 'checked' : ''}><span></span></span><span><b>Let the AI make changes</b><br><span class="sub">Edit INI files and server settings, fix problems, move mods to backup, start the server… Off: it only looks and explains.</span></span></label>
    <label class="row toggle" style="margin-top:8px;cursor:pointer"><span class="switch"><input type="checkbox" id="aiAuto" ${s.autoApprove ? 'checked' : ''} ${s.allowChanges ? '' : 'disabled'}><span></span></span><span><b>Don't ask before each change</b><br><span class="sub">For hands-off automation. Restoring saves, Quick Setup and Steam changes still ask. Everything it changes is backed up first.</span></span></label>
    <label class="sub" style="display:block;margin-top:12px">Extra instructions for the AI (optional)</label>
    <textarea id="aiNote" rows="3" style="width:100%" placeholder="e.g. We are 3 players on Master difficulty. Answer in German.">${esc(s.note || '')}</textarea>
    <div class="row" style="margin-top:14px"><button class="btn primary" id="aiSave">Save</button>${s.url ? '<button class="btn" id="aiBack">Back to chat</button>' : ''}</div>
  </div>`;
}

function aiMount() {
  const panel = $('#aiPanel');
  panel.innerHTML = aiPanelHtml();
  $('#aiClose').addEventListener('click', () => aiToggle(false));
  $('#aiCfg').addEventListener('click', () => { aiUi.view = aiUi.view === 'settings' ? 'chat' : 'settings'; aiUi.conn = null; aiMount(); });
  $('#aiNew').addEventListener('click', async () => {
    await call('ai:reset');
    aiUi.items = [];
    aiUi.view = 'chat';
    aiMount();
  });
  if ($('#aiList')) {
    aiPaint();
    const input = $('#aiInput');
    input.addEventListener('input', () => { aiUi.draft = input.value; });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSend(); } });
    $('#aiSend').addEventListener('click', () => (aiUi.busy ? call('ai:stop') : aiSend()));
    $('#aiList').addEventListener('click', e => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.ask) aiSend(AI_ASKS[Number(t.dataset.ask)][1]);
      if (t.dataset.approve || t.dataset.deny) {
        const id = t.dataset.approve || t.dataset.deny;
        const it = aiUi.items.find(x => x.id === id);
        if (it) { it.status = 'running'; aiPaint(); }
        call('ai:approve', id, !!t.dataset.approve).catch(() => {});
      }
    });
    setTimeout(() => input.focus(), 0);
    return;
  }
  // Settings view
  panel.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => { $('#aiUrl').value = b.dataset.preset; aiConnect(); }));
  $('#aiConnect').addEventListener('click', () => aiConnect());
  $('#aiAllow').addEventListener('change', e => { $('#aiAuto').disabled = !e.target.checked; if (!e.target.checked) $('#aiAuto').checked = false; });
  if ($('#aiKeyClear')) $('#aiKeyClear').addEventListener('click', async () => { aiUi.settings = { ...aiUi.settings, ...(await call('ai:setSettings', { apiKey: '' })) }; aiMount(); });
  if ($('#aiBack')) $('#aiBack').addEventListener('click', () => { aiUi.view = 'chat'; aiMount(); });
  $('#aiSave').addEventListener('click', async e => {
    busy(e.currentTarget, true, 'Saving…');
    try {
      aiUi.settings = { ...aiUi.settings, ...(await call('ai:setSettings', {
        url: $('#aiUrl').value, model: $('#aiModel').value,
        allowChanges: $('#aiAllow').checked, autoApprove: $('#aiAuto').checked, note: $('#aiNote').value,
        ...($('#aiKey').value.trim() ? { apiKey: $('#aiKey').value } : {}),
        ...($('#aiCtx') ? { numCtx: Number($('#aiCtx').value) } : {}),
      })) };
      aiUi.view = 'chat';
      aiUi.conn = null;
      aiUi.pendingKey = '';
      aiMount();
    } catch { busy(e.currentTarget, false); }
  });
}

async function aiConnect() {
  const url = $('#aiUrl').value;
  // Connect re-draws the form; keep what was typed.
  aiUi.pendingKey = $('#aiKey').value;
  const btn = $('#aiConnect');
  busy(btn, true, 'Connecting…');
  try {
    const r = await api.call('ai:models', url, $('#aiKey').value);
    aiUi.conn = { url, ...r };
    // A model the user picked before stays picked if the server still has it.
    if (!r.models.includes(aiUi.settings.model)) aiUi.settings.model = r.models[0] || '';
  } catch (e) {
    aiUi.conn = { url, error: e.message };
  }
  const keep = { allowChanges: $('#aiAllow').checked, autoApprove: $('#aiAuto').checked, note: $('#aiNote').value };
  aiUi.settings = { ...aiUi.settings, ...keep };
  aiMount();
}

async function aiSend(text) {
  text = String(text ?? $('#aiInput').value).trim();
  if (!text || aiUi.busy) return;
  aiUi.items.push({ kind: 'user', text });
  aiUi.draft = '';
  if ($('#aiInput')) $('#aiInput').value = '';
  aiUi.busy = true;
  aiPaint();
  try {
    await api.call('ai:chat', text, state.page);
  } catch (e) {
    aiUi.busy = false;
    aiUi.items.push({ kind: 'error', text: e.message });
    aiPaint();
  }
}

/** Opens the panel with a question, e.g. from a page's "Ask the AI" button. */
async function aiAsk(text) {
  await aiToggle(true);
  if (aiUi.settings && aiUi.settings.url) aiSend(text);
}

let aiChangedTimer = null;
function aiOnEvent(ev) {
  const last = aiUi.items[aiUi.items.length - 1];
  switch (ev.type) {
    case 'turn':
      if (!(last && last.kind === 'assistant' && !last.text && !last.thinking)) aiUi.items.push({ kind: 'assistant', text: '', thinking: '' });
      break;
    case 'text':
    case 'thinking': {
      let a = last && last.kind === 'assistant' ? last : null;
      if (!a) aiUi.items.push(a = { kind: 'assistant', text: '', thinking: '' });
      if (ev.type === 'text') a.text += ev.text; else a.thinking += ev.text;
      break;
    }
    case 'tool': {
      let it = aiUi.items.find(x => x.kind === 'tool' && x.id === ev.id);
      if (!it) aiUi.items.push(it = { kind: 'tool', id: ev.id, name: ev.name });
      Object.assign(it, pickDefined(ev, ['status', 'risk', 'error']));
      if (ev.text) it.text = ev.text;
      if (ev.status === 'confirm' && !aiUi.open) aiToggle(true);
      break;
    }
    case 'notice': aiUi.items.push({ kind: 'notice', text: ev.text }); break;
    case 'error': aiUi.items.push({ kind: 'error', text: ev.message }); break;
    case 'done': aiUi.busy = false; break;
    case 'navigate': if (ev.page && ev.page !== state.page && state.valid) go(ev.page); break;
    case 'changed':
      // Show the change on the page behind the panel, unless a dialog is open.
      clearTimeout(aiChangedTimer);
      aiChangedTimer = setTimeout(() => { if ($('#modal').classList.contains('hidden') && state.valid) render(); }, 700);
      break;
  }
  aiPaint();
}
const pickDefined = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

async function aiToggle(open = !aiUi.open) {
  aiUi.open = open;
  $('#aiPanel').hidden = !open;
  document.body.classList.toggle('ai-open', open);
  $('#aiToggle').classList.toggle('active', open);
  if (!open) return;
  if (!aiUi.settings) {
    try { aiUi.settings = await api.call('ai:getSettings'); } catch (e) { aiUi.settings = { presets: [] }; toast(e.message, 'err'); }
  }
  aiMount();
}

$('#aiToggle').addEventListener('click', () => aiToggle());
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); aiToggle(); }
});
api.on('ai:event', aiOnEvent);
