// Pins the renderer skeleton: the markdown subset, escape-first inline
// handling, the how-to install affordance as data, the legal stamp line,
// and the manifest the surfaces share.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, renderPage, buildManifest } from './render.mjs';
import { loadTree } from './source.mjs';
import { SHOTS, marksFor } from './shots.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'test-fixtures');
// A TRACKED sidecar, in the shape the rig writes. The real one lives in
// `docs/product/shots/`, which is a gitignored build artefact: reading it made
// this file assert on whatever the last local capture left behind, so the whole
// clean-checkout suite was red on a fresh clone and in CI (trap 62). The
// fidelity test below keeps this fixture honest against the declaration.
const FIX_SHOTS = path.join(FIX, 'shots');

test('the subset renders: headings, lists, code, links, tables, quotes', () => {
  const html = renderMarkdown([
    '# Head', '', 'A paragraph with **bold** and `code` and a [link](https://crads-ai.com).', '',
    '- one', '- two', '', '1. first', '', '> quoted words', '',
    '| a | b |', '|---|---|', '| 1 | 2 |', '', '```', 'raw <code>', '```',
  ].join('\n'));
  for (const bit of ['<h1>Head</h1>', '<strong>bold</strong>', '<code>code</code>',
    '<a href="https://crads-ai.com">link</a>', '<ul>', '<li>one</li>', '<ol>',
    '<blockquote>', '<table>', '<th>a</th>', '<td>2</td>', '<pre><code>raw &lt;code&gt;</code></pre>']) {
    assert.ok(html.includes(bit), `missing ${bit}`);
  }
});

