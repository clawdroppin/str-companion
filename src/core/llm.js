'use strict';
// Local LLM client for OpenAI-compatible servers (LM Studio, Ollama, llama.cpp server, …).
// Pure Node, no Electron imports, so it is unit-tested like the rest of core/.

const http = require('http');
const https = require('https');
const { URL } = require('url');

/** Accepts "localhost:1234", "http://localhost:1234", "http://localhost:1234/v1/" and such. */
function normalizeBase(url) {
  let u = String(url || '').trim();
  if (!u) throw new Error('Enter the server address first.');
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  try {
    const parsed = new URL(u);
    if (!parsed.hostname) throw new Error('no host');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    throw new Error(`That doesn't look like a server address: ${url}`);
  }
}

/**
 * One HTTP request. Resolves { status, headers, body } (body is a Buffer).
 * `timeoutMs` applies until the first byte and then as an idle timeout between bytes,
 * so a slow model that keeps streaming is never cut off.
 */
function request(url, { method = 'GET', headers = {}, body = null, signal = null, timeoutMs = 60000, maxBytes = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method,
      headers: { 'User-Agent': 'STR-Companion', ...headers },
      body,
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', d => {
        size += d.length;
        if (size > maxBytes) { req.destroy(new Error('Response too large')); return; }
        chunks.push(d);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('The local LLM server stopped responding.')));
    if (signal) {
      if (signal.aborted) { req.destroy(new Error('Cancelled')); return; }
      signal.addEventListener('abort', () => req.destroy(new Error('Cancelled')), { once: true });
    }
    if (body) req.write(body);
    req.end();
  });
}

/** Connection-level failures, phrased so a user can act on them. */
function friendlyNetworkError(e, base) {
  if (/^Cancelled$/.test(e.message)) return e;
  if (e.code === 'ECONNREFUSED') return new Error(`Nothing is listening at ${base}. Start the server (LM Studio: Developer tab → Start Server) and try again.`);
  if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return new Error(`Could not reach ${new URL(base).hostname}. Check the address.`);
  return e;
}

/** GET /models — used to test a connection and to offer the model list. */
async function listModels(cfg, { signal, timeoutMs = 10000 } = {}) {
  const base = normalizeBase(cfg.baseUrl);
  const headers = { Accept: 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  let r;
  try {
    r = await request(`${base}/models`, { headers, signal, timeoutMs });
  } catch (e) {
    throw friendlyNetworkError(e, base);
  }
  if (r.status !== 200) throw new Error(`The server answered ${r.status}. ${r.body.toString('utf8').slice(0, 200)}`);
  let data;
  try { data = JSON.parse(r.body.toString('utf8')); } catch { throw new Error('The server did not answer with a model list.'); }
  const models = (data.data || []).map(m => m.id || m.name).filter(Boolean);
  if (!models.length) throw new Error('The server is running but has no models loaded.');
  return models;
}

/**
 * One chat completion. Streams when the server supports it (LM Studio, Ollama and llama.cpp all do)
 * and calls onDelta with each text piece; falls back to a plain request if streaming is refused.
 * Returns { content, toolCalls: [{ id, name, arguments }], finishReason }.
 */
async function chatCompletion(cfg, { messages, tools = null, temperature, maxTokens, signal, onDelta = null, timeoutMs = 60000 } = {}) {
  const base = normalizeBase(cfg.baseUrl);
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const payload = { model: cfg.model, messages, stream: true };
  if (tools && tools.length) payload.tools = tools;
  if (temperature !== undefined) payload.temperature = temperature;
  if (maxTokens) payload.max_tokens = maxTokens;

  let r;
  try {
    r = await request(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(payload), signal, timeoutMs });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw friendlyNetworkError(e, base);
  }

  if (r.status !== 200 && r.status !== 204) {
    const text = r.body.toString('utf8').slice(0, 300);
    // Some servers reject "stream": true; one plain retry covers them.
    if (r.status >= 400 && r.status < 500) {
      const plain = await request(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({ ...payload, stream: false }),
        signal,
        timeoutMs,
      });
      if (plain.status === 200) return parseCompletion(plain.body.toString('utf8'), onDelta);
      throw new Error(`The server answered ${plain.status}: ${plain.body.toString('utf8').slice(0, 300)}`);
    }
    throw new Error(`The server answered ${r.status}: ${text}`);
  }

  return parseSse(r.body.toString('utf8'), onDelta);
}

