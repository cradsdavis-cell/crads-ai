// source.mjs - the docs source contract, per the documentation-system spec
// (docs/superpowers/specs/2026-08-24-documentation-system.md).
//
// Every page under docs/product/pages/ is markdown with a frontmatter block.
// Two axes, never conflated: `audience` says who a page is written for,
// `access` says who may see it. Access is `public` on every page today (the
// gate exists DISARMED, the T10 pattern); arming it later is a data change
// here, not a refactor.
//
// The validator also encodes two spec rulings as refusals, so drift is a
// failing build and not a quiet exception:
//   - mode: how-to requires `installs:` (every how-to ships an artefact
//     through catalog-install; a how-to without one is prose pretending)
//   - mode: legal requires `version:` + `effective:` (legal artefacts are
//     version-stamped representations, not documentation)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const AUDIENCES = ['public', 'pebble', 'rock'];
export const ACCESS = ['public']; // the disarmed gate: one value until armed
export const MODES = ['tutorial', 'how-to', 'reference', 'explanation', 'legal'];

// Cumulative visibility: a rock holder is also a pebble owner, and public is
// public. The manifest filters with this, nothing else does.
const TIER_SEES = {
  public: ['public'],
  pebble: ['public', 'pebble'],
  rock: ['public', 'pebble', 'rock'],
};

// Flat scalar frontmatter only, on purpose. The wiki-side lesson (2026-07-26,
// second-brain schema doc): lenient parsers hid 262 invalid pages for months.
// Here the parser is strict and tiny instead: `key: value` lines between two
// `---` fences, no nesting, no lists. A page that needs structure is a page
// that needs rethinking.
export function parseFrontmatter(text, file = '<page>') {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) throw new Error(`${file}: no frontmatter block`);
  const fm = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^([a-z][a-z0-9-]*):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`${file}: bad frontmatter line: ${JSON.stringify(line)}`);
    fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: text.slice(m[0].length) };
}

export function validatePage(fm, file = '<page>') {
  const errs = [];
  const need = (k) => { if (!fm[k]) errs.push(`missing ${k}:`); };
  need('title'); need('summary'); need('audience'); need('access'); need('mode');
  if (fm.audience && !AUDIENCES.includes(fm.audience)) errs.push(`audience must be one of ${AUDIENCES.join('|')}, got ${fm.audience}`);
  if (fm.access && !ACCESS.includes(fm.access)) errs.push(`access must be ${ACCESS.join('|')} (the gate is disarmed), got ${fm.access}`);
  if (fm.mode && !MODES.includes(fm.mode)) errs.push(`mode must be one of ${MODES.join('|')}, got ${fm.mode}`);
  // `installs:` is required on PEBBLE how-tos only, and the narrowing took two
  // corrections to get right (both 2026-08-24, both found by writing pages):
  //   v1 required it on every how-to. But "connect Google" is a how-to in
  //      Diataxis terms and installs nothing: the product already has the
  //      button. That conflated "how-to" with "recipe".
  //   v2 required it on every non-public how-to. But rock hosting craft ("how
  //      to run a cohort session") is human practice, and there is no file you
  //      can install that makes someone good at running a room. Demanding one
  //      would have meant inventing a fake id, which is how the rule got
  //      caught.
  // What survives is the ruling's actual content: PEBBLE craft IS the recipe
  // library, so a pebble how-to that teaches a pattern ships that pattern.
  if (fm.mode === 'how-to' && fm.audience === 'pebble' && !fm.installs) {
    errs.push('mode: how-to for audience: pebble requires installs: (pebble craft IS the recipe library; spec ruling)');
  }
  if (fm.mode === 'legal') {
    if (!fm.version) errs.push('mode: legal requires version:');
    if (!fm.effective || !/^\d{4}-\d{2}-\d{2}$/.test(fm.effective)) errs.push('mode: legal requires effective: YYYY-MM-DD');
  }
  if (fm.order && !/^\d+$/.test(fm.order)) errs.push(`order must be an integer, got ${fm.order}`);
  // `surface` names the nav section this page documents, and is what makes
  // coverage measurable instead of asserted. Validated against the extracted
  // inventory by the coverage gate, not here, so this module stays dependency-free.
  if (fm.surface && !/^[a-z0-9-]+$/.test(fm.surface)) errs.push(`surface must be a nav section id, got ${fm.surface}`);
  if (fm.generated && !['true', 'false'].includes(fm.generated)) errs.push(`generated must be true|false, got ${fm.generated}`);
  // Soft-drift bookkeeping (build step 5). `pins` names repo paths this page
  // describes; `reviewed` is the date a human last confirmed it against them.
  // drift.mjs compares the two through git history. Both optional: a page that
  // pins nothing simply never appears in the ledger.
  if (fm.reviewed && !/^\d{4}-\d{2}-\d{2}$/.test(fm.reviewed)) errs.push(`reviewed must be YYYY-MM-DD, got ${fm.reviewed}`);
  if (fm.pins && !fm.reviewed) errs.push('pins: requires reviewed: (a pin with no review date can never be checked)');
  // persona: WHO a page is written for, distinct from `audience` (which tier
  // may see it). Sam's ruling 2026-08-25: host pages carry a visible "For
  // hosts" badge everywhere they appear; everything unmarked reads as member
  // or both. Only 'host' exists as a value on purpose: a "for members" badge
  // on thirty pages would be noise.
  if (fm.persona && fm.persona !== 'host') errs.push(`persona may only be "host", got ${fm.persona}`);
  // `outcome`: the one line under the title that says what the reader will be
  // able to do (2026-09-10, Sam: the docs should say up front what a page is
  // for). Required on every public tutorial and how-to by gates.test.mjs, not
  // here, so a craft-tier page can still be drafted without one.
  if (fm.outcome && fm.outcome.length > 160) errs.push(`outcome must fit on one line (${fm.outcome.length} chars)`);
  if (errs.length) throw new Error(`${file}: ${errs.join(' · ')}`);
  return {
    title: fm.title, summary: fm.summary, audience: fm.audience,
    access: fm.access, mode: fm.mode,
    order: fm.order ? Number(fm.order) : 999,
    installs: fm.installs || null,
    generated: fm.generated === 'true',
    version: fm.version || null, effective: fm.effective || null,
    surface: fm.surface || null,
    persona: fm.persona || null,
    pins: fm.pins ? fm.pins.split(',').map((x) => x.trim()).filter(Boolean) : [],
    reviewed: fm.reviewed || null,
    outcome: fm.outcome || null,
  };
}

export function loadPage(file) {
  const { fm, body } = parseFrontmatter(readFileSync(file, 'utf8'), file);
  const page = validatePage(fm, file);
  return { ...page, body, slug: path.basename(file, '.md'), file };
}

// Load every page under a root (pages/ in production, a fixture dir in tests).
// One bad page fails the whole load: the pipeline would rather not build than
// build a tree with a hole in it.
export function loadTree(root) {
  const pages = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.md') && name !== 'README.md') pages.push(loadPage(p));
    }
  };
  walk(root);
  const slugs = new Map();
  for (const pg of pages) {
    if (slugs.has(pg.slug)) throw new Error(`duplicate slug ${pg.slug}: ${slugs.get(pg.slug)} and ${pg.file}`);
    slugs.set(pg.slug, pg.file);
  }
  return pages;
}

// What a reader at `tier` sees. This is the ONE place visibility lives.
export function visibleTo(pages, tier) {
  const sees = TIER_SEES[tier];
  if (!sees) throw new Error(`unknown tier ${tier}`);
  return pages.filter((p) => sees.includes(p.audience));
}
