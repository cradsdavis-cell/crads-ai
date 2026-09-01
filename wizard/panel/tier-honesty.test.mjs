// tier-honesty.test.mjs — a rock must not be DRAWN as a pebble while nobody
// has actually answered what it is (Harriet, 2026-08-18; same family as ingrid
// 2026-08-17 and the door-identity fix 05936d2, which cured the CLICK path).
//
// The remaining hole the walkthrough exposed: a rock provisioned or promoted
// recently keeps its `<slug>-box` alias, and when the face-probe cache is cold
// AND the account layer has not answered (hotspot, signed out, worker down),
// the door confidently painted "Pebble" — and its click handler routed by that
// same guess to /go/member, so the rock OPENED as a pebble with no error
// anywhere. 05936d2 heals the click that says rock; nothing healed the guess
// that says pebble.
//
// Three layers, one contract:
//   inventory.mjs        rows carry tierKnown — the merge SAYS when the tier is
//                        only the alias guess, instead of asserting it.
//   inventory-routes.mjs a served list containing unsure rows kicks the face
//                        probe ONCE, in the background, and marks those aliases
//                        settled when it completes — fail-open, the guess
//                        stands if the box never answers.
//   door.html            an unsure row's chip says "Checking…", and the door
//                        re-reads the inventory (bounded) until nothing is
//                        unsure, instead of letting a wrong chip sit all
//                        session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collapseLocal, mergeInventory } from './inventory.mjs';
import { inventoryRoutes } from './inventory-routes.mjs';

const tick = () => new Promise((r) => setImmediate(r));

// ------------------------------------------------------------- inventory.mjs
test('a member-only alias is a GUESS and the row says so', () => {
  const local = collapseLocal([{ host: 'aster-box', org: 'aster', kind: 'member' }]);
  assert.equal(local[0].sure, false, 'a -box alias with no rock answer is only a guess');
  const rows = mergeInventory({ local, account: null });
  assert.equal(rows[0].tier, 'pebble', 'the guess itself is unchanged (fail-open)');
  assert.equal(rows[0].tierKnown, false, 'but the row must admit nobody has answered');
});

test('the three real answers all make the tier known', () => {
  // 1. the box's own probe answer (the promoted overlay row)
  const probed = collapseLocal([
    { host: 'aster-box', org: 'aster', kind: 'member' },
    { host: 'aster-box', org: 'aster', kind: 'rock', promoted: true },
  ]);
  assert.equal(probed[0].sure, true, "the box's own answer is not a guess");
  assert.equal(mergeInventory({ local: probed, account: null })[0].tierKnown, true);

  // 2. a -rock alias was installed as one; there is nothing to doubt
  const rockAlias = collapseLocal([{ host: 'acme-rock', org: 'acme', kind: 'rock' }]);
  assert.equal(rockAlias[0].sure, true);
  assert.equal(mergeInventory({ local: rockAlias, account: null })[0].tierKnown, true);

  // 3. the ACCOUNT answered: the directory's tier wins and is known
  const local = collapseLocal([{ host: 'aster-box', org: 'aster', kind: 'member' }]);
  const rows = mergeInventory({
    local,
    account: [{ host: 'aster.crads-ai.com', tier: 'rock', held_by: 'you' }],
  });
  assert.equal(rows[0].tier, 'rock');
  assert.equal(rows[0].tierKnown, true);
});

test('a completed probe SETTLES the guess without changing it', () => {
  // The probe ran and did not promote (a genuine pebble, or the box never
  // answered). The guess stands — but it is now a settled guess, so the door
  // must stop saying "Checking…" and paint Pebble.
  const local = collapseLocal([{ host: 'aster-box', org: 'aster', kind: 'member' }]);
  const rows = mergeInventory({ local, account: null, probed: ['aster-box'] });
  assert.equal(rows[0].tier, 'pebble');
  assert.equal(rows[0].tierKnown, true, 'asked and answered (or asked and fail-open): settled');
});

test('an off-device account row is always known — the account IS the answer', () => {
  const rows = mergeInventory({
    local: [],
    account: [{ host: 'beryl.crads-ai.com', tier: 'pebble', held_by: 'you' }],
    boxes: [],
  });
  assert.equal(rows[0].onDevice, false);
  assert.equal(rows[0].tierKnown, true);
});

