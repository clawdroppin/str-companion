'use strict';
/**
 * Optional AI helper. Talks to a model running on the user's own computer (or LAN) through the
 * OpenAI-compatible API that LM Studio, llama.cpp's server, Jan and Ollama offer, or Ollama's own API
 * (which lets us ask for a bigger context window). Nothing is sent anywhere unless the user sets it up,
 * and only to the address they choose.
 *
 * Messages are kept in one neutral shape and converted per server:
 *   { role: 'system'|'user'|'assistant'|'tool', content, toolCalls?: [{id, name, arguments}], toolCallId?, name? }
 */

const PRESETS = [
  { name: 'Ollama', url: 'http://localhost:11434' },
  { name: 'LM Studio', url: 'http://localhost:1234/v1' },
  { name: 'llama.cpp', url: 'http://localhost:8080/v1' },
  { name: 'Jan', url: 'http://localhost:1337/v1' },
];

/** Cleans up what the user typed. Throws on anything that isn't an http(s) address. */
function normalizeUrl(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('Enter the address of your AI server, e.g. http://localhost:11434 for Ollama.');
  if (/^[a-z][\w+.-]*:\/\//i.test(u) && !/^https?:\/\//i.test(u)) throw new Error('Only http:// and https:// addresses work.');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  let parsed;
  try { parsed = new URL(u); } catch { throw new Error(`"${url}" isn't a valid address.`); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http:// and https:// addresses work.');
  return u;
}

/** True for this computer and private networks, so the page can say when chats leave the house. */
function isLocalUrl(url) {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fd|fe80:)/i.test(h) || h.endsWith('.local') || h.endsWith('.lan');
  } catch { return false; }
}

const origin = url => new URL(url).origin;
/** The OpenAI-style base: as typed if it has a path (".../v1"), otherwise "<origin>/v1". */
const openaiBase = url => (new URL(url).pathname.replace(/\/+$/, '') ? url : `${url}/v1`);

function friendlyFetchError(e, url) {
  if (e && e.name === 'AbortError') return Object.assign(new Error('Stopped.'), { stopped: true });
  if (e && e.name === 'TimeoutError') return new Error(`The AI server at ${url} took too long to answer.`);
  return new Error(`Couldn't reach an AI server at ${url}. Is Ollama or LM Studio running, with its server started?`);
}

const authHeaders = key => (key ? { Authorization: `Bearer ${key}` } : {});

