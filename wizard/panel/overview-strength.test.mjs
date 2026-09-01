// overview-strength.test.mjs — the strength checklist is DEAD, absorbed by the
// capability ladder (Sam, 2026-08-17: "now that we have this, we probably don't
// need this section"). What this file pins now is the absorption contract: the
// card is gone, its item sets live on inside ladderModel, and every pending
// item's way in survives as a ladder act. The face collapse (2026-09-01)
// rewrote the sets again: the rock rungs died with the org face, "Join a rock"
// became the community pair, and the strength truths narrowed to what a
// self-hosted mineral can know about itself (its backup, its communities).
// Kept under the old filename so both retirements are findable from the tests.
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

test('strengthSync survives the card it was named for, narrowed to self-known truths', () => {
  assert.match(html, /function strengthSync\(\)/);
  // The directory-fed flags (registered, listed, published, anchored, the org
  // backup) died with the directory. What a self-hosted mineral knows about
  // itself: its own backup state and the communities it has joined.
  for (const key of ['backup', 'backupConnected', 'communities']) {
    assert.ok(model.includes(`sx.${key}`), `ladderModel reads sx.${key}`);
  }
  for (const key of ['registered', 'listed', 'published', 'orgBackup', 'anchored']) {
    assert.ok(!model.includes(`sx.${key}`), `sx.${key} stays gone: nothing central answers it`);
  }
  // And the sync reads both truths from the mineral itself, never a directory.
  const sync = html.slice(html.indexOf('function strengthSync'), html.indexOf('// ---- the card library'));
  assert.match(sync, /run\('member-console-state'/, 'backup truths ride the console state');
  assert.match(sync, /run\('community-list'/, 'community count rides the community list');
  assert.ok(!sync.includes('/rock-mine'), 'the directory tie read stays gone');
  assert.ok(!sync.includes('/community-catalogs'), 'and so does the catalog probe');
});

test('the member items were absorbed, none dropped; the rock set died with the org face', () => {
  for (const name of ['Sign in to Claude on your mineral', 'Make your first backup',
    'Connect email + calendar', 'Message it on Telegram', 'Run scheduled tasks',
    'Join a community', 'Joined a community', 'Install skills from your community',
    'Add another device', 'Host a community']) {
    assert.ok(model.includes(`'${name}'`), `"${name}" lives in the ladder`);
  }
  // The rock rungs are retired whole: a mineral that hosts a commons is still
  // a mineral, so there is no second item set.
  for (const dead of ['Onboard this rock’s brain', 'Sign in to Claude on this rock',
    'Back up the org brain', 'Reach you on Telegram', 'List publicly', 'Publish skills',
    'Join a rock', 'Become a rock', 'Registered with Crads-AI']) {
    assert.ok(!model.includes(`'${dead}'`), `"${dead}" stays gone`);
  }
});

test('the ways in survived: acts carry delegated routes into living surfaces', () => {
  for (const route of ["to: 'skills'", "to: 'connections'", "to: 'commons'",
    "to: 'publish', focus: 'commonsCard'", "focus: 'seatBackupCard'",
    "to: 'terminal', run: SIGNIN_OPENER"]) {
    assert.ok(model.includes(route), `route ${route} preserved`);
  }
  // Dead landings must not come back: the Rocks page and the org custody card
  // no longer exist to land on.
  for (const dead of ["to: 'rocks'", "focus: 'commCard'", "focus: 'rockCustodyCard'"]) {
    assert.ok(!model.includes(dead), `route ${dead} stays gone`);
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