// ------------------------------------------------------ inventory-routes.mjs
function fakeRes() {
  const r = { body: '' };
  r.writeHead = () => {};
  r.end = (b) => { r.body = String(b || ''); };
  r.json = () => JSON.parse(r.body);
  return r;
}

test('serving an unsure row kicks the face probe once, and completion settles it', async () => {
  let targets = [{ host: 'aster-box', org: 'aster', kind: 'member' }];
  const calls = [];
  let release;
  const probeFaces = (aliases) => { calls.push(aliases); return new Promise((r) => { release = r; }); };
  const handle = inventoryRoutes({ targets: () => targets, probeFaces });

  const r1 = fakeRes();
  handle({ method: 'GET' }, r1, '/inventory');
  assert.equal(r1.json().rows[0].tierKnown, false, 'first read: nobody has answered yet');
  assert.deepEqual(calls, [['aster-box']], 'the unsure alias went to the probe');

  const r2 = fakeRes();
  handle({ method: 'GET' }, r2, '/inventory');
  assert.equal(calls.length, 1, 'a probe already in flight is not launched twice');

  // the box answered rock: the probe registered the second face, so the ssh
  // config now yields the overlay row — exactly what registerPromotedHost does
  targets = [
    { host: 'aster-box', org: 'aster', kind: 'member' },
    { host: 'aster-box', org: 'aster', kind: 'rock', promoted: true },
  ];
  release();
  await tick();

  const r3 = fakeRes();
  handle({ method: 'GET' }, r3, '/inventory');
  assert.equal(r3.json().rows[0].tier, 'rock', 'the answer reached the list');
  assert.equal(r3.json().rows[0].tierKnown, true);
});

test('a probe that finds nothing still settles the rows it asked about', async () => {
  const targets = [{ host: 'coral-box', org: 'coral', kind: 'member' }];
  let release;
  const probeFaces = () => new Promise((r) => { release = r; });
  const handle = inventoryRoutes({ targets: () => targets, probeFaces });

  handle({ method: 'GET' }, fakeRes(), '/inventory');
  release();               // completed, promoted nothing: a real pebble
  await tick();

  const r = fakeRes();
  handle({ method: 'GET' }, r, '/inventory');
  assert.equal(r.json().rows[0].tier, 'pebble', 'the guess stands (fail-open)');
  assert.equal(r.json().rows[0].tierKnown, true, 'but it is settled, not still "checking"');
});

test('no probeFaces wired (panel-server) stays exactly as before — no crash, honest rows', () => {
  const handle = inventoryRoutes({ targets: () => [{ host: 'aster-box', org: 'aster', kind: 'member' }] });
  const r = fakeRes();
  handle({ method: 'GET' }, r, '/inventory');
  assert.equal(r.json().rows[0].tierKnown, false);
});

// ------------------------------------------------------------------ door.html
test('the chip does not assert a tier nobody has answered', () => {
  const html = readFileSync(new URL('./door.html', import.meta.url), 'utf8');
  const fn = html.match(/function kindChip\([^)]*\)\{[\s\S]{0,400}?\}/);
  assert.ok(fn, 'kindChip exists');
  assert.match(fn[0], /tierKnown/, 'the chip consults tierKnown, not tier alone');
  assert.match(fn[0], /Checking/, 'an unanswered tier says Checking…, not Pebble');
});

test('the door re-reads the inventory while a tier is unsure, and the re-read is bounded', () => {
  const html = readFileSync(new URL('./door.html', import.meta.url), 'utf8');
  const fn = html.match(/function repollUnsureTiers\(\)\{[\s\S]{0,900}?\n  \}/);
  assert.ok(fn, 'repollUnsureTiers exists');
  assert.match(fn[0], /tierKnown === false/, 'it looks for unsettled rows');
  assert.match(html, /firstLoad\.then\(\s*repollUnsureTiers\s*\)/,
    'it starts after the first load, when the incident actually bites');
  assert.match(fn[0], /unsureRepolls\s*>=/, 'and it is bounded: fail-open to the guess, never a spin');
});
