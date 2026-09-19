// cards-faces.test.mjs — the unified overview pipeline (S4, rulings 2026-08-09).
// ONE declarative CARDS library; renderOrgOverview, the customise mode and the
// cards.json override path are dead. The face collapse (2026-09-01) finished
// the job: the faces machinery itself is gone, every card renders on the one
// face, and the org-only cards (orgbrain, pebbles, waiting, platform) died
// with the pages they linked. These pins keep a second render path, and a
// second face, from ever growing back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const lib = html.slice(html.indexOf('var CARDS = ['), html.indexOf('function faceCards('));

const entries = [...lib.matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1]);

test('the card library declares the one set, in grid order', () => {
  // Declaration order still IS the order (customise stays dead). The
  // connections card left 2026-08-13, strength was absorbed by the ladder
  // 2026-08-17, billing left with the self-host strip, and the four org cards
  // left with the org face (2026-09-01).
  assert.deepEqual(entries, ['assistant', 'onboarding', 'ladder', 'brain', 'health', 'skills'],
    'declaration order IS the grid order now');
  for (const dead of ['billing', 'connections', 'strength', 'orgbrain', 'pebbles', 'waiting', 'platform']) {
    assert.ok(!entries.includes(dead), `the ${dead} card stays dead`);
  }
});

test('the faces machinery is RETIRED (2026-09-01): every card renders on the one face', () => {
  assert.ok(!lib.includes('faces:'), 'no card declares a face');
  assert.ok(!html.includes('IS_ORG'), 'no face flag to filter by');
  const fc = html.slice(html.indexOf('function faceCards('), html.indexOf('function renderCards('));
  assert.match(fc, /return CARDS\.filter\(function\(c\)\{ return !c\.when \|\| c\.when\(state\.data\); \}\);/,
    'faceCards keeps only the when() gate: conditional cards, never facial ones');
});

// The LOCAL face (2026-09-11) is the ONE face axis the shell is permitted,
// and it is named: body[data-face], written from the target's kind by
// applyFace() and read only by CSS. It hides what needs a server; it never
// grows a second render path (no card declares a face, the pipeline is one).
test('exactly one face axis, named: body[data-face] from the target kind, read by CSS, no second pipeline', () => {
  assert.equal((html.match(/document\.body\.dataset\.face = /g) || []).length, 1, 'exactly one writer of the face axis');
  assert.match(html, /body\[data-face="local"\] \[data-needs-box\]\{display:none !important\}/, 'the axis hides what needs a server');
  for (const sec of ['connections', 'secrets', 'terminal']) {
    assert.match(html, new RegExp(`body\\[data-face="local"\\] section\\[data-sec="${sec}"\\]`), `${sec} is gated by selector, its tag untouched`);
  }
  // 2026-09-18: connections work on a folder (Claude Code's own), so the
  // one-liner stopped claiming they need a server, and the Connections and
  // Terminal pages stay, hiding only their box half.
  assert.ok(html.includes('data-needs-box-note>Scheduled jobs and Telegram need a server.'), 'the honest one-liner beside each hidden group');
  assert.ok(!/Telegram and connections need a server/i.test(html), 'no surface still says connections need a server');
  for (const sec of ['connections', 'terminal']) {
    assert.match(html, new RegExp(`body\\[data-face="local"\\] section\\[data-sec="${sec}"\\] > :not\\(\\.pagehead\\):not\\(\\[data-local-only\\]\\)`), `${sec}: only the box half hides on a folder`);
    assert.ok(!new RegExp(`body\\[data-face="local"\\] #nav button\\[data-sec="${sec}"\\]`).test(html), `${sec} keeps its nav entry on a folder`);
  }
  assert.ok(!lib.includes('faces:') && !lib.includes('face:'), 'no card declares a face: the axis is CSS, the pipeline stays one');
  assert.ok(!html.includes('IS_LOCAL'), 'no second face flag: state.kind is read where it is needed, never a global');
});

test('promotion is declarative and the FLIP rig keys on the promoted set', () => {
  assert.match(html, /c\.promote && c\.promote\(state\.data\)/);
  // The pebble-gate promotion died with the gate; an unwell box still leads.
  assert.match(lib, /promote: function\(d\)\{ return healthState\(d\) !== ''; \}/, 'an unwell box leads the grid');
  assert.ok(!lib.includes('pebbleGate'), 'no card asks the retired build gate');
  assert.match(html, /promoted\.map\(function\(c\)\{ return c\.id; \}\)\.join\(','\)/, 'FLIP keys on the promoted ids');
});

test('R2: cards carry inline action buttons on the delegated route, never whole-card links', () => {
  assert.match(html, /c\.actions \? c\.actions\(state\.data\) : \[\]/);
  assert.match(html, /class="cardacts"/, 'actions render in a footer');
  assert.ok(!html.includes("d.setAttribute('role', 'link')"), 'whole-card link cards are gone');
});

