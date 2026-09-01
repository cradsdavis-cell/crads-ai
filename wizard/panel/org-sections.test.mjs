// org-sections.test.mjs — the structural wall survives the face collapse; the
// org sections themselves are RETIRED (2026-09-01).
//   node --test wizard/panel/org-sections.test.mjs
//
// The stray-</div> class is still worth refusing: an unbalanced close inside a
// section makes the HTML parser pop <section>, <main> and the shell div, so
// every LATER section is silently re-parented into <body> and tab clicks stop
// activating them. That exact wound shipped on the old panel.html with the
// 2026-08-09 rock-tie card and was only caught when the shell was driven
// headless. The balance check below keeps holding for the one-face shell.
// Everything edition-shaped that used to live here (orgsec sections, the
// AIOS_EDITION stamp, the .orgonly/.memonly walls, the orgx namespace) died
// with the org face and is pinned gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

test('every section is div-balanced, so the parser can never eject later sections from <main>', () => {
  const main = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));
  const sections = main.split(/(?=<section )/g).filter((s) => s.startsWith('<section '));
  // 12 since the face collapse: one nav for every mineral (dashboard, seat,
  // network, commons, brain, skills, library, connections, publish, secrets,
  // terminal, help), no orgsec twins.
  assert.equal(sections.length, 12, `found the sections (${sections.length})`);
  for (const s of sections) {
    const name = (s.match(/data-sec="([^"]+)"/) || [])[1] || '?';
    const body = s.slice(0, s.indexOf('</section>'));
    const opens = (body.match(/<div\b/g) || []).length;
    const closes = (body.match(/<\/div>/g) || []).length;
    assert.equal(opens - closes, 0, `section ${name}: ${opens} <div vs ${closes} </div>`);
  }
});

test('the org sections are RETIRED: no orgsec section remains, and old deep links land somewhere living', () => {
  const main = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));
  assert.ok(!main.includes('class="orgsec"'), 'no section wears the orgsec class any more');
  for (const sec of ['pebbles', 'decisions', 'yourrock', 'rocks', 'orgbrain']) {
    assert.ok(!main.includes(`data-sec="${sec}"`), `${sec} must stay out of main`);
  }
  // the publish section survived the collapse as the Catalogue page, faceless
  assert.match(main, /<section data-sec="publish">/, 'publish lives on, without an edition class');
  // retired names are remapped, not dropped: a hosted-era bookmark still lands
  assert.match(html, /if \(name === 'rocks' \|\| name\.indexOf\('rocks\/'\) === 0 \|\| name === 'rockbrain'\) name = 'commons';/,
    'rocks deep links land on Communities');
  assert.match(html, /if \(name === 'pebbles' \|\| name === 'decisions' \|\| name === 'yourrock'\) name = 'seat';/,
    'the dead org pages land on the seat');
});

test('the edition plumbing is RETIRED: no stamp, no walls, no namespaced org state', () => {
  // Comments in member.html may still NAME the dead machinery to explain its
  // absence; what must stay gone is anything the parser or CSS would act on.
  assert.ok(!html.includes('AIOS_EDITION'), 'the edition stamp placeholder must stay gone');
  assert.ok(!html.includes('data-edition="'), 'no element stamps an edition attribute');
  assert.ok(!/class="[^"]*\b(orgonly|memonly|memberonly)\b/.test(html),
    'no element wears a face-walling class');
  assert.ok(!/\.(orgonly|memonly|memberonly)\s*\{/.test(html), 'no CSS rule walls a face');
  assert.ok(!/var orgx = \{/.test(html), 'the orgx namespace must stay gone');
});
