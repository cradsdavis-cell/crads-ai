// brain-assets-ui.test.mjs — the Brain page grew assets and a richer reader on
// 2026-08-17; these pins run the REAL page functions (the repo's standard
// source-slice technique) so the rendering rules hold as behaviour, not prose.
// Run: node --test wizard/panel/brain-assets-ui.test.mjs
//
// The server-side boundary (which extensions exist at all) is pinned in
// asset-scope.test.mjs. This file owns the CLIENT truths:
//   - markdown stays escape-first: no authored HTML ever survives mdRender
//   - images render as inert placeholders, hydrated later, never inline bytes
//   - link targets are https-only; a javascript: URL stays plain text
//   - csv honours quoted commas (a member's export must not be shredded)
//   - asset refs resolve against the LISTED tree only, never the filesystem
//   - routing: an asset opens the reader directly and never asks the graph
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

// -- extract the real functions ---------------------------------------------
const fnSrc = (name) => {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start > 0, `function ${name} exists in member.html`);
  const end = html.indexOf('\n  }', start);
  return html.slice(start, end + 4);
};
const lib = new Function('state',
  [fnSrc('esc'), fnSrc('mdInline'), fnSrc('mdRender'), fnSrc('csvRender'), fnSrc('resolveAsset')].join('\n')
  + '\nreturn { esc: esc, mdInline: mdInline, mdRender: mdRender, csvRender: csvRender, resolveAsset: resolveAsset };'
)({ pages: ['index.md', 'notes/plan.md', 'projects/q3.md', 'projects/moodboard.png', 'notes/shot.png', 'notes/data.csv'] });

// -- markdown ----------------------------------------------------------------

test('markdown stays escape-first: authored HTML arrives as text, not markup', () => {
  const out = lib.mdRender('hello <img src=x onerror=alert(1)> and <script>x()</script>');
  assert.ok(!out.includes('<img'), 'no authored <img> survives');
  assert.ok(!out.includes('<script'), 'no authored <script> survives');
  assert.ok(out.includes('&lt;img'), 'it renders as escaped text instead');
});

test('tables render, header row and quoted pipes intact', () => {
  const out = lib.mdRender('| prospect | stage |\n| --- | --- |\n| Dana | warm |');
  assert.match(out, /<table>/);
  assert.match(out, /<th>prospect<\/th>/, 'first row becomes headers when a separator follows');
  assert.match(out, /<td>Dana<\/td>/);
});

test('a plain https link becomes a safe anchor; a javascript: URL stays text', () => {
  const ok = lib.mdRender('see [the site](https://example.com/x)');
  assert.match(ok, /<a href="https:\/\/example\.com\/x" target="_blank" rel="noopener noreferrer">the site<\/a>/);
  const bad = lib.mdRender('click [here](javascript:alert(1))');
  assert.ok(!bad.includes('<a href'), 'javascript: never becomes an anchor');
});

test('italics and ordered lists render; bold still does', () => {
  assert.match(lib.mdRender('this *matters* a lot'), /<em>matters<\/em>/);
  assert.match(lib.mdRender('**bold** stays'), /<strong>bold<\/strong>/);
  assert.match(lib.mdRender('1. first thing'), /<li>first thing<\/li>/);
});

test('image refs render as inert placeholders, both spellings, never bytes', () => {
  const out = lib.mdRender('![[moodboard.png]] and ![alt text](notes/shot.png)');
  assert.ok(!out.includes('<img'), 'mdRender itself never emits an <img>');
  assert.match(out, /class="bimg-wait" data-ref="moodboard\.png"/, 'the wikilink embed spelling');
  assert.match(out, /data-ref="notes\/shot\.png" data-alt="alt text"/, 'the standard spelling, alt carried');
});

test('a table inside a code fence is code, not a table', () => {
  const out = lib.mdRender('```\n| a | b |\n| c | d |\n```');
  assert.ok(!out.includes('<table>'), 'fenced content is never structured');
  assert.match(out, /<pre><code>/);
});

// -- csv ---------------------------------------------------------------------

test('csv honours quoted commas and doubled quotes', () => {
  const out = lib.csvRender('name,note\n"Whitfield, Dana","said ""yes"""', ',');
  assert.match(out, /<td>Whitfield, Dana<\/td>/, 'the comma inside quotes is data');
  assert.match(out, /<td>said &quot;yes&quot;<\/td>/, 'doubled quotes collapse to one (then escape like all text)');
  assert.match(out, /<th>name<\/th>/, 'first row is the header');
});

test('csv cells are escaped like everything else', () => {
  const out = lib.csvRender('a\n<b>x</b>', ',');
  assert.ok(!out.includes('<b>x'), 'no authored markup out of a cell');
  assert.ok(out.includes('&lt;b&gt;'));
});

// -- asset resolution --------------------------------------------------------

test('asset refs resolve against the listed tree: as-written, page-relative, basename', () => {
  assert.equal(lib.resolveAsset('notes/shot.png', 'index.md'), 'notes/shot.png');
  assert.equal(lib.resolveAsset('moodboard.png', 'projects/q3.md'), 'projects/moodboard.png', 'page-relative');
  assert.equal(lib.resolveAsset('shot.png', 'projects/q3.md'), 'notes/shot.png', 'bare basename falls back to the one match');
  assert.equal(lib.resolveAsset('missing.png', 'index.md'), null, 'an unlisted file resolves to nothing, never to a guess');
});

// -- routing + wiring pins (static, same idiom as qa-member.test.mjs) --------

test('selectPage sends assets straight to the reader, never to the graph', () => {
  const fn = html.split('function selectPage(p)')[1].split('\n  }')[0];
  assert.match(fn, /if \(!\/\\\.md\$\/i\.test\(p\)\) \{ openReaderOnly\(p\); return; \}/,
    'the non-md early return exists before any graph lookup');
});

test('the tree filter admits exactly the allowed families', () => {
  assert.match(html, /BRAIN_ASSET_RE = \/\\\.\(md\|txt\|csv\|tsv\|png\|jpe\?g\|gif\|webp\)\$\/i/,
    'the client mirror of the server allow-list');
  const fn = html.split('function loadTree()')[1].split('\n  }')[0];
  assert.match(fn, /BRAIN_ASSET_RE\.test\(l\)/, 'loadTree filters through it');
});

test('the public toggle is offered on pages only, never on assets', () => {
  const fn = html.split('function loadPageContent(p)')[1].split('\n  }')[0];
  assert.match(fn, /if \(r\.ok && isMd\) pubRow\(p\);/,
    'pubRow is gated on .md — brain-public refuses assets, so offering it would offer a refusal');
});

test('image hydration runs only for pages, and placeholders degrade in words', () => {
  const fn = html.split('function loadPageContent(p)')[1].split('\n  }')[0];
  assert.match(fn, /if \(r\.ok && isMd\) hydrateBrainImages\(el, p\);/);
  const hy = html.split('function hydrateBrainImages(el, fromPage)')[1].split('\n  }')[0];
  assert.match(hy, /if \(!hit \|\| !BRAIN_IMG_RE\.test\(hit\)\) return;/,
    'an unresolvable or non-image ref stays a placeholder, no request fired');
});

test('the tree marks public pages and asset extensions', () => {
  const fn = html.split('function mkRow(cls, indent, tw, name, onclick, path)')[1].split('\n    }')[0];
  assert.match(fn, /class="ext"/, 'assets keep their extension visible');
  assert.match(fn, /class="pub" title="Shared with tied pebbles"/, 'public pages wear the dot');
});
