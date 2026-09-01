// cards-faces.test.mjs — the unified overview pipeline (S4, rulings 2026-08-09).
// ONE declarative CARDS library serves both faces; renderOrgOverview, the
// customise mode and the cards.json override path are dead. These pins keep
// the two overviews from ever growing separate render paths again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const lib = html.slice(html.indexOf('var CARDS = ['), html.indexOf('function faceCards('));

const entries = [...lib.matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1]);

test('the card library declares the exact per-face sets', () => {
  // S7 reshuffle (2026-08-10): declaration order still IS the order, but the
  // number cards now ride the STRIP (see the zone pins below), so the GRID rows
  // out to one [strength|health] row on both faces, plus a leading
  // [onboarding|strength] row while onboarding is unfinished. No holes.
  // The connections card left the library 2026-08-13: it was the strength
  // checklist's weaker twin, and status belongs on the Connections page.
  // The capability ladder joined 2026-08-17 (spec: rock-capability-ladder) and
  // absorbed the strength checklist the same day: one card owns the what-can-I-
  // do-and-what-next question, so 'strength' is dead alongside 'connections'.
  // billing left the library with the self-host strip (2026-09-01): the
  // product is free and self-hosted, so there is nothing to bill.
  assert.deepEqual(entries, ['assistant', 'onboarding', 'ladder', 'brain', 'orgbrain',
    'pebbles', 'waiting', 'health', 'skills', 'platform'],
    'declaration order IS the grid order now (customise is dead)');
  assert.ok(!entries.includes('billing'), 'the billing card stays dead (self-host strip)');
  assert.ok(!entries.includes('connections'), 'the Overview connections card stays dead');
  assert.ok(!entries.includes('strength'), 'the strength checklist stays dead too (absorbed by the ladder)');
  const facesOf = (id) => {
    const seg = lib.slice(lib.indexOf(`id: '${id}'`), lib.indexOf(`id: '`, lib.indexOf(`id: '${id}'`) + 6) === -1
      ? undefined : lib.indexOf(`{ id: '`, lib.indexOf(`id: '${id}'`) + 6));
    const m = seg.match(/faces: \[([^\]]*)\]/);
    return m ? m[1].replace(/['\s]/g, '').split(',') : ['member'];
  };
  for (const id of ['assistant', 'onboarding', 'ladder', 'health', 'skills']) {
    assert.deepEqual(facesOf(id), ['member', 'org'], `${id} is shared`);
  }
  for (const id of ['orgbrain', 'pebbles', 'waiting', 'platform']) {
    assert.deepEqual(facesOf(id), ['org'], `${id} is rock-only`);
  }
  assert.deepEqual(facesOf('brain'), ['member'], 'brain is member-only (orgbrain is its rock twin)');
});

test('faceCards filters by edition and honours when()', () => {
  assert.match(html, /var face = IS_ORG \? 'org' : 'member';/);
  assert.match(html, /c\.faces \|\| \['member'\]/, 'member is the default face');
  assert.match(html, /!c\.when \|\| c\.when\(state\.data\)/, 'conditional cards honoured');
});

test('promotion is declarative and the FLIP rig keys on the promoted set', () => {
  assert.match(html, /c\.promote && c\.promote\(state\.data\)/);
  assert.match(lib, /promote: function\(d\)\{ return IS_ORG && !pebbleGate\(d\)\.ready; \}/,
    'anything blocking pebble creation leads the grid, not the onboarding half of it');
  assert.match(lib, /promote: function\(d\)\{ return healthState\(d\) !== ''; \}/, 'an unwell box leads the grid');
  assert.match(html, /promoted\.map\(function\(c\)\{ return c\.id; \}\)\.join\(','\)/, 'FLIP keys on the promoted ids');
});

test('R2: cards carry inline action buttons on the delegated route, never whole-card links', () => {
  assert.match(html, /c\.actions \? c\.actions\(state\.data\) : \[\]/);
  assert.match(html, /class="cardacts"/, 'actions render in a footer');
  assert.ok(!html.includes("d.setAttribute('role', 'link')"), 'whole-card link cards are gone');
});

// ---- S7 reshuffle (2026-08-10): two zones, one library --------------------
// The S6 grid floored every card at min-height:164px, so a card carrying one
// number and a link took the same slot as the 287px Health card and left a
// hole where it shared a row with it (measured at 1440x900: rock row 3 skills
// 123px / billing 88px, pebble row 2 123px twice). Numbers moved to a compact
// strip above the grid; the grid keeps only the cards that hold work.
test('the number cards ride the strip and each carries a compact tile body', () => {
  const zoneOf = (id) => {
    const seg = lib.slice(lib.indexOf(`id: '${id}'`));
    const m = seg.slice(0, seg.indexOf('render:')).match(/zone: ('strip'|function)/);
    return m ? m[1] : null;
  };
  for (const id of ['brain', 'orgbrain', 'pebbles', 'waiting', 'skills', 'platform']) {
    assert.equal(zoneOf(id), "'strip'", `${id} is a number, not work: it belongs on the strip`);
    const seg = lib.slice(lib.indexOf(`id: '${id}'`));
    assert.match(seg.slice(0, seg.indexOf('render:')), /tile: function/, `${id} declares a tile body`);
  }
  // work stays in the grid (strength retired into the ladder 2026-08-17)
  for (const id of ['ladder', 'health']) {
    assert.equal(zoneOf(id), null, `${id} holds work and keeps a full card`);
  }
  // onboarding is the one card that is BOTH, decided by its own state — and
  // since 2026-08-17 ONLY its own state: the pebble-gate half of the old rock
  // rule moved to the ladder with the rest of the gate story.
  assert.equal(zoneOf('onboarding'), 'function', 'onboarding chooses its zone from the data');
  assert.match(lib, /return \(d\.onboarding \|\| \{\}\)\.phase === 'done' \? 'strip' : 'grid';/,
    'unfinished onboarding keeps a full card; done retires to the strip, on both faces');
});

// ---- one gate is not the gate (2026-08-14) --------------------------------
// The strip tile read "8 of 8 · pebbles unlocked" on a rock whose Pebbles page
// was refusing at the same moment, because the card measured the rock's own
// onboarding and announced the outcome of BOTH gates. Sam: "There are other
// things that block pebble creation, not just the context onboarding."
test('the LADDER answers for both gates; onboarding speaks only for its 8 layers', () => {
  assert.match(html, /function pebbleGate\(d\)/, 'one helper owns the whole answer');
  // Comments stripped: the finding is quoted in them on purpose, and copy is
  // what ships. This checks what a user can read, not what the source discusses.
  const copy = html.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!copy.includes('pebbles unlocked'),
    'no surface may claim the unlock from the onboarding count');
  assert.ok(!copy.includes('this rock can create pebbles'),
    'and none may claim it from the onboarding phase either');

  // 2026-08-17 (Sam): the gate story moved wholesale to the ladder, so the
  // onboarding card went back to being about onboarding — its title says
  // context, its body never mentions pebbles, and the whole-gate reader
  // (pebbleGate) appears only in the ladder's closures.
  const seg = lib.slice(lib.indexOf("id: 'onboarding'"));
  const card = seg.slice(0, seg.indexOf("id: 'ladder'"));
  assert.match(card, /'Onboarding context' : 'Onboarding'/, 'titled for what it measures');
  assert.ok(!card.includes('pebbleGate'), 'the onboarding card no longer speaks for the build gate');
  assert.ok(!/[Pp]ebbles/.test(card.replace(/^\s*\/\/.*$/gm, '')), 'and its copy never mentions pebbles');
  const ladder = lib.slice(lib.indexOf("id: 'ladder'"), lib.indexOf("id: 'brain'"));
  assert.match(ladder, /promote: function\(d\)\{ return IS_ORG && !pebbleGate\(d\)\.ready; \}/,
    'anything blocking pebble creation still leads the grid, from the ladder now');

  // pebbleGate itself: unknown is never ready, and the brokered ask is not a gap
  const fn = html.match(/function pebbleGate\(d\)\{[\s\S]*?\n {2}\}/)[0];
  const gate = (ob, armed, canAsk, needsGh) => new Function(
    'factoryArmed', 'factoryCanAsk', 'factoryNeedsGh', 'factoryGapNames',
    `${fn} return pebbleGate({ onboarding: { phase: ${JSON.stringify(ob)} } });`
  )(armed, canAsk, needsGh, 'server provider');

  assert.equal(gate('done', true, false, false).ready, true, 'onboarded + armed = ready');
  assert.equal(gate('done', false, false, true).ready, false, 'onboarded but no GitHub is NOT ready');
  assert.equal(gate('done', false, false, true).blocked, true, 'and it is a known block');
  assert.equal(gate('review', true, false, false).ready, false, 'armed but un-onboarded is NOT ready');
  assert.equal(gate('done', null, false, false).ready, false, 'an unread factory never promises');
  assert.equal(gate('done', null, false, false).blocked, false, 'and never blocks either');
  assert.equal(gate('done', false, true, false).ready, true, 'the brokered ask is a route, not a gap');
  assert.equal(gate('review', false, false, true).missing.length, 2, 'both blockers are named, not just the first');
});