// ---- S7 reshuffle (2026-08-10): two zones, one library --------------------
// Numbers ride a compact strip above the grid; the grid keeps only the cards
// that hold work. The org number tiles died with their pages; brain and
// skills are the strip that remains.
test('the number cards ride the strip and each carries a compact tile body', () => {
  const zoneOf = (id) => {
    const seg = lib.slice(lib.indexOf(`id: '${id}'`));
    const m = seg.slice(0, seg.indexOf('render:')).match(/zone: ('strip'|function)/);
    return m ? m[1] : null;
  };
  for (const id of ['brain', 'skills']) {
    assert.equal(zoneOf(id), "'strip'", `${id} is a number, not work: it belongs on the strip`);
    const seg = lib.slice(lib.indexOf(`id: '${id}'`));
    assert.match(seg.slice(0, seg.indexOf('render:')), /tile: function/, `${id} declares a tile body`);
  }
  // work stays in the grid
  for (const id of ['ladder', 'health']) {
    assert.equal(zoneOf(id), null, `${id} holds work and keeps a full card`);
  }
  // onboarding is the one card that is BOTH, decided by its own state
  assert.equal(zoneOf('onboarding'), 'function', 'onboarding chooses its zone from the data');
  assert.match(lib, /return \(d\.onboarding \|\| \{\}\)\.phase === 'done' \? 'strip' : 'grid';/,
    'unfinished onboarding keeps a full card; done retires to the strip');
});

// ---- one gate is not the gate (2026-08-14), and then no gate at all -------
// The strip tile once read "8 of 8 · pebbles unlocked" while the Pebbles page
// refused, because the card measured one gate and announced two. The fix put
// the whole answer in the ladder; the face collapse then retired the build
// gate outright. What must hold: the onboarding card speaks only for its 8
// layers, and no surface claims a pebble unlock it cannot see.
test('onboarding speaks only for its 8 layers; the pebble gate stays retired', () => {
  assert.ok(!html.includes('function pebbleGate('), 'the build-gate resolver stays gone');
  const copy = html.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!copy.includes('pebbles unlocked'), 'no surface claims the retired unlock');
  assert.ok(!copy.includes('this rock can create pebbles'), 'from any phrasing');
  const seg = lib.slice(lib.indexOf("id: 'onboarding'"));
  const card = seg.slice(0, seg.indexOf("id: 'ladder'"));
  assert.match(card, /title: 'Onboarding'/, 'titled for what it measures');
  assert.ok(!/[Pp]ebbles/.test(card.replace(/^\s*\/\/.*$/gm, '')), 'and its copy never mentions pebbles');
});

test('renderCards routes by zone and the strip is one capped row', () => {
  assert.match(html, /var asTile = zone === 'strip' && !!c\.tile;/, 'a strip card without a tile body falls back to the grid');
  assert.match(html, /\(asTile \? strip : grid\)\.appendChild\(el\)/);
  assert.match(html, /el\.className = asTile \? 'dcard tile' : 'dcard'/, 'tiles keep .dcard so st-warn and the typography come for free');
  assert.match(html, /strip\.style\.gridTemplateColumns = 'repeat\(' \+ nTiles \+ ',minmax\(0,1fr\)\)'/, 'one track per tile: the strip never wraps');
  assert.match(html, /strip\.style\.maxWidth = \(nTiles \* 200 \+ \(nTiles - 1\) \* 14\) \+ 'px'/,
    'capped at tile width so a three-stat page packs left instead of stretching to a third of the page each');
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

test('the rising edge pulls the one spine: no org extras ride connect any more', () => {
  assert.match(html, /if \(!quiet \|\| !wasOk\) \{ loadDashboard\(true\); loadPagesList\(\); \}/,
    'the rising edge is dashboard + pages, nothing facial');
  for (const dead of ['loadFleetHealth', 'checkOnboard(', 'loadPlane(', 'govLoad(',
    'loadJoinRequests', 'loadRockState', 'loadCommunityDoor']) {
    assert.ok(!html.includes(dead), `${dead} stays gone`);
  }
});

test('the hero is shared: one banner, one subtitle naming the person', () => {
  assert.match(html, /function renderHero\(\)/);
  assert.match(html, /\$\('ccBanner'\)\.style\.display = done \? 'none' : 'flex';/,
    'the banner shows until onboarding is done, for everyone');
  assert.ok(!html.includes('orgCcBanner"'), 'the org banner element stays gone');
  assert.match(html, /\[state\.data\.pebble, state\.data\.business, state\.data\.stage\]/, 'the hero names the person');
});
