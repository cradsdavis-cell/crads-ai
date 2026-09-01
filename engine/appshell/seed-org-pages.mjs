#!/usr/bin/env node
// seed-org-pages.mjs <inbox-pages-dir> <dashboard-dir> <gh-owner> <box-dir>
// <from-override>: box-side seed of org-published pages onto a member's box.
// Extracted verbatim (task 3, spec 2026-08-25 § 5.1) from the inline `node -e`
// that used to live inside seed_pages() in engine/box/org-sync.sh. Same five
// arguments, same order (kept for CLI-shape parity with org-sync.sh's
// existing positional call), same tombstone and never-overwrite rules.
//
// The per-page copy-plus-manifest-entry work now lives in install-page.mjs
// (spec 2026-08-26-delivery-model § 5a), shared with the new explicit member
// install verb (page-install.mjs) so the two paths cannot drift apart. This
// file keeps everything that is specific to the AUTO-SEED sweep: discovering
// every pack under the inbox, the id regex, and the tombstone filter (an
// auto-seed must never resurrect a page the member deleted; an explicit
// install is a different policy and owns its own tombstone handling).
//
// RETIRED LEG (delivery-model step 7c, Part B). Reconcile (steps 3 and 6)
// now stages every kind's payload automatically, pages included, to
// offers-pages/ (pickup-only: nothing reads it until the member takes an id
// deliberately via page-install.mjs). So nothing writes <inbox>/pages/ any
// more except a hand-run install-pack.mjs (itself deprecated, brain-template
// side of this same step). What is still under here is content an operator
// delivered by hand before today, on a box that has since been synced at
// least once, and it must not vanish out from under a member who already has
// it: pages already on disk are never touched, only arrival changes. So the
// per-id loop below now splits on whether the id ALREADY carries a manifest
// entry: an id with one is repaired (a missing file recreated; the manifest
// itself is never touched, matching the template rule this file always
// followed); an id with none is left alone entirely, no file, no manifest
// entry, for the member to pick up deliberately instead. That split makes
// the ownership.json-anchor / gh-owner / fromOverride "from" resolution this
// file used to do dead code: it only ever mattered for deriving a BRAND NEW
// entry's `from`, and this loop no longer creates one, so those three CLI
// arguments are accepted but no longer read (see below). The sibling
// <id>.json title-derivation this file used to do for new entries retires
// with it too: installPage still does it, and is still exercised doing it,
// by page-install.mjs's explicit path.
import { readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { installPage } from './install-page.mjs';

// The gate (task 3, spec 2026-08-25 § 5.1): every rule page-lint checks is
// already inert at runtime (opaque iframe, deny-all CSP, parent-side verb
// whitelist), so a failing page is never dangerous, only useless. This
// exists purely so an operator reading the sync log is told the page will
// not work, at seed time, instead of it landing silently broken.

// Still a 5-argument CLI (src, dash, gh-owner, box, from-override) so
// org-sync.sh's existing positional call needs no change; only the first two
// are read now (see the file header for why the last three no longer are).
const [src, dash] = process.argv.slice(2);

const pagesDir = path.join(dash, 'pages');
mkdirSync(pagesDir, { recursive: true });

// Pages the member deleted (page-delete's tombstone) stay deleted: this is
// the very next sync after a delete re-pulling the same inbox, and without
// this check it would silently undo the member's delete.
let gone = new Set();
try {
  const t = JSON.parse(readFileSync(path.join(dash, 'pages.deleted.json'), 'utf8'));
  if (Array.isArray(t)) gone = new Set(t.map(String));
} catch { /* no tombstone file, or unreadable: nothing is deleted */ }

// The has-entry / has-none split (step 7c, Part B): only an id already in the
// manifest is this loop's to touch. Read once, up front: this loop never adds
// an entry (the has-one branch never touches the manifest; the has-none
// branch never calls installPage at all), so the set can never go stale
// mid-run.
let manifestIds = new Set();
try {
  const m = JSON.parse(readFileSync(path.join(dash, 'pages.json'), 'utf8'));
  if (Array.isArray(m.pages)) manifestIds = new Set(m.pages.filter(Boolean).map((p) => p.id));
} catch { /* no manifest yet, or unreadable: nothing has an entry */ }

for (const pack of readdirSync(src)) {
  const pd = path.join(src, pack);
  if (!statSync(pd).isDirectory()) continue;
  for (const f of readdirSync(pd)) {
    if (!f.endsWith('.html')) continue;
    const id = f.replace(/\.html$/, '');
    if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(id)) continue;
    if (gone.has(id)) continue; // deleted by the member (page-delete tombstone): stays deleted
    if (!manifestIds.has(id)) continue; // no manifest entry: a new arrival, left for pickup, not auto-seeded

    const r = installPage(path.join(pd, f), dash, id, {});
    if (!r.ok) {
      // r.why is always 'lint' here: installPage only ever refuses when the
      // file is missing (would-be-copy) and fails the page contract.
      console.log(`org-sync: skipped ${pack}/${f}: will not work as written, ${r.detail} at line ${r.line}`);
      continue; // no copy; the manifest entry already existed and stays untouched either way
    }
  }
}
