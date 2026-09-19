// Run: node --test engine/lib/assistant-state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readAssistantState, endpointHost } from './assistant-state.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const put = (dir, rel, body) => { const p = path.join(dir, ...rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, body); };
const OC = (extra) => `assistant:\n  harness: opencode\n  model:\n${extra}`;

test('no assistant block: the Claude row, verbatim name, as every older app expects', () => {
  const d = tmpDir('as-cc-');
  let s = readAssistantState(d);
  assert.equal(s.rowName, 'Claude sign-in on this mineral');
  assert.equal(s.ready, false); assert.equal(s.signinCommand, 'claude');
  put(d, ['.claude-auth', '.credentials.json'], '{"x":1}');
  put(d, ['.claude-auth', '.claude.json'], JSON.stringify({ oauthAccount: { emailAddress: 'mel@example.com' } }));
  s = readAssistantState(d);
  assert.equal(s.ready, true); assert.equal(s.status, 'signed in as mel@example.com');
});

test('opencode sign-in: ready only when THIS provider has a credential', () => {
  const d = tmpDir('as-oc-');
  put(d, ['profile.yaml'], OC('    source: signin\n    provider: openai\n'));
  assert.equal(readAssistantState(d).ready, false);
  put(d, ['.opencode-auth', 'data', 'opencode', 'auth.json'], JSON.stringify({ 'github-copilot': { type: 'oauth', refresh: 'r' } }));
  assert.equal(readAssistantState(d).ready, false, 'a Copilot credential does not sign in ChatGPT');
  put(d, ['.opencode-auth', 'data', 'opencode', 'auth.json'], JSON.stringify({ openai: { type: 'oauth', refresh: 'SECRET' } }));
  const s = readAssistantState(d);
  assert.equal(s.ready, true); assert.equal(s.signinCommand, 'opencode auth login');
  assert.ok(!JSON.stringify(s).includes('SECRET'));
});

test('endpoint: never probed is null, not down; no sign-in command; host only', () => {
  const d = tmpDir('as-ep-');
  put(d, ['profile.yaml'], OC('    source: endpoint\n    provider: ollama\n    id: qwen3.6:27b\n    base_url: http://user:hunter2@100.89.1.2:11434/v1/secret-path\n'));
  let s = readAssistantState(d);
  assert.equal(s.ready, null); assert.equal(s.signinCommand, null);
  assert.equal(s.host, '100.89.1.2:11434'); assert.equal(s.local, true);
  assert.ok(!JSON.stringify(s).includes('hunter2') && !JSON.stringify(s).includes('secret-path'));
  assert.match(s.status, /not checked yet/);
  put(d, ['.kernel', 'assistant-probe.json'], JSON.stringify({ ok: false, detail: 'the model did not return a tool call' }));
  s = readAssistantState(d);
  assert.equal(s.ready, false); assert.match(s.status, /did not return a tool call/);
  put(d, ['.kernel', 'assistant-probe.json'], JSON.stringify({ ok: true }));
  assert.equal(readAssistantState(d).ready, true);
});

test('words-go line says where thinking happens and never claims nothing leaves', () => {
  const d = tmpDir('as-wg-');
  put(d, ['profile.yaml'], OC('    source: endpoint\n    provider: ollama\n    id: m\n    base_url: http://127.0.0.1:11434/v1\n'));
  const w = readAssistantState(d).wordsGo;
  assert.match(w, /Thinking happens at 127\.0\.0\.1:11434 \(a private address\)/);
  assert.match(w, /still see what you send them/);
  assert.ok(!/nothing leaves|never leaves|fully private/i.test(w));
});

test('a public endpoint is not called private; an unknown harness is not ready and says why', () => {
  assert.equal(endpointHost('not a url'), null);
  const d = tmpDir('as-pub-');
  put(d, ['profile.yaml'], OC('    source: endpoint\n    provider: openai-compatible\n    id: m\n    base_url: https://api.example.com/v1\n'));
  assert.equal(readAssistantState(d).local, false);
  put(d, ['profile.yaml'], 'assistant:\n  harness: mystery\n');
  const s = readAssistantState(d);
  assert.equal(s.ready, false); assert.match(s.status, /does not know \("mystery"\)/);
});
