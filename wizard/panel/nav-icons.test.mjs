// nav-icons.test.mjs — run: node --test wizard/panel/nav-icons.test.mjs
//
// Sam's 2026-08-09 audit: the sidebar showed the same node-graph glyph three
// times (Brain, the Network group header, Map), and the rock face reused
// Brain's exact path for Org brain and Overview's four squares for Pebbles.
// Copy-pasted glyphs are how it happened, so the pin is structural: within one
// FACE, no two visible nav entries may carry an identical icon. Brain (member)
// and Org brain (rock) may share a glyph: they are the same concept and never
// render together.
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
  assert.ok(items.length >= 15, `expected a full sidebar, found ${items.length} entries`);
  assert.ok(items.some((i) => i.id === 'brain'), 'Brain entry present');
  assert.ok(items.some((i) => i.id === 'group:network'), 'Network group header present');
});

for (const [face, hidden] of [['member', 'orgonly'], ['org', 'memonly']]) {
  test(`no two visible ${face}-face nav entries share an identical glyph`, () => {
    const seen = new Map();
    for (const it of items) {
      if (it.cls.includes(hidden)) continue;
      const prior = seen.get(it.svg);
      assert.ok(!prior, `"${prior}" and "${it.id}" carry the same icon on the ${face} face`);
      seen.set(it.svg, it.id);
    }
  });
}
