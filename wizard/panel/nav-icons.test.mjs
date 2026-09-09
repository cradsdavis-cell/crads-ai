// nav-icons.test.mjs — run: node --test wizard/panel/nav-icons.test.mjs
//
// Sam's 2026-08-09 audit: the sidebar showed the same node-graph glyph three
// times (Brain, the Network group header, Map), and the rock face reused
// Brain's exact path for Org brain and Overview's four squares for Pebbles.
// Copy-pasted glyphs are how it happened, so the pin is structural: no two
// visible nav entries may carry an identical icon. Since the 2026-09-01 face
// collapse there is one face and one sidebar, so the per-face loop is gone:
// every entry is always visible, and every entry must be distinct.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');

// Sidebar entries are <button data-sec="..."> items and <button data-group-toggle="...">
// headers; each carries its icon as its FIRST inline <svg>. (Section elements use
// data-sec too, but they are <section>, not <button>.)
const items = [];
const re = /<button([^>]*?)>\s*(<svg[\s\S]*?<\/svg>)/g;
let m;
while ((m = re.exec(html))) {
  const attrs = m[1];
  const sec = (attrs.match(/data-sec="([a-z]+)"/) || [])[1];
  const grp = (attrs.match(/data-group-toggle="([a-z]+)"/) || [])[1];
  if (!sec && !grp) continue;
  const cls = (attrs.match(/class="([^"]*)"/) || [, ''])[1];
  items.push({ id: sec || 'group:' + grp, cls, svg: m[2].replace(/\s+/g, ' ') });
}

test('the sidebar was actually parsed', () => {
  // The one-face sidebar: Overview, Your mineral, two group headers, Brain,
  // Skills, Connections, Secrets, Terminal. Nine entries (Communities,
  // Catalogue, Library and the Map/Network group left 2026-09-09); fewer means
  // the parser broke, more means a new entry arrived and this comment should
  // grow with it.
  assert.ok(items.length >= 9, `expected a full sidebar, found ${items.length} entries`);
  assert.ok(items.some((i) => i.id === 'brain'), 'Brain entry present');
  assert.ok(items.some((i) => i.id === 'group:assistant'), 'Your assistant group header present');
});

test('no two nav entries share an identical glyph', () => {
  const seen = new Map();
  for (const it of items) {
    const prior = seen.get(it.svg);
    assert.ok(!prior, `"${prior}" and "${it.id}" carry the same icon`);
    seen.set(it.svg, it.id);
  }
});

test('the face-scoped visibility classes are RETIRED (2026-09-01): one face, one sidebar', () => {
  // .orgonly/.memonly/.memberonly were how the two editions hid each other's
  // entries; the collapse deleted them, so any reappearance means the edition
  // split is creeping back in. The words survive in explanatory comments, so
  // the pin checks class attributes and CSS selectors, not raw substrings.
  assert.doesNotMatch(html, /class="[^"]*\b(?:orgonly|memonly|memberonly)\b/,
    'no element carries a face-scoped visibility class');
  assert.doesNotMatch(html, /<body[^>]*data-edition/,
    'the body carries no edition stamp');
});
