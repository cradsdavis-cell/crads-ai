// door-finish-checklist.test.mjs — the "Your mineral is alive" screen is a
// checklist, not a full stop (wizard steps 5-6, 2026-09-02): Open it, back the
// brain up to the OWNER'S GitHub (the own-brain flow, run in place), connect
// Claude (handed to the app's Terminal tab, the one surface that can run the
// interactive sign-in). Structural pins + a parse check on the page scripts;
// the routes themselves are pinned by setup-steps.test.mjs.
//   node --test wizard/panel/door-finish-checklist.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./door.html', import.meta.url), 'utf8');

test('every inline door script parses (no build step: a syntax error is a dead app, not a failed build)', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 2, 'door.html carries its inline scripts');
  for (const src of scripts) {
    assert.doesNotThrow(() => new Function(src));   // eslint-disable-line no-new-func
  }
});

test('the headline survives, and the finish screen carries all three rows', () => {
  assert.match(html, /Your mineral is alive\./);
  for (const id of ['shOpenBtn', 'shRowGh', 'shGhChip', 'shGhBtn', 'shRowClaude', 'shClaudeChip', 'shClaudeBtn']) {
    assert.ok(html.includes(`id="${id}"`), `door.html no longer carries #${id}`);
  }
});

test('the GitHub row drives the own-brain routes with the box it built, never a guessed host', () => {
  assert.match(html, /\/own-brain\/start/);
  assert.match(html, /slug:\s*shBox\.slug,\s*box:\s*shBox\.alias/,
    'start names the built box explicitly (door mount has no default host)');
  assert.match(html, /\/own-brain\/status/);
});

test('the checklist polls the box for both facts and renders honest states', () => {
  assert.match(html, /\/setup-steps\?box=/);
  // an unreachable box must read as "could not check", never as "not yet"
  assert.match(html, /Could not check/);
});

test('Connect Claude deep-links the Terminal tab with the whitelisted sign-in opener only', () => {
  const i = html.indexOf("'&sec=terminal&run=signin'");
  assert.ok(i > 0, 'the claude row deep-links #box=<slug>&sec=terminal&run=signin');
  // no other run= value is ever placed in a URL from this page
  assert.equal([...html.matchAll(/&run=([a-z]+)/g)].every((m) => m[1] === 'signin'), true);
});

// ---- a mineral that thinks with something other than Claude (spec 2026-09-17) ----------
// shStepsSync is extracted and RUN against a fake document, because reaching the finish
// screen in a browser means walking the whole provisioning flow.
import { readFileSync as _rf } from 'node:fs';
import { fileURLToPath as _fu } from 'node:url';
import { dirname as _dn, join as _jn } from 'node:path';

async function syncWith(steps) {
  const door = _rf(_jn(_dn(_fu(import.meta.url)), 'door.html'), 'utf8');
  const fn = door.match(/function shStepsSync\(\)\{[\s\S]*?\n {2}\}\n/);
  assert.ok(fn, 'shStepsSync moved or changed shape');
  const els = {};
  const el = (id) => (els[id] ||= { id, textContent: id === 'shGhChip' || id === 'shClaudeChip' ? 'Checking…' : '', innerHTML: '', style: {}, classList: { toggle() {} } });
  const document = { getElementById: el };
  const shChip = (id, text, done) => { el(id).textContent = text; el(id).done = !!done; };
  const fetch = async () => ({ json: async () => steps });
  new Function('document', 'fetch', 'shBox', 'shChip', 'stepsUrl', 'shGhPoll', 'esc', `${fn[0]}; shStepsSync();`)(
    document, fetch, { alias: 'mel-box' }, shChip, (a) => '/setup-steps?box=' + a, null, (s) => String(s));
  await new Promise((r) => setTimeout(r, 10));
  return els;
}

test('finish row: a Claude mineral reads exactly as before, with or without the new field', async () => {
  for (const steps of [
    { reachable: true, github: { connected: false }, claude: { signedIn: false } },
    { reachable: true, github: { connected: false }, claude: { signedIn: false }, assistant: { harness: 'claude-code', source: 'signin', label: 'Claude', ready: false, signin: 'claude' } }]) {
    const e = await syncWith(steps);
    assert.equal(e.shClaudeChip.textContent, 'Not yet');
    assert.equal(e.shClaudeTitle, undefined, 'the title is left as the page wrote it');
    assert.equal(e.shClaudeBtn.style.display, '');
  }
});

test('finish row: a ChatGPT mineral is asked to sign in to ChatGPT, on the terminal', async () => {
  const e = await syncWith({ reachable: true, github: { connected: true, repo: 'r' }, claude: { signedIn: false },
    assistant: { harness: 'opencode', source: 'signin', label: 'ChatGPT', ready: false, signin: 'opencode auth login' } });
  assert.equal(e.shClaudeTitle.textContent, 'Connect ChatGPT');
  assert.match(e.shClaudeHint.textContent, /signed in to ChatGPT, on your own subscription/);
  assert.deepEqual([e.shClaudeChip.textContent, e.shClaudeBtn.style.display], ['Not yet', '']);
});

test('finish row: an endpoint has no terminal step; never-checked says so and is not "done"', async () => {
  const e = await syncWith({ reachable: true, github: { connected: true, repo: 'r' }, claude: { signedIn: false },
    assistant: { harness: 'opencode', source: 'endpoint', label: 'a model endpoint', ready: null, host: '192.168.1.20:11434', signin: null } });
  assert.equal(e.shClaudeTitle.textContent, 'Your model endpoint');
  assert.match(e.shClaudeHint.textContent, /thinks at 192\.168\.1\.20:11434/);
  assert.deepEqual([e.shClaudeChip.textContent, e.shClaudeChip.done, e.shClaudeBtn.style.display], ['Not checked', false, 'none']);
});