/** Parses a non-streamed chat completion body. */
function parseCompletion(text, onDelta) {
  const data = JSON.parse(text);
  const choice = (data.choices || [])[0] || {};
  const message = choice.message || {};
  const content = message.content || '';
  if (onDelta && content) onDelta(content);
  return { content, toolCalls: normalizeToolCalls(message.tool_calls), finishReason: choice.finish_reason || null };
}

/**
 * Parses a streamed (SSE) chat completion. `onDelta` receives each text piece as it arrives.
 * Tool calls arrive as fragments indexed by position and are reassembled here.
 */
function parseSse(text, onDelta) {
  let content = '';
  let finishReason = null;
  const calls = new Map(); // index -> { id, name, arguments }
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith('data:')) continue;
    const data = l.slice(5).trim();
    if (data === '[DONE]') break;
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }
    const choice = (ev.choices || [])[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) { content += delta.content; if (onDelta) onDelta(delta.content); }
    for (const tc of delta.tool_calls || []) {
      const slot = calls.get(tc.index) || { id: '', name: '', arguments: '' };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.arguments += tc.function.arguments;
      calls.set(tc.index, slot);
    }
  }
  return { content, toolCalls: normalizeToolCalls([...calls.values()]), finishReason };
}

function normalizeToolCalls(raw) {
  // Two shapes arrive here: reassembled stream fragments ({ id, name, arguments })
  // and the raw API shape from a non-streamed answer ({ id, type, function: { name, arguments } }).
  return (raw || [])
    .map(tc => (tc && tc.function && !tc.name) ? { id: tc.id, name: tc.function.name, arguments: tc.function.arguments } : tc)
    .filter(tc => tc && tc.name)
    .map(tc => {
      let args = {};
      try { args = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { args = { _raw: tc.arguments }; }
      return { id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: tc.name, arguments: args };
    });
}

/**
 * The agent loop: ask the model, run the tools it asks for (through `execute`), feed the results
 * back, and repeat until it answers in plain text or the step budget runs out.
 * `onEvent` gets { type: 'tool' | 'text', ... } for the UI.
 */
async function agentLoop(cfg, { system, messages, tools, execute, signal, onEvent = null, onDelta = null, maxSteps = 8 } = {}) {
  const all = [{ role: 'system', content: system }, ...messages];
  const toolDefs = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) throw new Error('Cancelled');
    const out = await chatCompletion(cfg, { messages: all, tools: toolDefs, temperature: cfg.temperature, maxTokens: cfg.maxTokens, signal, onDelta });
    if (!out.toolCalls.length) return { text: out.content, steps: step + 1 };
    all.push({ role: 'assistant', content: out.content || null, tool_calls: out.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) });
    for (const tc of out.toolCalls) {
      if (signal?.aborted) throw new Error('Cancelled');
      if (onEvent) onEvent({ type: 'tool', name: tc.name, arguments: tc.arguments });
      let result;
      try {
        result = await execute(tc.name, tc.arguments);
      } catch (e) {
        result = { error: e.message };
      }
      if (onEvent) onEvent({ type: 'toolDone', name: tc.name, result });
      all.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 24000) });
    }
  }
  throw new Error('The assistant kept calling tools and never answered. Stop it and ask again, or try a bigger model.');
}

module.exports = { normalizeBase, request, listModels, chatCompletion, parseSse, parseCompletion, agentLoop };
