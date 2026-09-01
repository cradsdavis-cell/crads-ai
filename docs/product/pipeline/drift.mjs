#!/usr/bin/env node
// drift.mjs - the soft drift ledger.
//
//   node docs/product/pipeline/drift.mjs
//
// Generated pages cannot drift (generate.test.mjs) and legal pages cannot drift
// silently (legal.mjs). Hand-written prose is the remaining rot risk, and no
// test can tell whether a paragraph still describes the screen.
//
// So a page DECLARES what it describes:
//
//   pins: engine/skills/inbox.md, wizard/panel/member.html
//   reviewed: 2026-08-24
//
// and this walks git history: if a pinned path has commits newer than the review
// date, the page needs a human re-read. It WARNS and exits 0 by design (the spec
// triages this on Sundays alongside /weekly): a stale paragraph is not a reason
// to block a deploy, but an invisible stale paragraph is how docs die.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadTree } from './source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const PAGES = path.join(HERE, '..', 'pages');

const lastTouched = (p) => {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', p], { cwd: REPO, encoding: 'utf8' }).trim();
    return out || null;
  } catch { return null; }
};

export function ledger(pages) {
  const rows = [];
  for (const pg of pages) {
    if (!pg.pins.length) continue;
    for (const pin of pg.pins) {
      const when = lastTouched(pin);
      if (!when) { rows.push({ slug: pg.slug, pin, when: null, why: 'pinned path not found in history' }); continue; }
      if (when > pg.reviewed) rows.push({ slug: pg.slug, pin, when, why: `changed ${when}, page reviewed ${pg.reviewed}` });
    }
  }
  return rows;
}

if (process.argv[1] && process.argv[1].endsWith('drift.mjs')) {
  const pages = existsSync(PAGES) ? loadTree(PAGES) : [];
  const rows = ledger(pages);
  const pinned = pages.filter((p) => p.pins.length).length;
  if (!rows.length) {
    console.log(`no drift: ${pinned} of ${pages.length} page(s) pin code, all reviewed since`);
  } else {
    console.log(`${rows.length} page/pin pair(s) need a re-read:\n`);
    for (const r of rows) console.log(`  ${r.slug}\n    ${r.pin}: ${r.why}`);
    console.log('\nRe-read the page against the code, then bump reviewed: to today.');
  }
}
