// overview-strength.test.mjs — the strength checklist is DEAD, absorbed by the
// capability ladder (Sam, 2026-08-17: "now that we have this, we probably don't
// need this section"). What this file pins now is the absorption contract: the
// card is gone, its R3 item sets live on inside ladderModel, and every pending
// item's way in (the delegated Do-it route) survives as a ladder act. The
// original R5/R3 card pins died with the card; this is their successor, kept
// under the old filename so the retirement is findable from the tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const lib = html.slice(html.indexOf('var CARDS = ['), html.indexOf('function faceCards('));
const model = html.match(/function ladderModel\(d\)\{[\s\S]*?\n {2}\}/)[0];

test('the strength card is actually dead', () => {
  assert.ok(!lib.includes("id: 'strength'"), 'no CARDS entry');
  assert.ok(!html.includes('Make your rock stronger'), 'no rock copy');
  assert.ok(!html.includes('Make your pebble stronger'), 'no pebble copy');
  assert.ok(!html.includes('class="strmeter"'), 'the segmented meter died with it');
});

test('strengthSync survives the card it was named for — the ladder reads its truths', () => {
  assert.match(html, /function strengthSync\(\)/);
  for (const key of ['registered', 'listed', 'published', 'orgBackup', 'backup', 'anchored']) {
    assert.ok(model.includes(`sx.${key}`), `ladderModel reads sx.${key}`);
  }
});

test('the pebble items were absorbed, none dropped', () => {
  // R3's six: Claude sign-in and the backup are RUNGS; the other four are rows
  for (const name of ['Sign in to Claude on your mineral', 'Make your first backup',
    'Connect email + calendar', 'Message it on Telegram', 'Run scheduled tasks', 'Join a rock']) {
    assert.ok(model.includes(`'${name}'`), `"${name}" lives in the ladder`);
  }
});

test('the rock items were absorbed, none dropped', () => {
  // R3's seven: brain + Claude are rungs, the rest are rows (listing kept its
  // commCard landing, backup its custody landing)
  for (const name of ['Onboard this rock’s brain', 'Sign in to Claude on this rock',
    'Back up the org brain', 'Reach you on Telegram', 'Run scheduled tasks',
    'List publicly', 'Publish skills']) {
    assert.ok(model.includes(`'${name}'`), `"${name}" lives in the ladder`);
  }
});

test('the ways in survived: acts carry the same delegated routes the checklist used', () => {
  for (const route of ["to: 'skills'", "to: 'connections'", "to: 'rocks'", "to: 'publish'",
    "focus: 'commCard'", "focus: 'rockCustodyCard'", "focus: 'seatBackupCard'",
    "to: 'terminal', run: SIGNIN_OPENER"]) {
    assert.ok(model.includes(route), `route ${route} preserved`);
  }
});

test('an act renders only on an OPEN row: a locked row’s way in is its rung, in the footer', () => {
  // the locked and unread branches of row() return without ever attaching act
  const rowFn = model.match(/var row = function[\s\S]*?\n {4}\};/)[0];
  const branches = rowFn.split('return');
  assert.equal(branches.length, 4, 'three returns: locked, unread, open');
  // 'act:' the property key, not bare 'act': a comment inside the unread branch
  // ("actively resolving", 060dd83) tripped the substring check while the
  // behaviour it pins (no act attached) was intact.
  assert.ok(!branches[1].includes('act:') && !branches[2].includes('act:'),
    'locked and unread rows carry no button');
  assert.ok(branches[3].includes('act: act || null'), 'open rows carry theirs');
});
