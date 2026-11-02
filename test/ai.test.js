'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ai = require('../src/core/ai');
const aitools = require('../src/core/aitools');
const configs = require('../src/core/configs');
const { BackupStore } = require('../src/core/backup');
const { fakeGame: makeGame } = require('./fixtures');

// Only this file's own folders: test files run in parallel, so a time-based sweep would hit the others'.
const made = [];
const fakeGame = () => { const g = makeGame(); made.push(g.root); return g; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

/** A stand-in AI server. `routes` maps "METHOD /path" to (body, res) => void. */
async function server(routes) {
  const requests = [];
  const headers = [];
  const s = http.createServer((req, res) => {
    headers.push(req.headers);
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => {
      const body = b ? JSON.parse(b) : null;
      requests.push({ path: req.url, body });
      const fn = routes[`${req.method} ${req.url}`];
      if (!fn) { res.statusCode = 404; return res.end('not found'); }
      fn(body, res);
    });
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, requests, headers, close: () => new Promise(r => s.close(r)) };
}

const sse = (res, chunks) => {
  res.setHeader('Content-Type', 'text/event-stream');
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
};

test('ai: addresses are cleaned up, and local ones recognised', () => {
  assert.strictEqual(ai.normalizeUrl(' localhost:11434/ '), 'http://localhost:11434');
  assert.strictEqual(ai.openaiBase('http://localhost:11434'), 'http://localhost:11434/v1');
  assert.strictEqual(ai.openaiBase('http://localhost:1234/v1'), 'http://localhost:1234/v1');
  assert.throws(() => ai.normalizeUrl(''), /address/);
  assert.throws(() => ai.normalizeUrl('ftp://x'), /http/);
  for (const u of ['http://localhost:1', 'http://127.0.0.1:1', 'http://192.168.1.20:1234', 'http://10.0.0.2', 'http://[::1]:11434', 'http://box.local']) assert.ok(ai.isLocalUrl(u), u);
  for (const u of ['https://api.example.com/v1', 'http://8.8.8.8']) assert.ok(!ai.isLocalUrl(u), u);
});

test('ai: OpenAI-style streaming joins text and tool calls sent in pieces', async () => {
  const srv = await server({
    'GET /v1/models': (_b, res) => res.end(JSON.stringify({ data: [{ id: 'nomic-embed' }, { id: 'qwen3-8b' }] })),
    'POST /v1/chat/completions': (_b, res) => sse(res, [
      { choices: [{ delta: { reasoning_content: 'hmm' } }] },
      { choices: [{ delta: { content: 'Let me ' } }] },
      { choices: [{ delta: { content: 'check.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_config', arguments: '{"file":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"server"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'get_overview', arguments: '' } }] } }] },
    ]),
  });
  try {
    assert.strictEqual(await ai.detectKind(srv.url), 'openai');
    assert.deepStrictEqual(await ai.listModels(srv.url, 'openai'), ['qwen3-8b', 'nomic-embed']);
    let text = '', thinking = '';
    const r = await ai.chat({
      url: srv.url, kind: 'openai', model: 'qwen3-8b', tools: aitools.specs(true),
      messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'get_overview', arguments: {} }] }, { role: 'tool', toolCallId: 'a', name: 'get_overview', content: '{}' }],
      onText: t => { text += t; }, onThinking: t => { thinking += t; },
    });
    assert.strictEqual(r.content, 'Let me check.');
    assert.strictEqual(text, 'Let me check.');
    assert.strictEqual(thinking, 'hmm');
    assert.deepStrictEqual(r.toolCalls.map(c => [c.id, c.name, c.arguments]), [['call_1', 'read_config', { file: 'server' }], ['call_2', 'get_overview', {}]]);
    // The history went out in OpenAI's shape.
    const sent = srv.requests.find(q => q.path === '/v1/chat/completions').body;
    assert.strictEqual(sent.messages[2].tool_calls[0].function.arguments, '{}');
    assert.strictEqual(sent.messages[3].tool_call_id, 'a');
    assert.ok(sent.tools.length > 30);
  } finally { await srv.close(); }
});

test('ai: Ollama is detected and gets its own API with a bigger context', async () => {
  const srv = await server({
    'GET /api/version': (_b, res) => res.end('{"version":"0.12.0"}'),
    'GET /api/tags': (_b, res) => res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'nomic-embed-text' }] })),
    'POST /api/chat': (_b, res) => {
      res.write(JSON.stringify({ message: { thinking: 'plan' } }) + '\n');
      res.write(JSON.stringify({ message: { content: 'On it.' } }) + '\n');
      res.write(JSON.stringify({ message: { tool_calls: [{ function: { name: 'set_plugin_enabled', arguments: { plugin: 'A.esp', enabled: false } } }] } }) + '\n');
      res.end(JSON.stringify({ done: true }) + '\n');
    },
  });
  try {
    assert.strictEqual(await ai.detectKind(srv.url), 'ollama');
    assert.deepStrictEqual(await ai.listModels(srv.url, 'ollama'), ['qwen3:8b', 'nomic-embed-text']);
    const r = await ai.chat({ url: srv.url, kind: 'ollama', model: 'qwen3:8b', numCtx: 32768, tools: aitools.specs(true), messages: [{ role: 'user', content: 'hi' }, { role: 'tool', name: 'get_overview', content: '{}' }] });
    assert.strictEqual(r.content, 'On it.');
    assert.strictEqual(r.thinking, 'plan');
    assert.deepStrictEqual(r.toolCalls.map(c => [c.name, c.arguments]), [['set_plugin_enabled', { plugin: 'A.esp', enabled: false }]]);
    const sent = srv.requests.find(q => q.path === '/api/chat').body;
    assert.strictEqual(sent.options.num_ctx, 32768);
    assert.strictEqual(sent.messages[1].tool_name, 'get_overview');
  } finally { await srv.close(); }
});

