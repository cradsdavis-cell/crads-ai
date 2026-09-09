// shot-selectors.test.mjs — the shots rigs, held to the pages they shoot.
//   node --test wizard/dev-harness/shot-selectors.test.mjs
//
// Sibling to wizard/panel/ci-section-pins.test.mjs, which caught the SAME
// retirement one surface over. Trap 28 found three places a `data-sec` rename
// has to land and closed the third. This is the fourth: the rigs drive the
// pages by literal selector, and nothing in the suite reads them.
//
// So when the 2026-08-10 Rocks rebuild retired `data-sec="rockbrain"` and took
// the orbiting device chips (`.ndev`) off the map, four shots kept waiting on
// selectors that no longer existed. Each died on a 30s page.click timeout, so
// every clean run of the rig burned two minutes and printed "4 shot(s) failed".
// That is worse than a broken shot: a permanent non-zero failure count is a
// failure count nobody reads, which is precisely where a real regression lands.
//
// The rigs are not test files, so their rot is silent by construction. This
// file makes it loud, in the cheap direction: it never launches a browser, it
// just holds every selector literal in every rig against the shells they shoot.
//
// COVERAGE (2026-08-14). Until today this file read member-shots.mjs ALONE,
// and the other three rigs rotted behind it exactly as predicted above:
//
//   * shots.mjs clicked `#nav button[data-sec="brain"]` with no group opened,
//     so both member-brain shots died on "element is not visible" (the tabs
//     have been inside collapsed `.navgroup`s since 2026-08-04).
//   * small-shots.mjs still drove `#manualFold` and `#orgsFold`, deleted from
//     member-connect.html on 2026-08-09 by 5b75c69 — 10 dead shots. That commit
//     rewrote six TESTS for the same deletion; the rig was not a test, so
//     nothing told it.
//
// Both rigs therefore shipped a permanent non-zero failure count, which is the
// exact thing the paragraph above was written about. So every rig is read now,
// and grouped-nav navigation has one implementation (nav.mjs) rather than one
// per rig plus one rig without.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const RIGS = ['shots.mjs', 'member-shots.mjs', 'panel-shots.mjs', 'small-shots.mjs'];
const member = read('../panel/member.html');

// Every page the harness serves (just the shell + the door since the
// 2026-09-01 collapse deleted connect/wizard/join). An id or class is held
// against the union: what this catches is a selector that exists NOWHERE,
// which is what every rot found so far has been.
const SHELLS = ['../panel/member.html', '../panel/door.html'].map(read);
const inAnyShell = (re) => SHELLS.some((h) => re.test(h));

// Comments in a rig explain retirements by naming the retired selector, so they
// must not count as usage: `.ndev` is discussed at length precisely because it
// is gone, and so are `#manualFold` and `#orgsFold`.
const codeOf = (rig) => read(`./${rig}`).replace(/^\s*\/\/.*$/gm, '');

