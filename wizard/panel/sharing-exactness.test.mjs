// sharing-exactness.test.mjs — "Exactly what leaves your box" must be exact.
// Run: node --test wizard/panel/sharing-exactness.test.mjs
//
// Why this file exists. The Sharing page promised an exhaustive list and then
// rebuilt the payload by hand ("mirror the emitter"), so the two drifted:
// engine/heartbeat.mjs puts app_commit, image_tag, run_ledger and
// catalog_requests into the object it pushes, and NONE of the four appeared in
// the plain rows or in "View the raw payload".
//
// Sharpest detail: sharing-list already returns the real pushed heartbeat.json
// as a __SHARED__ segment, and the page used that marker only as a delimiter
// and discarded the contents. The app held the true answer and rendered a
// reconstruction of it.
//
// What was NOT wrong, and must stay right: the rows that say "nothing about
// this leaves your box" are honest, because the emitter really does withhold
// those categories, and tailForHeartbeat really does drop every skill row when
// skill engagement is off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');
const emitter = readFileSync(join(HERE, '..', '..', 'engine', 'heartbeat.mjs'), 'utf8');

// the keys the emitter actually pushes, read from the source of truth
function pushedKeys() {
  const block = emitter.slice(emitter.indexOf('const hb = {'), emitter.indexOf('const dir = path.join'));
  const keys = new Set();
  for (const m of block.matchAll(/(?:^|[{,\s])([a-z_]+):/g)) keys.add(m[1]);
  for (const m of block.matchAll(/hb\.([a-z_]+)\s*=/g)) keys.add(m[1]);
  return keys;
}

test('every key the emitter pushes has a row on the page', () => {
  const missing = [];
  for (const k of pushedKeys()) {
    // The floor is described in prose above the list rather than as rows, and
    // skill_engagement/activity are the toggle STATES nested inside `shared` —
    // the member sets those with the switches on this very page, so they are
    // self-describing rather than undisclosed.
    if (['shared', 'generated_at', 'auth_ok', 'skill_engagement', 'activity'].includes(k)) continue;
    if (!new RegExp(`k: '${k}'`).test(html)) missing.push(k);
  }
  assert.deepEqual(missing, [], `these leave the box with no row saying so: ${missing.join(', ')}`);
});

test('the raw payload shows the file that is really pushed', () => {
  assert.match(html, /state\.hbShared/, 'the real payload must be kept, not discarded');
  const render = html.slice(html.indexOf('function renderPreview()'), html.indexOf('function renderPreview()') + 3000);
  assert.match(render, /real \? '' :/, 'and used when it exists');
});

test('before the first heartbeat it says so instead of passing a prediction off as a record', () => {
  const render = html.slice(html.indexOf('function renderPreview()'), html.indexOf('function renderPreview()') + 3000);
  assert.match(render, /has not sent one yet/, 'an honest caveat, not a silent projection');
});

test('the four newly-listed keys carry plain-English meanings, not field names', () => {
  for (const k of ['app_commit', 'image_tag', 'run_ledger', 'catalog_requests']) {
    const row = html.match(new RegExp(`k: '${k}'[^\\n]*`));
    assert.ok(row, `${k} must have a row`);
    assert.match(row[0], /mean: '[^']{25,}/, `${k} must explain itself to a person`);
  }
});

test('the run ledger row tells the truth about its own gating', () => {
  const row = html.match(/k: 'run_ledger'[^\n]*/)[0];
  assert.match(row, /Skill engagement/, 'skill rows ride only while that toggle is on, and the row must say so');
});

// ---------------------------------------------------------------------------
// The regression the first version of this fix introduced: the raw payload was
// switched to the real pushed heartbeat while the plain rows kept reading the
// LIVE toggles, so the two halves of a card headed "Exactly what leaves your
// box" contradicted each other the moment anyone flipped a switch. Before the
// change both came from one projection, and the comment above SHARE_FIELDS
// promised exactly that ("the two views can never drift").
test('both halves of the card read one source', () => {
  const render = html.slice(html.indexOf('function renderPreview()'), html.indexOf('function renderPreview()') + 3000);
  assert.match(render, /var on = f\.cat === '__floor__'[\s\S]{0,200}real \?/,
    'the rows must read the same object the payload is rendered from');
  assert.doesNotMatch(render.slice(render.indexOf('SHARE_FIELDS.forEach')), /shareOn\(f\.cat\)\s*;/,
    'the rows must not read the live toggle while the payload shows the sent file');
});

test('a toggle changed since the last send is shown as pending, not as a contradiction', () => {
  const render = html.slice(html.indexOf('function renderPreview()'), html.indexOf('function renderPreview()') + 3000);
  assert.match(render, /pending/, 'the gap between "what left" and "what you have chosen" must be named');
  assert.match(html, /id="sharingPending"/, 'and it needs somewhere to say it');
  assert.match(render, /what actually left/, 'in plain words about which of the two the reader is looking at');
});

test('a box that has never sent one still describes what the next update will carry', () => {
  const render = html.slice(html.indexOf('function renderPreview()'), html.indexOf('function renderPreview()') + 3000);
  assert.match(render, /has not sent one yet/, 'no heartbeat: say so rather than showing an empty object as fact');
  assert.match(render, /real \? [\s\S]{0,80}shareOn\(f\.cat\)/, 'and fall back to the live toggles, the only truth available then');
});

// ---------------------------------------------------------------------------
// R2 (panel iteration 2, 2026-08-23): the install receipts are on the FLOOR.
// The emitter always sends skills_from_rocks, so the page must (a) list it
// under the always-shared group, (b) project it from the full snapshot in
// FLOOR_KEYS, and (c) never gate it behind Skill engagement. Pinned against the
// emitter's source, not a copy: the floor is whatever is assigned OUTSIDE the
// shareEngagement / shareActivity branches.
test('the install receipts ride the floor on both sides of the wire', () => {
  const block = emitter.slice(emitter.indexOf('const hb = {'), emitter.indexOf('const dir = path.join'));
  const literal = block.slice(0, block.indexOf('};') + 2);
  assert.match(literal, /skills_from_rocks:/, 'the emitter must put the receipts in the unconditional literal, not behind a toggle');
  assert.doesNotMatch(block.slice(literal.length), /skills_from_rocks/, 'and never assign them inside a gated branch');
  const floor = html.match(/var FLOOR_KEYS = \[([^\]]*)\]/);
  assert.ok(floor, 'FLOOR_KEYS must exist');
  assert.match(floor[1], /'skills_from_rocks'/, 'the page projects the floor from FLOOR_KEYS; the receipts belong there');
  const row = html.match(/k: 'skills_from_rocks'[^\n]*/);
  assert.ok(row, 'a row must say the receipts leave');
  assert.match(row[0], /cat: '__floor__'/, 'under the always-shared group');
  assert.match(row[0], /mean: '[^']{25,}/, 'with a plain-English meaning');
  assert.match(row[0], /[Nn]ever what they did/, 'and the limit stated: which and what version, not what they did');
});