test('markup never originates from page text', () => {
  const html = renderMarkdown('Hello <script>alert(1)</script> & <b>tags</b>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  // javascript: hrefs never become links
  const bad = renderMarkdown('[x](javascript:alert(1))');
  assert.ok(!bad.includes('href="javascript:'));
});

test('a how-to fragment carries the install affordance as data', () => {
  const [howto] = loadTree(FIX).filter((p) => p.mode === 'how-to');
  const html = renderPage(howto);
  assert.ok(html.includes(`data-installs="${howto.installs}"`));
  assert.ok(html.includes('data-mode="how-to"'));
});

test('a legal fragment carries the version stamp and the counterparty', () => {
  const [legal] = loadTree(FIX).filter((p) => p.mode === 'legal');
  const html = renderPage(legal);
  assert.ok(html.includes('Version 0.1, effective 2026-08-24'));
  assert.ok(html.includes('Samuel Davis trading as Crads AI'));
});

test('the manifest groups per tier and mode, order-sorted, and the tiers nest', () => {
  const pages = loadTree(FIX);
  const m = buildManifest(pages);
  assert.equal(m.count, pages.length);
  // public tier only carries public pages
  const pubSlugs = Object.values(m.tiers.public).flat().map((p) => p.audience);
  assert.ok(pubSlugs.every((a) => a === 'public'));
  // rock tier sees everything the pebble tier sees
  const flat = (t) => Object.values(m.tiers[t]).flat().map((p) => p.slug);
  const rock = new Set(flat('rock'));
  for (const slug of flat('pebble')) assert.ok(rock.has(slug), `rock missing ${slug}`);
});

test('a shot directive on its own line renders as a captioned figure', () => {
  const html = renderMarkdown('Before.\n\n![The assistant home](shot:member-overview)\n\nAfter.',
    { shotsDir: FIX_SHOTS });
  assert.match(html, /<figure class="shot marked">/);
  assert.ok(html.includes('src="/docs/shots/member-overview.png"'));
  assert.ok(html.includes('<figcaption>The assistant home</figcaption>'));
  // and it is a sibling of the paragraphs, never nested inside one
  assert.ok(!/<p>[^<]*<figure/.test(html), 'a figure inside a p is invalid HTML');
});

test('the marks fixture is what the rig would write for member-overview', () => {
  // The fixture is only worth asserting on if it matches the DECLARATION it
  // stands in for. Marks are declared by selector in shots.mjs and the rig adds
  // geometry; this pins that pairing, so dropping or reordering a mark on the
  // real shot fails here instead of leaving the renderer tested against a shape
  // the product no longer produces.
  const declared = SHOTS.find((s) => s.id === 'member-overview').marks;
  const fixture = marksFor('member-overview', FIX_SHOTS);
  assert.equal(fixture.length, declared.length, 'the fixture has drifted from the declaration');
  fixture.forEach((m, i) => {
    assert.equal(m.n, i + 1, 'markers are numbered 1..n in declaration order');
    assert.equal(m.sel, declared[i].sel);
    assert.equal(m.say, declared[i].say);
    // The rig refuses a mark that falls outside the captured image; a fixture
    // that could not have been captured is not a fixture.
    for (const k of ['x', 'y', 'w', 'h']) assert.equal(typeof m[k], 'number', `${k} is a percentage`);
    assert.ok(m.x >= 0 && m.y >= 0 && m.x + m.w <= 100.5 && m.y + m.h <= 100.5,
      `mark ${m.n} falls outside the image`);
  });
});

test('an annotated shot renders numbered markers and a text legend', () => {
  // member-overview declares marks, so this asserts the real pipeline output
  // rather than a synthetic one: a sidecar in the rig's own shape is what is
  // read, just from the tracked fixture directory rather than the build output.
  const html = renderMarkdown('![The assistant home](shot:member-overview)', { shotsDir: FIX_SHOTS });
  assert.match(html, /<figure class="shot marked">/, 'an annotated figure is flagged as such');
  assert.match(html, /<span class="shot-mark" style="left:[\d.]+%;top:[\d.]+%/,
    'markers are positioned in percentages, never in pixels');
  assert.match(html, /<ol class="shot-legend">/, 'and the callouts are readable text, not pixels');
  // every marker has a legend line, and vice versa
  const markers = (html.match(/class="shot-mark"/g) || []).length;
  const lines = (html.match(/<ol class="shot-legend">[\s\S]*?<\/ol>/)[0].match(/<li>/g) || []).length;
  assert.equal(markers, lines, 'a marker with no legend line is a number pointing at nothing');
  assert.ok(markers >= 2, `expected several marks on the overview, got ${markers}`);
});

test('a shot with no annotations degrades to a plain figure', () => {
  // The fixture dir, not the real one (trap 62): door-empty gained marks on
  // 2026-09-09, so a read of docs/product/shots/ after a rig run finds a
  // sidecar and this test asserts on whatever the last capture left behind.
  const html = renderMarkdown('![The door](shot:door-empty)', { shotsDir: FIX_SHOTS });
  assert.match(html, /<figure class="shot">/);
  assert.ok(!html.includes('shot-mark'), 'no empty overlay');
  assert.ok(!html.includes('shot-legend'), 'and no empty legend');
});

test('shot alt text is escaped like any other page text', () => {
  const html = renderMarkdown('![<b>x</b> & y](shot:door-empty)');
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt; &amp; y'));
});

test('a wrapped list item stays one item in one list', () => {
  // The 2026-08-25 finding: continuation lines fell to the paragraph branch,
  // which closes open lists, so every wrapped item on every published page
  // rendered as a one-item list plus a stray paragraph, and numbered steps
  // read 1, 1, 1, 1.
  const html = renderMarkdown([
    '1. First step, which wraps',
    '   onto a second line.',
    '2. Second step.',
    '',
    'A paragraph after.',
    '',
    '- A bullet that wraps',
    '  onto its own second line.',
    '- Another bullet.',
  ].join('\n'));
  assert.equal((html.match(/<ol>/g) || []).length, 1, 'one ordered list, not one per item');
  assert.equal((html.match(/<ul>/g) || []).length, 1, 'one unordered list');
  assert.match(html, /<li>First step, which wraps onto a second line\.<\/li>/);
  assert.match(html, /<li>A bullet that wraps onto its own second line\.<\/li>/);
  assert.ok(!/<p>\s{2,}/.test(html), 'no stray indented paragraphs escape a list');
  assert.match(html, /<p>A paragraph after\.<\/p>/, 'paragraphs after a closed list still render');
});

test('a nested item under a wrapped item still nests', () => {
  const html = renderMarkdown([
    '- Outer item that wraps',
    '  across a line.',
    '  - Inner item.',
    '- Second outer.',
  ].join('\n'));
  assert.equal((html.match(/<ul>/g) || []).length, 2, 'outer and inner lists');
  assert.match(html, /<li>Outer item that wraps across a line\.<\/li>\s*<ul>\s*<li>Inner item\.<\/li>/);
});

test('a quote is a Note, Tip: and Careful: pick a flavour, any other label is refused', () => {
  assert.match(renderMarkdown('> Plain quote.'), /^<blockquote><p>Plain quote\.<\/p><\/blockquote>$/);
  assert.match(renderMarkdown('> Tip: do the real task first.'), /^<blockquote class="tip"><p>do the real task first\.<\/p>/);
  assert.match(renderMarkdown('> Careful: it will be confidently wrong sometimes.'), /^<blockquote class="careful"><p>it will be/);
  assert.throws(() => renderMarkdown('> Warning: something.'), /unknown callout "Warning:"/);
  // a colon later in the sentence is prose, not a label
  assert.match(renderMarkdown('> The rule: write it down.'), /^<blockquote><p>The rule: write it down\./);
});

test('a page fragment carries its summary as a lede, and its outcome when it has one', () => {
  const base = { slug: 'x', mode: 'how-to', audience: 'public', title: 'Do a thing', summary: 'What this page is.', body: 'Body.', installs: null, outcome: null };
  const plain = renderPage(base);
  assert.match(plain, /<h1>Do a thing<\/h1>\n<p class="docs-lede">What this page is\.<\/p>/);
  assert.ok(!plain.includes('docs-outcome'));
  const withOutcome = renderPage({ ...base, outcome: 'do the thing without help.' });
  assert.match(withOutcome, /<p class="docs-outcome"><span>You will be able to<\/span> do the thing without help\.<\/p>/);
});
