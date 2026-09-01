#!/usr/bin/env node
// publish.mjs - render the public tier into the crads-ai.com site repo.
//
//   node docs/product/pipeline/publish.mjs [--out <site-repo>] [--dry]
//
// Build step 8. Writes ONLY the public tier: the pebble and rock craft tiers
// ship inside the image and must never appear on the open web (that is the whole
// point of the tiering, and it is where a future gate would arm).
//
// Output shape, matching the site's `cleanUrls: true`:
//   <site>/docs/index.html                -> /docs
//   <site>/docs/<slug>/index.html         -> /docs/<slug>
//   <site>/docs/shots/<id>.png            -> the screenshots the pages reference
//
// The site repo also holds its own engineering docs under docs/ (audit/,
// superpowers/, prepaid-booking.md). Those are left alone: filenames do not
// collide. Two of them are publicly fetchable today, which is a separate finding
// and not this script's business to fix.
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTree, visibleTo } from './source.mjs';
import { renderPage, renderMarkdown, outline } from './render.mjs';
import { JOURNEY, DOORS, journeyGroups, journeyProblems } from './nav.mjs';
import { shell } from './shell.mjs';
import { extractShotRefs } from './shots.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGES = path.join(HERE, '..', 'pages');
const SHOTS = path.join(HERE, '..', 'shots');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const SITE = path.resolve(arg('--out', process.env.CRADS_SITE_DIR || path.join(HERE, '..', 'site-out')));
const DRY = process.argv.includes('--dry');

// Grouping follows the READER'S JOURNEY, not the authoring mode (Sam's ruling
// 2026-08-25): nav.mjs is the one place the story's shape lives, and the
// coverage gate refuses a public page it forgot.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The sidebar: every public page, grouped by the journey, in reading order.
// Built from the manifest so it cannot list a page the site does not carry, and
// so a new page appears in the nav by existing rather than by being remembered.
// Enterprise pass (2026-08-25): search on top, per-group collapsibles (all
// open; the chevron is there for the reader who wants less), an accent rail on
// the active page.
function sidebar(groups, currentSlug) {
  const inner = [
    `    <button type="button" class="docs-search-btn">Search the docs<span class="k docs-kbd">⌘K</span></button>`,
    `    <a class="navhome" href="/docs">Docs home</a>`,
    ...groups.map((g) => {
      const links = g.items.map((p) => {
        const cur = p.slug === currentSlug ? ' aria-current="page"' : '';
        const badge = p.persona === 'host' ? '<span class="docs-badge">Hosts</span>' : '';
        return `      <li><a href="/docs/${p.slug}"${cur}>${esc(p.title)}${badge}</a></li>`;
      }).join('\n');
      return `    <details class="navgrp" open>\n      <summary>${esc(g.title)}</summary>\n      <ul>\n${links}\n      </ul>\n    </details>`;
    }),
  ].join('\n');
  // On a narrow screen the whole tree collapses behind one control rather than
  // pushing the article a screen and a half down the page.
  // NOT `open`: on a narrow screen the tree stays shut so the article starts at
  // the top of the page. Desktop forces it open in CSS (verified in a browser,
  // not assumed: forcing a closed details open is the one part of this that a
  // stylesheet is not obviously allowed to do).
  return `<details>\n  <summary>All docs</summary>\n${inner}\n</details>`;
}

// Breadcrumb: Docs / <journey group>. The page's own name is the h1 an inch
// below, so the trail ends at the parent, the way the reference class does it.
function crumbsFor(groupTitle, persona) {
  const badge = persona === 'host' ? '<span class="docs-badge lg">For hosts</span>' : '';
  return `<nav class="docs-crumbs" aria-label="Breadcrumb">`
    + `<a href="/docs">Docs</a><span class="sep">/</span>`
    + `<span class="here">${esc(groupTitle)}</span>${badge}</nav>`;
}

// The search index, shipped with every page: slug, title, group, summary and
// the h2s, small enough to inline (a few KB) and enough for a useful filter.
function searchIndex(groups) {
  const rows = groups.flatMap((g) => g.items.map((p) => ({
    u: p.slug, t: p.title, g: g.title, s: p.summary,
    h: outline(p.body).filter((h) => h.level === 2).map((h) => h.text),
  })));
  return JSON.stringify(rows);
}

function tocFor(pg) {
  const heads = outline(pg.body).filter((h) => h.level === 2);
  // Two headings is a list; one is furniture. Below three it earns nothing.
  if (heads.length < 3) return '';
  return `<h2>On this page</h2>\n<ul>\n`
    + heads.map((h) => `  <li><a href="#${h.id}">${esc(h.text)}</a></li>`).join('\n')
    + `\n</ul>`;
}

function nextprevFor(ordered, idx) {
  const prev = ordered[idx - 1];
  const next = ordered[idx + 1];
  if (!prev && !next) return '';
  const cell = (p, dir, cls) => (p
    ? `<a class="${cls}" href="/docs/${p.slug}"><span class="dir">${dir}</span>${esc(p.title)}</a>`
    : '<span></span>');
  return `<nav class="docs-nextprev" aria-label="More docs">`
    + cell(prev, 'Previous', 'prev') + cell(next, 'Next', 'next') + '</nav>';
}

