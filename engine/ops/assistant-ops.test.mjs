// Run: node --test engine/ops/assistant-ops.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { validate, applyAssistant, setAssistant } from './assistant-set.mjs';
import { probeEndpoint, probeMineral } from './assistant-probe.mjs';
import { readAssistant } from '../kernel/lib/harness/index.mjs';
import { readAssistantState } from '../lib/assistant-state.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

test('validate: refuses what could not run, in words', async () => {
  await assert.rejects(() => validate({ harness: 'mystery', source: 'signin', provider: 'openai' }), /not a harness this mineral knows/);
  await assert.rejects(() => validate({ harness: 'claude-code', source: 'endpoint', provider: 'ollama', id: 'm', base_url: 'http://x' }), /claude-code harness cannot think with ollama/);
  await assert.rejects(() => validate({ harness: 'opencode', source: 'endpoint', provider: 'ollama', base_url: 'http://x/v1' }), /needs the name of the model/);
  await assert.rejects(() => validate({ harness: 'opencode', source: 'endpoint', provider: 'ollama', id: 'm', base_url: 'ftp://x' }), /must start with http/);
  await assert.rejects(() => validate({ harness: 'opencode', source: 'endpoint', provider: 'ollama', id: 'm', base_url: 'http://u:p@x/v1' }), /key box/);
  await assert.rejects(() => validate({ harness: 'opencode', source: 'endpoint', provider: 'ollama', id: 'm"\n  harness: evil', base_url: 'http://x/v1' }), /model name/);
  await assert.rejects(() => validate({ harness: 'opencode', source: 'endpoint', provider: 'ollama', id: 'm', base_url: 'http://x/v1', key_ref: '../etc/passwd' }), /key name/);
  await assert.rejects(() => validate({ harness: 'opencode', source: 'signin', provider: 'openai', timeout_s: 5 }), /between 30 seconds and one hour/);
});

test('apply: replaces the block in place, appends when absent, and round-trips through the reader', async () => {
  const a = await validate({ harness: 'opencode', source: 'endpoint', provider: 'ollama', id: 'qwen3.6:27b', base_url: 'http://127.0.0.1:11434/v1/', timeout_s: 900 });
  const before = 'identity:\n  assistant_name: "Idris"\n\nassistant:\n  harness: claude-code\n  model:\n    source: signin\n    provider: anthropic\n\ncadence:\n  enabled: false\n';
  const after = applyAssistant(before, a);
  assert.match(after, /^identity:\n  assistant_name: "Idris"\n\nassistant:\n  harness: opencode\n/);
  assert.match(after, /\n\ncadence:\n  enabled: false\n$/);
  assert.equal((after.match(/^assistant:/gm) || []).length, 1);
  assert.deepEqual(readAssistant(after), { harness: 'opencode', model: { source: 'endpoint', provider: 'ollama', id: 'qwen3.6:27b', base_url: 'http://127.0.0.1:11434/v1', timeout_s: 900 } });
  assert.deepEqual(readAssistant(applyAssistant('cadence:\n  enabled: true\n', a)).harness, 'opencode');
});

test('set: the key goes to secrets/ at 0600, never into the profile; a stale probe result is dropped', async () => {
  const d = tmpDir('aset-');
  writeFileSync(path.join(d, 'profile.yaml'), 'cadence:\n  enabled: false\n');
  mkdirSync(path.join(d, '.kernel')); writeFileSync(path.join(d, '.kernel', 'assistant-probe.json'), '{"ok":true}');
  await setAssistant(d, { harness: 'opencode', source: 'endpoint', provider: 'openai-compatible', id: 'glm', base_url: 'https://api.example.com/v1', key: 'sk-FLAT' });
  const prof = readFileSync(path.join(d, 'profile.yaml'), 'utf8');
  assert.ok(!prof.includes('sk-FLAT')); assert.match(prof, /key_ref: "assistant_endpoint_key"/);
  const f = path.join(d, 'secrets', 'assistant_endpoint_key');
  assert.equal(readFileSync(f, 'utf8'), 'sk-FLAT\n'); assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.ok(!existsSync(path.join(d, '.kernel', 'assistant-probe.json')));
  assert.equal(readAssistantState(d).ready, null);
});

// A real HTTP server standing in for an OpenAI-compatible endpoint: the probe speaks real fetch.
function fakeEndpoint(mode) {
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (mode === 'locked' && req.headers.authorization !== 'Bearer good') return send(401, { error: { message: 'no' } });
      if (req.url.endsWith('/models')) return mode === 'nomodels' ? send(404, {}) : send(200, { data: [{ id: 'qwen' }, { id: 'gpt-oss:20b' }] });
      if (mode === 'chatty') return send(200, { choices: [{ message: { role: 'assistant', content: 'I am ready!' } }] });
      if (mode === 'mangled') return send(200, { choices: [{ message: { tool_calls: [{ function: { name: 'report_ready', arguments: '{ready: tru' } }] } }] });
      return send(200, { choices: [{ message: { tool_calls: [{ function: { name: 'report_ready', arguments: '{"ready":true}' } }] } }] });
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}/v1`, close: () => srv.close() })));
}

test('probe: passes only on a well-formed tool call, and says what is wrong otherwise', async () => {
  for (const [mode, id, key, want] of [
    ['good', 'qwen', '', null], ['nomodels', 'anything', '', null], ['locked', 'qwen', 'good', null],
    ['locked', 'qwen', 'bad', /refused the key/], ['good', 'llama', '', /does not list a model named "llama" \(it lists: qwen, gpt-oss:20b\)/],
    ['chatty', 'qwen', '', /answered in words instead of calling a tool/], ['mangled', 'qwen', '', /not valid JSON/]]) {
    const ep = await fakeEndpoint(mode);
    try {
      const r = await probeEndpoint({ base_url: ep.url, id, key, timeoutMs: 5000 });
      if (want) { assert.equal(r.ok, false, mode); assert.match(r.detail, want); } else { assert.equal(r.ok, true, mode + ': ' + r.detail); assert.ok(r.steps.includes('tool call')); }
    } finally { ep.close(); }
  }
  const dead = await probeEndpoint({ base_url: 'http://127.0.0.1:9/v1', id: 'm', timeoutMs: 3000 });
  assert.deepEqual([dead.ok, dead.detail], [false, 'could not connect from this mineral']);
});

test('probeMineral: writes the result the state reader calls "ready"; a sign-in mineral is not probed', async () => {
  const d = tmpDir('aprobe-'); const ep = await fakeEndpoint('good');
  try {
    await setAssistant(d, { harness: 'opencode', source: 'endpoint', provider: 'ollama', id: 'qwen', base_url: ep.url });
    const r = await probeMineral(d, { now: () => '2026-09-17T05:00:00.000Z' });
    assert.equal(r.ok, true); assert.equal(r.at, '2026-09-17T05:00:00.000Z');
    const s = readAssistantState(d); assert.equal(s.ready, true); assert.match(s.status, /answering \(qwen\)/);
  } finally { ep.close(); }
  const c = tmpDir('aprobe-cc-');
  assert.equal((await probeMineral(c)).ok, null);
  assert.ok(!existsSync(path.join(c, '.kernel', 'assistant-probe.json')));
});