test('ai: a server without tool support is flagged, and text-mode tool calls are read', async () => {
  const srv = await server({
    'POST /v1/chat/completions': (_b, res) => { res.statusCode = 400; res.end('{"error":{"message":"registry.ollama.ai/library/gemma2 does not support tools"}}'); },
  });
  try {
    await assert.rejects(ai.chat({ url: srv.url + '/v1', kind: 'openai', model: 'gemma2', tools: aitools.specs(false), messages: [{ role: 'user', content: 'hi' }] }), e => e.noTools === true);
  } finally { await srv.close(); }
  await assert.rejects(ai.chat({ url: 'http://127.0.0.1:9', kind: 'openai', model: 'x', messages: [] }), /Couldn't reach an AI server/);

  const text = 'Sure.\n```tool\n{"name": "read_config", "arguments": {"file": "prefs"}}\n```\n<tool_call>{"name":"get_overview","arguments":{}}</tool_call>';
  assert.deepStrictEqual(ai.parseTextToolCalls(text).map(c => [c.name, c.arguments]), [['read_config', { file: 'prefs' }], ['get_overview', {}]]);
  assert.strictEqual(ai.stripTextToolCalls(text), 'Sure.');
  const tm = ai.toTextMode([{ role: 'assistant', content: 'x', toolCalls: [{ name: 'get_overview', arguments: {} }] }, { role: 'tool', name: 'get_overview', content: '{"a":1}' }]);
  assert.match(tm[0].content, /```tool/);
  assert.deepStrictEqual(tm[1], { role: 'user', content: '[result of get_overview]\n{"a":1}' });
  assert.match(ai.resultText('x'.repeat(7000)), /cut: 1000 more/);
});

test('ai: an API key is sent as a Bearer token, and a refusal says so', async () => {
  const srv = await server({
    'GET /v1/models': (_b, res) => { res.statusCode = 401; res.end('{}'); },
    'POST /v1/chat/completions': (_b, res) => sse(res, [{ choices: [{ delta: { content: 'ok' } }] }]),
  });
  try {
    await assert.rejects(ai.listModels(srv.url, 'openai', 'k1'), /API key/);
    const r = await ai.chat({ url: srv.url, kind: 'openai', model: 'm', apiKey: 'k2', messages: [{ role: 'user', content: 'hi' }] });
    assert.strictEqual(r.content, 'ok');
  } finally { await srv.close(); }
  assert.deepStrictEqual(srv.headers.map(h => h.authorization), ['Bearer k1', 'Bearer k2']);
});

test('ai tools: valid schemas, argument checks, and read-only mode hides changes', () => {
  const names = aitools.TOOLS.map(t => t.name);
  assert.strictEqual(new Set(names).size, names.length);
  for (const t of aitools.TOOLS) {
    assert.ok(['read', 'change', 'ask'].includes(t.risk), t.name);
    for (const r of t.required) assert.ok(t.properties[r], `${t.name}.${r}`);
    assert.ok(t.description.length < 400, t.name);
  }
  // Nothing that deletes or touches secrets is offered.
  assert.ok(!names.some(n => /delete|key|self_?update/.test(n)));
  assert.ok(aitools.specs(false).every(s => aitools.byName.get(s.function.name).risk === 'read'));
  assert.ok(aitools.specs(true).length > aitools.specs(false).length);

  const set = aitools.byName.get('set_config_values');
  assert.match(aitools.checkArgs(set, { file: 'server' }), /Missing "changes"/);
  assert.match(aitools.checkArgs(set, { file: 'nope', changes: [] }), /one of/);
  assert.strictEqual(aitools.checkArgs(set, { file: 'server', changes: [{ section: 'Gameplay', key: 'uDifficulty', value: '4' }] }), null);
  const snap = aitools.byName.get('update_app_settings');
  const coerced = aitools.coerceArgs(snap, { autoSnapshot: 'true', keepAutoSnapshots: '12' });
  assert.deepStrictEqual(coerced, { autoSnapshot: true, keepAutoSnapshots: 12 });
  assert.strictEqual(aitools.checkArgs(snap, coerced), null);
  assert.match(aitools.checkArgs(snap, { __invalid: '{' }), /JSON object/);
  assert.match(aitools.describeCall('set_config_values', { file: 'server', changes: [{ section: 'Gameplay', key: 'bEnablePvp', value: 'true' }] }), /\[Gameplay\] bEnablePvp=true/);

  // The briefing explains the app and adapts to the user's choices.
  const p = aitools.systemPrompt({ state: '- Skyrim 1.6.1170', allowChanges: false, textTools: true });
  assert.match(p, /identical plugins in identical order/);
  assert.match(p, /CHANGES ARE OFF/);
  assert.match(p, /```tool/);
  assert.match(p, /- get_overview\(\)/);
  assert.ok(!/set_config_values/.test(p));
  assert.match(p, /Skyrim 1\.6\.1170/);
});

test('ai tools: every tool is implemented in the main process', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const exec = src.slice(src.indexOf('const aiExec = {'), src.indexOf('function aiApproval'));
  for (const t of aitools.TOOLS) assert.match(exec, new RegExp(`\\n  (async )?${t.name}[(:]`), t.name);
});

