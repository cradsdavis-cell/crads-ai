// org-sections.test.mjs — the one-shell port's structural wall (2026-08-09).
//   node --test wizard/panel/org-sections.test.mjs
//
// Two things live here. (1) The stray-</div> class: an unbalanced close inside
// a section makes the HTML parser pop <section>, <main> and the shell div, so
// every LATER section is silently re-parented into <body> and tab clicks stop
// activating them. That exact wound shipped on the old panel.html with the
// 2026-08-09 rock-tie card (line 682) and was only caught when the ported
// shell was driven headless: file-content tests structurally cannot see it,
// but a per-section div balance CAN refuse the imbalance that causes it.
// (2) The org sections exist under their ruled names, inside <main>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

test('every section is div-balanced, so the parser can never eject later sections from <main>', () => {
  const main = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));
  const sections = main.split(/(?=<section )/g).filter((s) => s.startsWith('<section '));
  // 15 since S5: the orgbrain flat list died and the org face mounts the
  // shared data-sec="brain" graph viewer instead
  assert.ok(sections.length >= 15, `found the sections (${sections.length})`);
  for (const s of sections) {
    const name = (s.match(/data-sec="([^"]+)"/) || [])[1] || '?';
    const body = s.slice(0, s.indexOf('</section>'));
    const opens = (body.match(/<div\b/g) || []).length;
    const closes = (body.match(/<\/div>/g) || []).length;
    assert.equal(opens - closes, 0, `section ${name}: ${opens} <div vs ${closes} </div>`);
  }
});

test('the org sections live inside <main> under the ruled names', () => {
  const main = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));
  // operators died 2026-08-09 (one admin, many devices); orgbrain died in S5
  // (the shared brain viewer serves both faces)
  for (const sec of ['pebbles', 'decisions', 'yourrock', 'publish']) {
    assert.match(main, new RegExp('<section data-sec="' + sec + '" class="orgsec">'), `${sec} inside main`);
  }
  assert.ok(!main.includes('data-sec="orgbrain"'), 'the orgbrain flat list stays dead');
  assert.match(html, /if \(name === 'orgbrain'\) name = 'brain';/, 'old orgbrain deep links land on the shared viewer');
});

test('the edition plumbing is present: placeholder, wall, and namespaced org state', () => {
  assert.ok(html.includes("var AIOS_EDITION = '__AIOS_EDITION__'"), 'stamp placeholder');
  assert.ok(html.includes('body[data-edition="org"] .memonly{display:none'), 'member chrome walled for org');
  assert.ok(html.includes('body:not([data-edition="org"]) .orgonly{display:none'), 'org chrome walled for member');
  assert.match(html, /var orgx = \{/, 'org state namespaced off member state');
});