// Every string handed to page.click / hover / focus / fill / locator /
// querySelector in a rig. Selectors are always quoted literals here; a computed
// one would slip past, and should be written as a literal so it cannot.
function selectorsIn(code) {
  const out = [];
  for (const m of code.matchAll(/\.(?:click|hover|focus|fill|locator|waitForSelector|\$\$?)\(\s*'([^']+)'/g)) out.push(m[1]);
  for (const m of code.matchAll(/querySelector(?:All)?\(\s*[`']([^`']+)[`']/g)) out.push(m[1]);
  return [...new Set(out)];
}

for (const rig of RIGS) {
  test(`${rig}: every section it navigates to still has a nav button`, () => {
    const code = codeOf(rig);
    // both shapes the rigs use: the curried `nav('brain', ms)` hook and the
    // direct `navTo(page, 'brain', ms)` call
    const secs = [
      ...[...code.matchAll(/\bnav\(\s*'([^']+)'/g)].map((m) => m[1]),
      ...[...code.matchAll(/\bnavTo\(\s*page\s*,\s*'([^']+)'/g)].map((m) => m[1]),
    ];
    if (!secs.length) return;   // small-shots drives no tabbed surface
    const missing = [...new Set(secs)].filter((s) => !member.includes(`data-sec="${s}"`));
    assert.deepEqual(missing, [],
      `${rig} navigates to sections member.html does not have: ${missing.join(', ')}`);
  });

  test(`${rig}: every #id it drives exists in a shell`, () => {
    const ids = [...new Set(selectorsIn(codeOf(rig))
      .flatMap((s) => [...s.matchAll(/#([A-Za-z][\w-]*)/g)].map((m) => m[1])))];
    // a rig may legitimately drive no ids at all (small-shots became door-only
    // when the connect/wizard/join surfaces were deleted, 2026-09-01)
    if (!ids.length) return;
    // an id is either written into the markup or created by a page's own JS,
    // which reaches for it through the $() helper by the same name
    const missing = ids.filter((id) =>
      !inAnyShell(new RegExp(`id="${id}"`)) && !inAnyShell(new RegExp(`\\$\\('${id}'\\)`)));
    assert.deepEqual(missing, [],
      `${rig} targets ids no shell has: ${missing.join(', ')}`);
  });

  test(`${rig}: every .class it drives exists in a shell`, () => {
    const classes = [...new Set(selectorsIn(codeOf(rig))
      .flatMap((s) => [...s.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1])))];
    if (!classes.length) return;
    // classes arrive two ways: in a class="…" attribute, or assigned in a
    // page's JS as a quoted className. Both are literal strings in the file.
    const missing = classes.filter((c) => !inAnyShell(new RegExp(`['"\`][^'"\`]*\\b${c}\\b`)));
    assert.deepEqual(missing, [],
      `${rig} targets classes no shell has: ${missing.join(', ')}`);
  });
}

// ---- the collapsed-group trap ------------------------------------------------
// The failure this pins is not a rename, it is a rig reaching a tab the wrong
// way: the button is present and matches, so the selector check above passes,
// and the click still times out because the tab is inside a shut group.

test('no rig clicks a nav tab directly: grouped tabs need their header opened first', () => {
  const offenders = RIGS.filter((rig) => /\.click\(\s*[`']#nav button\[data-sec=/.test(codeOf(rig)));
  assert.deepEqual(offenders, [],
    `these click a nav tab without opening its group, which times out on every grouped tab `
    + `(use navTo/nav from nav.mjs): ${offenders.join(', ')}`);
});

test('a tab really is unreachable by a bare click, so the rule above is load-bearing', () => {
  // If nothing were grouped, the rule would be cargo cult. Brain is the tab
  // shots.mjs died on; assert it is genuinely inside a group whose items are
  // hidden until opened, so this test fails loudly if the nav is flattened and
  // the whole helper becomes unnecessary.
  const nav = member.slice(member.indexOf('<nav'), member.indexOf('</nav>'));
  const group = nav.slice(nav.lastIndexOf('<div class="navgroup"', nav.indexOf('data-sec="brain"')),
    nav.indexOf('data-sec="brain"'));
  assert.match(group, /class="gitems"[^>]*\shidden/,
    'Brain sits in a navgroup whose items ship hidden');
  assert.match(member, /g\.classList\.toggle\('open', open\)/,
    'and only the open class reveals them');
});

test('the shared nav helper derives grouping from the page, never from a map', () => {
  const helper = read('./nav.mjs');
  assert.match(helper, /closest\('\.navgroup'\)/,
    'nav.mjs asks the page which group owns a tab');
  assert.match(helper, /data-group-toggle/,
    'and opens it with a real click on the header, the way a person does');
  // panel-shots.mjs carried a hand-kept sec -> group map and its own comment
  // recorded that map going stale once ('automations' -> 'assistant',
  // 2026-08-10). A map has to be edited when the nav is regrouped; asking the
  // DOM cannot rot, so no rig may reintroduce one.
  for (const rig of RIGS) {
    assert.ok(!/\bgrpOf\b/.test(codeOf(rig)),
      `${rig} reintroduced a hand-kept sec -> group map; ask the page instead (nav.mjs)`);
  }
});

// ---- the specific rot that taught each lesson, pinned by name ----------------
test('the retired rockbrain tab and device chips stay out of the rigs', () => {
  const code = codeOf('member-shots.mjs');
  assert.ok(!/nav\(\s*'rockbrain'/.test(code),
    'the Rock brain nav tab was retired 2026-08-10; the reader is reached through a rock');
  assert.ok(!code.includes('.ndev'),
    'the orbiting device chips were retired 2026-08-10; devices live in the roster under the map');
  // The rockreader itself died with the Organisations page (face collapse,
  // 2026-09-01) and the Communities page with the simple-assistant strip
  // (2026-09-09): nothing box-to-box is left to photograph.
  assert.ok(!/nav\(\s*'rocks'/.test(code) && !code.includes('rockpages'),
    'the Rocks walk stays out of the rig with the page it walked');
  assert.ok(!/nav\(\s*'commons'/.test(code),
    'and so does the Communities walk');
});

test('the deleted connect page stays out of small-shots entirely', () => {
  // 5b75c69 first cut the page back to the invite claim; 2026-09-01 deleted
  // the page. The rig must not keep (or regrow) shots of a surface that is
  // not served.
  const code = codeOf('small-shots.mjs');
  for (const gone of ['/connect', '/wizard', 'joinFragment', 'manualFold', 'orgsFold', 'joinFold', 'genBtn']) {
    assert.ok(!code.includes(gone), `small-shots still drives the deleted surface (${gone})`);
  }
});