async function getJson(url, ms = 5000, apiKey = null) {
  let r;
  try { r = await fetch(url, { headers: authHeaders(apiKey), signal: AbortSignal.timeout(ms) }); } catch (e) { throw friendlyFetchError(e, url); }
  const text = await r.text();
  if (r.status === 401 || r.status === 403) throw new Error('The AI server wants an API key (or a different one). Add it in the AI settings.');
  if (!r.ok) throw new Error(`The AI server answered ${r.status}: ${shorten(text, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error("The AI server's answer wasn't the expected JSON."); }
}

/** 'ollama' when the server speaks Ollama's own API, else 'openai'. */
async function detectKind(url) {
  try {
    const v = await getJson(`${origin(url)}/api/version`, 2000);
    if (v && typeof v.version === 'string') return 'ollama';
  } catch {}
  return 'openai';
}

/** The models the server offers, chat models first. */
async function listModels(url, kind, apiKey = null) {
  let names;
  if (kind === 'ollama') names = ((await getJson(`${origin(url)}/api/tags`, 5000, apiKey)).models || []).map(m => m.name || m.model).filter(Boolean);
  else names = ((await getJson(`${openaiBase(url)}/models`, 5000, apiKey)).data || []).map(m => m.id).filter(Boolean);
  // Embedding models can't chat.
  return [...names.filter(n => !/embed/i.test(n)), ...names.filter(n => /embed/i.test(n))];
}

// ---------- message conversion ----------

function toOpenAI(messages) {
  return messages.map(m => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      return { role: 'assistant', content: m.content || '', tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) } })) };
    }
    return { role: m.role, content: m.content };
  });
}

function toOllama(messages) {
  return messages.map(m => {
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.name };
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      return { role: 'assistant', content: m.content || '', tool_calls: m.toolCalls.map(c => ({ function: { name: c.name, arguments: c.arguments || {} } })) };
    }
    return { role: m.role, content: m.content };
  });
}

/** Text-mode conversations (server without tool support): tool results become plain user messages. */
function toTextMode(messages) {
  return messages.map(m => {
    if (m.role === 'tool') return { role: 'user', content: `[result of ${m.name}]\n${m.content}` };
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      return { role: 'assistant', content: [m.content || '', ...m.toolCalls.map(c => '```tool\n' + JSON.stringify({ name: c.name, arguments: c.arguments }) + '\n```')].join('\n').trim() };
    }
    return { role: m.role, content: m.content };
  });
}

function parseArgs(a) {
  if (a && typeof a === 'object') return a;
  if (!a) return {};
  try { return JSON.parse(a); } catch { return { __invalid: String(a) }; }
}

/**
 * Tool calls written as text: ```tool {"name":…,"arguments":{…}}``` (our text protocol) or
 * <tool_call>{…}</tool_call> (what Qwen and Hermes-style models write when the server doesn't parse it).
 */
function parseTextToolCalls(text) {
  const calls = [];
  const re = /```tool[^\n]*\n([\s\S]*?)```|<tool_call>([\s\S]*?)<\/tool_call>/g;
  for (let m; (m = re.exec(String(text || '')));) {
    try {
      const j = JSON.parse((m[1] || m[2]).trim());
      if (j && typeof j.name === 'string') calls.push({ id: `t${calls.length + 1}_${Date.now().toString(36)}`, name: j.name, arguments: parseArgs(j.arguments || j.parameters) });
    } catch {}
  }
  return calls;
}
/** The answer with text-protocol tool calls removed, for showing. */
const stripTextToolCalls = text => String(text || '').replace(/```tool[^\n]*\n[\s\S]*?```|<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();

// ---------- streaming ----------

/** Yields complete lines from a fetch body, resetting an idle timer on every chunk. */
async function* lines(body, onChunk) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    onChunk();
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf.trim()) yield buf;
}

const NO_TOOLS = /does not support tools|tools? (are|is) not supported|unsupported.*tool|tool.*not supported|jinja/i;

/**
 * Sends one request and streams the answer. Resolves to { content, thinking, toolCalls }.
 * @param o.url, o.kind ('ollama'|'openai'), o.model, o.messages, o.tools (OpenAI function specs or null)
 * @param o.numCtx  context window to ask Ollama for
 * @param o.apiKey  optional, for servers that want one (sent as a Bearer token)
 * @param o.onText(delta), o.onThinking(delta)
 * @param o.signal  AbortSignal (Stop button)
 */
async function chat(o) {
  const ollama = o.kind === 'ollama';
  const endpoint = ollama ? `${origin(o.url)}/api/chat` : `${openaiBase(o.url)}/chat/completions`;
  const body = ollama
    ? { model: o.model, messages: toOllama(o.messages), stream: true, options: { num_ctx: o.numCtx || 16384, temperature: 0.3 } }
    : { model: o.model, messages: toOpenAI(o.messages), stream: true, temperature: 0.3 };
  if (o.tools && o.tools.length) body.tools = o.tools;

  // An idle timeout: a model that stops sending for 3 minutes is stuck.
  const idle = new AbortController();
  let timer;
  const poke = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(), o.idleMs || 180000); };
  const signal = o.signal ? AbortSignal.any([o.signal, idle.signal]) : idle.signal;
  poke();
  let r;
  try {
    r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders(o.apiKey) }, body: JSON.stringify(body), signal });
  } catch (e) {
    clearTimeout(timer);
    if (idle.signal.aborted && !(o.signal && o.signal.aborted)) throw new Error('The AI server took too long to answer.');
    throw friendlyFetchError(e, o.url);
  }
  if (!r.ok) {
    clearTimeout(timer);
    const text = await r.text().catch(() => '');
    const err = new Error(r.status === 404 && /model/i.test(text)
      ? `The server doesn't have the model "${o.model}". Pick another one in the AI settings.`
      : `The AI server answered ${r.status}: ${shorten(text, 300)}`);
    if (body.tools && NO_TOOLS.test(text)) err.noTools = true;
    throw err;
  }

  let content = '', thinking = '';
  const calls = []; // OpenAI streams tool calls in pieces, by index
  const ollamaCalls = [];
  try {
    for await (const raw of lines(r.body, poke)) {
      let line = raw.trim();
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('data:')) line = line.slice(5).trim();
      if (line === '[DONE]') break;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.error) throw new Error(typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error));
      if (ollama) {
        const m = j.message || {};
        if (m.thinking) { thinking += m.thinking; o.onThinking && o.onThinking(m.thinking); }
        if (m.content) { content += m.content; o.onText && o.onText(m.content); }
        for (const c of m.tool_calls || []) if (c.function) ollamaCalls.push(c.function);
        if (j.done) break;
        continue;
      }
      const ch = (j.choices || [])[0] || {};
      const d = ch.delta || ch.message || {};
      const think = d.reasoning_content || d.reasoning;
      if (think) { thinking += think; o.onThinking && o.onThinking(think); }
      if (d.content) { content += d.content; o.onText && o.onText(d.content); }
      for (const t of d.tool_calls || []) {
        const i = t.index ?? calls.length;
        const c = calls[i] || (calls[i] = { id: '', name: '', args: '' });
        if (t.id) c.id = t.id;
        if (t.function && t.function.name) c.name += t.function.name;
        if (t.function && t.function.arguments != null) c.args += typeof t.function.arguments === 'string' ? t.function.arguments : JSON.stringify(t.function.arguments);
      }
    }
  } catch (e) {
    if (idle.signal.aborted && !(o.signal && o.signal.aborted)) throw new Error('The AI server stopped answering.');
    if (e.name === 'AbortError') throw friendlyFetchError(e, o.url);
    throw e;
  } finally {
    clearTimeout(timer);
  }

  let toolCalls = ollama
    ? ollamaCalls.map((f, i) => ({ id: `c${i}_${Date.now().toString(36)}`, name: f.name, arguments: parseArgs(f.arguments) }))
    : calls.filter(c => c && c.name).map((c, i) => ({ id: c.id || `c${i}_${Date.now().toString(36)}`, name: c.name, arguments: parseArgs(c.args) }));
  // Models sometimes write the call as text even with tools on; servers without tool support always do.
  if (!toolCalls.length) toolCalls = parseTextToolCalls(content);
  return { content, thinking, toolCalls };
}

function shorten(text, max) {
  text = String(text || '').trim();
  return text.length <= max ? text : text.slice(0, max) + '…';
}

/** A tool result as text for the model, cut to fit small context windows. */
function resultText(value, max = 6000) {
  let s;
  try { s = typeof value === 'string' ? value : JSON.stringify(value, null, 0); } catch { s = String(value); }
  if (s === undefined) s = 'null';
  return s.length > max ? s.slice(0, max) + `… [cut: ${s.length - max} more characters; ask for something narrower]` : s;
}

module.exports = {
  PRESETS, normalizeUrl, isLocalUrl, openaiBase, detectKind, listModels, chat,
  toOpenAI, toOllama, toTextMode, parseTextToolCalls, stripTextToolCalls, resultText, shorten,
};