test('config history: every edit can be undone, and paths stay inside', () => {
  const { paths } = fakeGame();
  const backups = new BackupStore(paths);
  const r = configs.save(paths, 'server', [{ section: 'Gameplay', key: 'uDifficulty', value: '2' }], backups);
  assert.strictEqual(r.changed, 1);
  const hist = backups.listConfigHistory();
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].name, 'STServer.ini');
  const file = configs.configFiles(paths).find(f => f.id === 'server').file;
  assert.match(fs.readFileSync(file, 'utf8'), /uDifficulty=2/);
  const back = backups.restoreConfigVersion(hist[0].id, file);
  assert.match(fs.readFileSync(file, 'utf8'), /uDifficulty=4/);
  assert.ok(back.safety && fs.existsSync(back.safety));
  assert.throws(() => backups.restoreConfigVersion('../../SkyrimSE.exe', file), /no longer exists/);
  assert.throws(() => backups.restoreConfigVersion('x/../../a', file), /no longer exists/);
});

test('configs: line breaks and broken names are refused', () => {
  const { paths } = fakeGame();
  for (const ch of [
    { section: 'GameServer', key: 'sPassword', value: 'a\r\n[Evil]\r\nx=1' },
    { section: 'Game\nServer', key: 'k', value: '1' },
    { section: 'GameServer', key: 'a=b', value: '1' },
    { section: 'GameServer', key: '', value: '1' },
  ]) assert.throws(() => configs.save(paths, 'server', [ch], null), /Invalid setting/);
});