test('renderCards routes by zone and the strip is one capped row', () => {
  assert.match(html, /var asTile = zone === 'strip' && !!c\.tile;/, 'a strip card without a tile body falls back to the grid');
  assert.match(html, /\(asTile \? strip : grid\)\.appendChild\(el\)/);
  assert.match(html, /el\.className = asTile \? 'dcard tile' : 'dcard'/, 'tiles keep .dcard so st-warn and the typography come for free');
  assert.match(html, /strip\.style\.gridTemplateColumns = 'repeat\(' \+ nTiles \+ ',minmax\(0,1fr\)\)'/, 'one track per tile: the strip never wraps');
  assert.match(html, /strip\.style\.maxWidth = \(nTiles \* 200 \+ \(nTiles - 1\) \* 14\) \+ 'px'/,
    'capped at tile width so a three-stat face packs left instead of stretching to a third of the page each');
  assert.match(html, /strip\.style\.display = nTiles \? '' : 'none'/, 'an empty strip leaves no gap');
  assert.match(html, /\['cardGrid', 'cardStrip'\]\.forEach/, 'the delegated data-target route covers both zones');
  assert.match(html, /\.dcard\.tile\{min-height:0/, 'the 164px floor is exactly what the tile drops');
});

test('spans live on the card defs; the 12-column absorb walk survives', () => {
  // span may be a function of the data since the ladder (2026-08-17): 8 while
  // the onboarding card shares its row, 12 once it retires to the strip
  assert.match(html, /typeof c\.span === 'function' \? c\.span\(state\.data\) : c\.span/);
  assert.match(html, /span = 12 - col/, 'last card absorbs its row');
});

test('the dead pipeline is actually dead', () => {
  for (const sym of ['function renderOrgOverview(', 'function loadOrgOverviewExtras(',
    'function tplCard(', 'function allCards(', 'function orderedCards(', 'var CARD_SPANS',
    "$('custBtn')", "$('custSave')", 'state.customise']) {
    assert.ok(!html.includes(sym), `${sym} must not survive`);
  }
});

test('both faces ride loadDashboard: the org rising edge pulls the spine, extras retired', () => {
  // loadPagesList joined the org rising edge 2026-08-23 (panel iteration 2, R15: pages on rocks)
  assert.match(html, /if \(!quiet \|\| !wasOk\) \{ loadDashboard\(true\); loadFleetHealth\(\); checkOnboard\(\); loadPlane\(\); govLoad\(\); loadPagesList\(\); \}/);
  assert.match(html, /if \(name === 'dashboard'\) \{ loadJoinRequests\(\); loadPending\(\); govLoad\(\); loadDashboard\(\); loadRockState\(\); loadCommunityDoor\(\); \}/);
});

test('the hero is shared and face-aware; the member banner never leaks onto the org face', () => {
  assert.match(html, /function renderHero\(\)/);
  assert.match(html, /if \(!IS_ORG\) \$\('ccBanner'\)\.style\.display/, 'ccBanner is member-only');
  // The org hero counts members through the oracle and says nothing else
  // (2026-08-25: it used raw index rows and the word "pebbles"; the count now
  // matches the Members tile and Your rock, and stays blank until both halves
  // of the snapshot have landed). The name it used to try to prefix here is
  // the rock's own, which the hero line above already carries (one name,
  // 2026-08-14, docs/naming.md).
  assert.match(html, /\[total === null \? '' : total \+ ' member' \+ \(total === 1 \? '' : 's'\)\]/, 'org hero counts members, oracle-fed, unknown-safe');
  assert.match(html, /\[state\.data\.pebble, state\.data\.business, state\.data\.stage\]/, 'the member hero names the person');
});
