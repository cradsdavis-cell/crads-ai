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
