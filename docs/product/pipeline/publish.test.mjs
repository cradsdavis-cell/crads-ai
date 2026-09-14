// The publish gate. The single most consequential thing this script could get
// wrong is putting a craft-tier page on the open web, so that is pinned first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOORS } from './nav.mjs';
import { build } from './publish.mjs';
import { skills } from './generate.mjs';
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
    // Zero em dashes. Until 2026-09-09 the one exception was the site's
    // pre-existing og:site_name brand string (see shell.mjs); the brand is now
    // "Crads-AI", so the allowance this computes is zero. Counting rather than
    // excluding, so a NEW em dash anywhere still fails.
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
    // the skills page earns one more: the "What it can do" strip's closing link
    const max = (doored.has(s) ? 3 : 2) + (s === 'skills' ? 1 : 0);
    assert.ok(hits >= 1 && hits <= max, `${s} appears ${hits} times on the index (allowance ${max})`);
  }
});

test('the index opens with a search you can see, six doors by goal, and what it can do', () => {
  const { files } = build();
  const index = files.find((f) => f.rel === path.join('docs', 'index.html')).content;
  assert.match(index, /<div class="docs-search-in-wrap hero"><input type="search" class="docs-search-in"/, 'hero search');
  for (const d of DOORS) {
    const sec = index.slice(index.indexOf(`id="goal-${d.id}"`));
    assert.ok(sec.length > 100, `door ${d.id} is on the index`);
    const card = sec.slice(0, sec.indexOf('</section>'));
    assert.match(card, /<svg class="glyph" aria-hidden="true"/, `door ${d.id} carries its glyph`);
    const links = (card.match(/href="\/docs\/[a-z0-9-]+"/g) || []).length;
    assert.ok(links >= 2, `door ${d.id} lists at least two pages`);
  }
  assert.ok(index.includes('id="what-it-can-do"'), 'the strip');
  const escd = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  for (const sk of skills()) assert.ok(index.includes(`<b>${escd(sk.title)}</b><span>/${sk.name}</span>`), `strip lists ${sk.name}`);
  assert.ok(index.includes('href="/docs/skills"'), 'and points at the generated page');
  assert.ok(index.includes('"u":"#goal-fix"'), 'the doors are in the search index');
});

test('a doored page carries its trail by goal; an undoored page does not', () => {
  const { files } = build();
  const doored = new Set(DOORS.flatMap((d) => d.slugs));
  for (const f of files) {
    const slug = f.rel.split(path.sep)[1];
    if (slug === 'index.html') continue;
    const has = f.content.includes('class="docs-trail"');
    assert.equal(has, doored.has(slug), `${slug}: trail ${has ? 'present' : 'absent'}`);
    if (has) assert.match(f.content, /<li class="here" aria-current="step">/, `${slug}: marks its own step`);
  }
  const first = DOORS[0];
  const page = files.find((f) => f.rel.split(path.sep)[1] === first.slugs[0]).content;
  assert.ok(page.includes(`href="/docs/${first.slugs[1]}"`), 'the trail links the next step');
  assert.ok(page.includes(`href="/docs#goal-${first.id}"`), 'and the door it belongs to');
});

test('only the current page\'s sidebar group starts open', () => {
  const { files } = build();
  const page = files.find((f) => f.rel.includes('first-hour')).content;
  const side = page.slice(page.indexOf('class="docs-side"'), page.indexOf('</aside>'));
  const open = (side.match(/<details class="navgrp" open>/g) || []).length;
  assert.equal(open, 1, 'one group open');
  assert.match(side, /<details class="navgrp goals">/, 'the goals group is there, closed');
});

test('every page carries the reading surface', () => {
  const { files } = build();
  const pages = files.filter((f) => f.rel !== path.join('docs', 'index.html'));
  for (const f of pages) {
    assert.ok(f.content.includes('class="docs-side"'), `${f.rel} has no sidebar`);
    assert.ok(f.content.includes('class="docs-search-in"'), `${f.rel} has no visible search`);
    assert.ok(f.content.includes('class="docs-lede"'), `${f.rel} has no lede`);
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
