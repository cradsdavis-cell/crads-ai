// pebble-walk.test.mjs — the member-side defects from the 2026-08-13 walk.
//   node --test wizard/panel/pebble-walk.test.mjs
//
// Every assertion here corresponds to something a member SAW, not to a shape I
// liked. The walk that produced them (findings 113-118) is written up in
// docs/archive/baseline-test.md § Loop 6.
//
// What they have in common is that none of them could fail a test that existed:
// two were copy, one was a one-word rename inside a string literal, and one was
// a field the box knew and never sent. So each test below pins the BEHAVIOUR at
// the point where it was actually wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');
const fn = (name, next) => html.split('function ' + name + '(')[1].split('function ' + next + '(')[0];

// ---------------------------------------------------------------- finding 113
//
// dd96bd8 ("vocab: parent becomes rock, child becomes pebble, across code,
// paths and the wire") renamed three call sites in the injected iframe shim.
// `parent` there is not our vocabulary, it is the DOM's only handle back to the
// app, so all three threw ReferenceError and every member page broke: content
// clipped at the default height, and pageApi.run/refresh dead.
//
// The rename was plausible, mechanical and invisible in review, which is why
// this is asserted on the STRING THAT IS EVALUATED rather than on behaviour
// further out: the next vocabulary sweep will look exactly as reasonable.
test('the page shim talks to the app through parent, never through a renamed noun', () => {
  const shim = fn('pageShim', 'renderPageSandbox');
  assert.ok(!/\brock\.postMessage\b/.test(shim),
    'rock.postMessage is a ReferenceError inside the iframe: there is no such binding there');
  const calls = shim.match(/parent\.postMessage/g) || [];
  assert.equal(calls.length, 3, 'all three bridges (run, refresh, height) address parent');
  // and each one individually, so a partial revert cannot pass on the count
  assert.match(shim, /pageApi=\{[\s\S]*run:function[\s\S]*?parent\.postMessage\(\{pageRpc:"run"/, 'run');
  assert.match(shim, /refresh:function\(\)\{parent\.postMessage\(\{pageRpc:"refresh"\}/, 'refresh');
  assert.match(shim, /function __rep\(\)\{parent\.postMessage\(\{pageRpc:"height"/, 'height');
});

test('the sandbox that shim runs in is still opaque, so parent is the only way out', () => {
  const r = fn('renderPageSandbox', 'pageBridge');
  assert.match(r, /setAttribute\('sandbox', 'allow-scripts'\)/,
    'no allow-same-origin: the page cannot reach the app DOM, which is what makes the bridge necessary');
});

// ------------------------------------------------------------ finding 114/115
//
// An anchored, org-managed pebble was told "You have not tied to any rocks yet.
// You own your pebble; it is hosted and billed directly" — while Your pebble,
// the Map and the same page's own card said the opposite — and was then offered
// Join and Ask to anchor on the very rock anchoring it.
//
// Cause: this page rode /rock-mine alone, whose edges are keyed to the SIGNED-IN
// ACCOUNT at the directory, and has several ordinary ways to come back empty.
// The mineral's own record was never consulted.
test('the box sends the anchor SLUG, not just the bool: a name cannot be derived from true', () => {
  assert.match(server, /anchored,anchor:\(own\.anchor&&own\.anchor!=="crads-ai"\?own\.anchor:""\)/,
    'console-state carries ownership.json.anchor, with the Mountain sentinel read as unanchored');
});

test('a mineral that records an anchor is never told it has no rocks', () => {
  const map = fn('rockTieMap', 'rockOwnLine');
  assert.match(map, /if \(!IS_ORG && rockLocalAnchor && rockLocalAnchor\.org && !m\[rockLocalAnchor\.org\]\)/,
    'the local anchor seeds the tie map when the directory has not named it');
  assert.match(map, /tie: 'anchored'/, 'as an anchor, which is what it is');
  assert.match(map, /local: true/, 'flagged, so the page can tell a mineral fact from a directory fact');
  // the directory may ADD rocks to this page; it may never remove the anchor
  assert.ok(map.indexOf('rockMineSt') < map.indexOf('rockLocalAnchor'),
    'directory rows first, then the floor: a directory row for the same rock wins on detail');
});

test('the anchor survives being signed out, because signing in is not what makes it true', () => {
  const mine = fn('rockRenderMine', 'rockConsumeWanted');
  const signedOut = mine.slice(0, mine.indexOf('var seenTie'));
  assert.match(signedOut, /if \(rockLocalAnchor\) \{[\s\S]*rockRow\(rockLocalAnchor\.org/,
    'the signed-out branch still renders the anchor row');
  assert.match(signedOut, /Sign in once to see any other rocks you belong to\./,
    'and the prompt narrows to the rocks it can actually speak for');
});

test('the board cannot offer a member the rock that already anchors them', () => {
  const board = fn('rockRenderBoard', 'rockRenderMine');
  assert.match(board, /\.filter\(function\(c\)\{ return !tiedHere\[c\.org\]; \}\)/, 'ties are subtracted');
  // 182 narrowed the subtraction to the PICKED mineral's ties, and the locally-
  // recorded anchor is exactly that mineral's own tie: it must stay in the set,
  // or the signed-out board would offer the anchoring rock a Join it refuses.
  assert.match(board, /if \(rockLocalAnchor && rockLocalAnchor\.org\) tiedHere\[rockLocalAnchor\.org\] = true;/,
    'the mineral\'s local anchor still hides its rock, signed in or not');
});

test('a tie known only to the mineral offers no button the worker would refuse', () => {
  const blk = fn('rockTieBlock', 'rockBrainBlock');
  assert.match(blk, /if \(tie && tie\.local\) \{/, 'the local case comes first');
  assert.match(blk, /Sign in above to change it\./, 'and says what would make the action possible');
  const localBranch = blk.slice(blk.indexOf('tie.local'), blk.indexOf('} else if'));
  assert.ok(!/rockLeave/.test(localBranch), 'no Leave button on a tie the directory has not confirmed');
});

// ---------------------------------------------------------------- finding 116
//
// The member's only computer was called "Approved by your rock" — a status
// phrase where a name belongs — under a slug made of its own fingerprint. That
// is the list you revoke a lost laptop from, and two devices would have read
// identically. The self-serve path (/enrol-request) had carried device_name
// since it shipped; the admin-first claim path (/redeem) dropped it.
test('the claim path names the machine, exactly as the enrol path always did', () => {
  const mc = readFileSync(new URL('./member-connect.mjs', import.meta.url), 'utf8');
  assert.match(mc, /device_name: machineName\(\)/, 'the /redeem body carries it');
  assert.match(mc, /import \{ machineName \} from '\.\/machine-name\.mjs'/,
    'from the shared module, not a second copy that could drift from the enrol path');
  const de = readFileSync(new URL('./device-enrol.mjs', import.meta.url), 'utf8');
  assert.match(de, /export \{ machineName, machineSlug \} from '\.\/machine-name\.mjs'/,
    're-exported, so every existing importer keeps working');
  assert.match(de, /device_name: machineName\(deviceName\)/, 'and the enrol path is unchanged');
});

test('the worker relay pin is RETIRED (2026-09-01): the directory worker is deleted', () => {
  // The name now travels no further than this machine: there is no worker to
  // relay it. The panel-side half of the old parity (send-without-interpreting)
  // is still covered by the panel tests around this one.
  assert.ok(!existsSync(new URL('../../directory/worker.js', import.meta.url)),
    'the worker source is gone; resurrecting it re-arms this pin');
});

test('an adopted device that still has no name is at least tellable from the next one', async () => {
  const whole = readFileSync(new URL('../../engine/devices/device-sync.mjs', import.meta.url), 'utf8');
  const ds = whole.slice(whole.indexOf('function adoptOrgApprovedKeys('), whole.indexOf('export function syncKeys('));
  assert.match(ds, /member\.device_names/, 'the pushed-down names file is read');
  assert.match(ds, /const named = pushedNames\.get\(fp\) \|\| '';/, 'and keyed by fingerprint');
  assert.match(ds, /label: named \|\| \('Approved by your rock · ' \+ fp/,
    'the fallback carries the safety code, so two unnamed rows are not one label twice');
  assert.match(ds, /let slug = named\s*\?[\s\S]{0,300}?:\s*'approved-' \+ fp/,
    'a named device slugs from its name, matching enrol-sync; an unnamed one keeps the fingerprint slug');
  // the names file must never become a way to push content onto a member box
  assert.match(ds, /\.replace\(\/\[\^\\x20-\\x7E\]\/g, ''\)\.trim\(\)\.slice\(0, 60\)/, 'bounded on arrival too');
});

// ---------------------------------------------------------------- finding 117
test('every skill the pebble-template ships has a human title', () => {
  const dir = new URL('../../../brain-template/pebble-template/skills/', import.meta.url);
  let names;
  try { names = readFileSync(new URL('./eod.md', dir), 'utf8') && ['eod.md', 'pulse.md']; }
  catch { return; }   // brain-template is a sibling repo; skip where it is absent
  for (const f of names) {
    const front = readFileSync(new URL('./' + f, dir), 'utf8').split('---')[1] || '';
    assert.match(front, /^title:\s*"[^"]+"/m,
      `${f} has no title:, so the Skills page shows a capitalised slug ("Eod")`);
  }
});

// ---------------------------------------------------------------- finding 118
test('one rock is called one thing on one page', () => {
  const seat = fn('loadSeat', 'seatRenameApply');
  assert.match(seat, /rockNoteAnchor\(st\);\s+\/\/ the Rocks page and Origin below both read it/,
    'the seat records the anchor before it renders anything that names it');
  assert.match(seat, /var seededBy = lin && lin\.stamped_by/, 'Origin resolves the slug');
  assert.match(seat, /\(rockLocalAnchor \|\| \{\}\)\.name \|\| lin\.stamped_by/,
    'to the anchor display name when it is the same rock, and keeps the slug when it is not');
  assert.match(seat, /seatRow\('Seeded by', seededBy,/, 'and renders the resolved name');
});

test('counts on the member Welcome page pluralise', () => {
  const w = readFileSync(new URL('../../engine/appshell/templates/pages/welcome.html', import.meta.url), 'utf8');
  assert.match(w, /n === 1 \? one : many/, 'a plural helper exists');
  assert.match(w, /plural\(b\.pages \|\| 0, 'page', 'pages'\)/, 'pages use it');
  assert.match(w, /plural\(b\.people \|\| 0, 'person', 'people'\)/, 'and so do people');
  assert.ok(!/\(b\.pages \|\| 0\) \+ ' pages/.test(w), 'the raw "1 pages" concatenation is gone');
});
