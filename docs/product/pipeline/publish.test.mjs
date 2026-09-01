// The publish gate. The single most consequential thing this script could get
// wrong is putting a craft-tier page on the open web, so that is pinned first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOORS } from './nav.mjs';
import { build } from './publish.mjs';
import { loadTree, visibleTo } from './source.mjs';
import { NAV_HTML, SITE_NAME } from './shell.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGES = path.join(HERE, '..', 'pages');
const SITE = process.env.CRADS_SITE_DIR || '';   // the live-site checkout, when present

test('only the public tier is published; craft tiers never reach the web', () => {
  const { files } = build();
  const published = new Set(files.map((f) => f.rel.split(path.sep)[1]).filter((s) => s !== 'index.html'));
  const craft = loadTree(PAGES).filter((p) => p.audience !== 'public');
  assert.ok(craft.length > 0, 'this test is meaningless with no craft pages');
  for (const p of craft) {
    assert.ok(!published.has(p.slug), `craft page ${p.slug} (${p.audience}) would be published`);
  }
  for (const p of visibleTo(loadTree(PAGES), 'public')) {
    assert.ok(published.has(p.slug), `public page ${p.slug} is missing from the build`);
  }
});

test('every published page is a whole site page', () => {
  for (const f of build().files) {
    const h = f.content;
    for (const must of ['<!DOCTYPE html>', '/lib/site.css', 'site-nav-bar', 'site-footer', '<main class="docs-page']) {
      assert.ok(h.includes(must), `${f.rel} missing ${must}`);
    }
    assert.ok(h.includes('rel="canonical"'), `${f.rel} has no canonical`);
    // Zero em dashes, with exactly one named exception: the site's own
    // pre-existing og:site_name brand string (see shell.mjs). Counting rather
    // than excluding, so a NEW em dash anywhere still fails.
    const emDashes = (h.match(/—/g) || []).length;
    const inBrand = (SITE_NAME.match(/—/g) || []).length;
    assert.equal(emDashes, inBrand,
      `${f.rel} carries ${emDashes - inBrand} em dash(es) beyond the site brand string`);
    // The FRAGMENT's own wrapper (<article data-mode=…>) must be stripped; the
    // page's <article class="docs-article"> is the reading surface and belongs.
    assert.ok(!h.includes('<article data-mode'), `${f.rel} leaked the fragment wrapper`);
    assert.ok(h.includes('<article class="docs-article">'), `${f.rel} has no article`);
  }
});

test('the index links every published page', () => {
  const { files } = build();
  const index = files.find((f) => f.rel === path.join('docs', 'index.html'));
  assert.ok(index, 'no index page built');
  const slugs = files.map((f) => f.rel.split(path.sep)[1]).filter((s) => s !== 'index.html');
  // Twice is correct since the sidebar landed: once in the sidebar, once in the
  // grouped list. A page on a door trail (the split doors, 2026-08-25) earns
  // exactly one more. Anything beyond its allowance means a group or door is
  // being emitted twice.
  const doored = new Set(DOORS.flatMap((d) => d.slugs));
  for (const s of slugs) {
    const hits = index.content.split(`href="/docs/${s}"`).length - 1;
    const max = doored.has(s) ? 3 : 2;
    assert.ok(hits >= 1 && hits <= max, `${s} appears ${hits} times on the index (allowance ${max})`);
  }
});

test('every page carries the reading surface', () => {
  const { files } = build();
  const pages = files.filter((f) => f.rel !== path.join('docs', 'index.html'));
  for (const f of pages) {
    assert.ok(f.content.includes('class="docs-side"'), `${f.rel} has no sidebar`);
    assert.ok(f.content.includes('aria-current="page"'), `${f.rel} does not mark itself current in the nav`);
    assert.ok(f.content.includes('class="docs-shell"'), `${f.rel} is not in the docs layout`);
  }
});

test('prev and next chain the whole set, ends included', () => {
  const { files } = build();
  const pages = files.filter((f) => f.rel !== path.join('docs', 'index.html'));
  const withNav = pages.filter((f) => f.content.includes('docs-nextprev'));
  assert.equal(withNav.length, pages.length, 'every page offers a way onward');
  // exactly one page has no Previous and one has no Next: the two ends
  const noPrev = pages.filter((f) => !f.content.includes('class="prev"'));
  const noNext = pages.filter((f) => !f.content.includes('class="next"'));
  assert.equal(noPrev.length, 1, 'exactly one first page');
  assert.equal(noNext.length, 1, 'exactly one last page');
});

test('a page with enough headings gets contents, a short one does not', () => {
  const { files } = build();
  const withToc = files.filter((f) => f.content.includes('class="docs-toc"'));
  assert.ok(withToc.length > 0, 'some page has contents');
  assert.ok(withToc.length < files.length, 'and a short page is not given furniture');
});

test('headings are linkable', () => {
  const { files } = build();
  const page = files.find((f) => f.rel.includes('first-hour'));
  assert.match(page.content, /<h2 id="[a-z0-9-]+">/, 'h2s carry ids');
  assert.match(page.content, /<a class="anchor" href="#[a-z0-9-]+"/, 'and an anchor to copy');
});

test('shots are only claimed if a published page references one', () => {
  const { shots, files } = build();
  const body = files.map((f) => f.content).join('');
  for (const s of shots) {
    assert.ok(body.includes(`/docs/shots/${s}.png`), `shot ${s} copied but never referenced`);
  }
});

// Drift guard on the duplicated nav. shell.mjs copies the live site's nav, and a
// copy is a thing that goes stale. If the site repo is on this machine, check the
// copy still matches what the site serves. Skipped rather than failed when the
// repo is absent, because CI has no reason to have it.
test('the shell nav matches the live site, when the site is on disk', (t) => {
  if (!SITE) return t.skip('site repo not present');
  const ref = path.join(SITE, 'about', 'index.html');
  if (!existsSync(ref)) return t.skip('site repo not present');
  const live = readFileSync(ref, 'utf8');
  const links = [...NAV_HTML.matchAll(/href="(\/[a-z-]*)"/g)].map((m) => m[1])
    .filter((h) => h !== '/docs');   // /docs is ours, the site does not have it yet
  const missing = links.filter((h) => !live.includes(`href="${h}"`));
  assert.deepEqual(missing, [],
    'shell.mjs nav has links the live site does not: the copy has drifted');
});
