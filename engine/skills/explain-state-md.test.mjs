// explain-state-md.test.mjs — R24 (panel iteration 2, 2026-08-23): /explain
// reads STATE.md first and describes the three-layer model, not the retired
// two-layer one. Structural pins only: the skill must name the file, say to
// read it before answering, and carry the three layers and the three tiers.
//   node --test engine/skills/explain-state-md.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const md = readFileSync(new URL('./explain.md', import.meta.url), 'utf8');

test('the skill reads STATE.md before answering about this mineral', () => {
  const i = md.indexOf('## Read STATE.md first');
  assert.notEqual(i, -1, 'a section that says so, ahead of the toolkit');
  assert.ok(i < md.indexOf('## Read-only inspection toolkit'));
  assert.match(md, /STATE\.md/);
  assert.match(md, /rewrit(es|ten) it every run/i, 'and knows why it can trust it');
  assert.match(md, /If it is missing/, 'with a fallback when the file is absent');
});

test('the reference section carries the three-layer model and the three tiers', () => {
  const ref = md.slice(md.indexOf('## Reference'), md.indexOf('## Tone'));
  assert.match(ref, /Three layers/);
  assert.match(ref, /Machinery/);
  assert.match(ref, /Infrastructure/);
  assert.match(ref, /member surface/i);
  assert.match(ref, /three-layer-model\.md/, 'and points at the contract');
  for (const tier of ['pebble', 'rock', 'the Mountain']) assert.match(ref, new RegExp(tier), `names ${tier}`);
  assert.doesNotMatch(ref, /Two layers/);
  assert.doesNotMatch(ref, /ai-os`/, 'the single-image name is gone');
});

test('sentence case and zero em dashes in the prose', () => {
  assert.doesNotMatch(md, /—/);
});
