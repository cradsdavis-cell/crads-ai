#!/usr/bin/env node
// coverage.mjs - how much of the product the docs actually cover.
//
//   node docs/product/pipeline/coverage.mjs
//
// "More depth" is unmeasurable without a denominator, and v1 felt finished while
// covering 8 of 14 nav sections and 1 of 62 connectors. The denominator is the
// extracted inventory; the numerator is what the pages claim via `surface:`.
//
// This REPORTS rather than blocks. A surface with no page is honest work
// outstanding, not a broken build, and a gate that fails on unfinished writing
// would be turned off within a day. What IS enforced (in gates.test.mjs) is that
// a page never claims a surface the product does not have.
//
// The denominator is extracted LIVE from the panel (inventory.mjs), not read
// from evidence/inventory.json. The snapshot was last cut before the Team tab
// existed, so coverage reported 7/7 while a whole screen had no page (found
// 2026-10-13). A snapshot is a record for humans; a gate has to read the
// product as it is now.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTree } from './source.mjs';
import { inventory } from './inventory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGES = path.join(HERE, '..', 'pages');

export function coverage() {
  const inv = inventory();
  const pages = loadTree(PAGES);
  const claimed = new Map();
  for (const p of pages) if (p.surface) claimed.set(p.surface, p);

  const rows = inv.navSections.map((n) => ({
    sec: n.sec,
    label: n.group ? `${n.group} > ${n.label}` : n.label,
    face: n.face,
    hidden: n.hidden === true,
    page: claimed.get(n.sec) ? claimed.get(n.sec).slug : null,
  }));
  const phantom = [...claimed.keys()].filter((s) => !inv.navSections.some((n) => n.sec === s));
  const covered = rows.filter((r) => r.page).length;
  return { rows, phantom, covered, total: rows.length, inv };
}

if (process.argv[1] && process.argv[1].endsWith('coverage.mjs')) {
  const { rows, phantom, covered, total } = coverage();
  console.log(`SURFACE COVERAGE  ${covered}/${total}\n`);
  for (const r of rows) {
    console.log(`  ${r.page ? 'ok  ' : '--  '}${r.face.padEnd(7)}${r.sec.padEnd(13)}${(r.label + (r.hidden ? ' (hidden until needed)' : '')).padEnd(34)}${r.page || ''}`);
  }
  if (phantom.length) console.log(`\nclaims a surface the product does not have: ${phantom.join(', ')}`);
  const missing = rows.filter((r) => !r.page);
  if (missing.length) console.log(`\n${missing.length} to write: ${missing.map((m) => m.sec).join(', ')}`);
}