export function build() {
  const all = loadTree(PAGES);
  const pages = visibleTo(all, 'public');
  const files = [];

  const problems = journeyProblems(pages);
  if (problems.length) throw new Error('journey out of step with the pages:\n  ' + problems.join('\n  '));
  const groups = journeyGroups(pages);
  // One reading order for the whole set, shared by the sidebar and prev/next, so
  // "next" always means the next thing in the list the reader can see, and the
  // chain now walks the JOURNEY: last page of Start here -> first page of
  // Getting set up, the story in order.
  const ordered = groups.flatMap((g) => g.items);
  const groupOf = new Map(groups.flatMap((g) => g.items.map((p) => [p.slug, g.title])));
  const search = searchIndex(groups);

  for (const [idx, pg] of ordered.entries()) {
    files.push({
      rel: path.join('docs', pg.slug, 'index.html'),
      content: shell({
        title: pg.title,
        description: pg.summary,
        path: `/docs/${pg.slug}`,
        side: sidebar(groups, pg.slug),
        toc: tocFor(pg),
        nextprev: nextprevFor(ordered, idx),
        search,
        body: [
          crumbsFor(groupOf.get(pg.slug), pg.persona),
          renderPage(pg).replace(/^<article[^>]*>\n/, '').replace(/\n<\/article>$/, ''),
        ].join('\n'),
      }),
    });
  }

  // the index: two doors first (Sam: "split doors"), then the whole journey
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const doorsHtml = `<div class="docs-doors">\n` + DOORS.map((d) => {
    const steps = d.slugs.map((s, i) => {
      const p = bySlug.get(s);
      return `        <li><span class="n">${i + 1}</span><a href="/docs/${p.slug}">${esc(p.title)}</a></li>`;
    }).join('\n');
    return `    <section class="door">\n      <h2>${esc(d.title)}</h2>\n`
      + `      <p class="lead">${esc(d.lead)}</p>\n      <ol>\n${steps}\n      </ol>\n    </section>`;
  }).join('\n') + '\n  </div>';

  const indexGroups = groups.map((g) => {
    const items = g.items.map((p) => {
      const badge = p.persona === 'host' ? '<em class="docs-badge">Hosts</em>' : '';
      return `        <a class="card" href="/docs/${p.slug}"><b>${esc(p.title)}${badge}</b><span>${esc(p.summary)}</span></a>`;
    }).join('\n');
    return `    <section>\n      <h2>${esc(g.title)}</h2>\n`
      + `      <p class="docs-summary">${esc(g.blurb)}</p>\n      <div class="cards">\n${items}\n      </div>\n    </section>`;
  }).join('\n');

  const intro = renderMarkdown([
    'Everything about how Crads AI works, in the open. The whole product manual is',
    'public: what a mineral is, how you get one, how to connect things to it, what',
    'your community can and cannot see, and what happens if we go away.',
    '',
    'The deeper usage craft, the recipe library and the hosting playbook, ships inside',
    'the product itself, where your assistant can read it alongside everything else it',
    'knows about you.',
  ].join('\n'));

  files.push({
    rel: path.join('docs', 'index.html'),
    content: shell({
      title: 'Docs',
      description: 'How Crads AI works: getting a mineral, connecting it, what your community can see, and the legal detail.',
      path: '/docs',
      extraClass: 'docs-index',
      side: sidebar(groups, ''),
      search,
      body: `<h1>Docs</h1>\n${intro}\n${doorsHtml}\n<div class="docs-index-groups">\n${indexGroups}\n  </div>`,
    }),
  });

  // the shots those pages actually reference, and no others
  const used = [...new Set(pages.flatMap((p) => extractShotRefs(p.body)))].sort();
  return { files, shots: used, pageCount: pages.length, held: all.length - pages.length };
}

if (process.argv[1] && process.argv[1].endsWith('publish.mjs')) {
  const { files, shots, pageCount, held } = build();
  if (!existsSync(SITE)) { console.error(`site repo not found: ${SITE}`); process.exit(1); }

  console.log(`${pageCount} public page(s), ${held} held in the image tiers, ${shots.length} shot(s)`);
  if (DRY) {
    for (const f of files) console.log(`  would write ${f.rel}`);
    for (const s of shots) console.log(`  would copy  docs/shots/${s}.png`);
    process.exit(0);
  }

  // Clear only our own output, never the site's engineering docs.
  const docsDir = path.join(SITE, 'docs');
  for (const name of existsSync(docsDir) ? readdirSync(docsDir, { withFileTypes: true }) : []) {
    if (!name.isDirectory()) continue;
    if (['audit', 'superpowers', 'shots'].includes(name.name)) continue;
    const idx = path.join(docsDir, name.name, 'index.html');
    if (existsSync(idx)) rmSync(path.join(docsDir, name.name), { recursive: true, force: true });
  }

  let wrote = 0;
  for (const f of files) {
    const dest = path.join(SITE, f.rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, f.content);
    wrote += 1;
  }

  const shotOut = path.join(SITE, 'docs', 'shots');
  mkdirSync(shotOut, { recursive: true });
  const missing = [];
  for (const s of shots) {
    const src = path.join(SHOTS, `${s}.png`);
    if (!existsSync(src)) { missing.push(s); continue; }
    copyFileSync(src, path.join(shotOut, `${s}.png`));
  }

  console.log(`wrote ${wrote} file(s) to ${SITE}/docs`);
  if (missing.length) {
    console.error(`\n${missing.length} shot(s) not captured: ${missing.join(', ')}`);
    console.error('Run: node docs/product/pipeline/shoot.mjs');
    process.exit(1);
  }
}
