// seat-slim.test.mjs — run: node --test wizard/panel/seat-slim.test.mjs
//
// Sam's 2026-08-09 audit, ruling R3: the seat page slims down. The
// hand-ownership ask was too advanced a surface to show every member (the
// /handover-ask route and the Waiting-on-you accept path survive); promote
// starts as one button, not two permanent inputs; Origin and Danger fold away;
// and the page points at the Rocks tab, where joining actually lives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');
const seat = html.slice(html.indexOf('<section data-sec="seat">'), html.indexOf('<section data-sec="network">'));

test('the hand-ownership ask form is gone from the seat', () => {
  assert.ok(!html.includes('id="seatHoOrg"'), 'no handle input');
  assert.ok(!html.includes('id="seatHoSend"'), 'no ask button');
  // the receiving end stays: a transfer a rock stages must still complete here
  assert.ok(html.includes("run('transfer-accept'"), 'accept path survives');
});

test('promote is a single button that expands into the form', () => {
  assert.ok(html.includes('id="seatPromoteStart"'), 'the one visible control');
  assert.match(html, /seatPromoteForm" style="display:none/, 'the form starts hidden');
  assert.ok(html.includes('id="seatPromoteHandle"'), 'and still collects a handle when opened');
});

test('Origin and Danger fold shut instead of holding permanent scroll', () => {
  assert.match(seat, /<details>\s*<summary[^>]*>Origin<\/summary>/, 'Origin is a fold');
  assert.match(seat, /<summary[^>]*>Advanced<\/summary>[\s\S]*id="seatDanger"/, 'Danger sits behind Advanced');
});

test('the seat points at the Rocks tab for joining, wired not decorative', () => {
  assert.ok(seat.includes('id="seatGoRocks"'), 'the pointer exists');
  assert.match(html, /\$\('seatGoRocks'\)\.onclick[\s\S]{0,200}activateSec\('rocks'\)/, 'and actually switches sections');
});
