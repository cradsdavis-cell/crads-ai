// install-page.mjs: the shared page-pickup implementation (spec
// 2026-08-26-delivery-model § 5a). Extracted from the per-page loop body
// that used to live only in seed-org-pages.mjs, so the legacy auto-seeder
// AND the explicit member install verb (page-install.mjs) share ONE
// create-only-copy-plus-manifest-entry routine instead of two copies that
// can drift apart.
//
// Template rule, unchanged from the inline script this came from: a missing
// page file is created; an existing one is NEVER touched. Member edits win,
// always. The page-lint gate only ever runs against a page this call is
// about to write for the first time - an existing dst is already on the box
// and untouched either way, so linting it here would flag content this call
// never writes anything about.
//
// Tombstones (dashboard/pages.deleted.json) are deliberately NOT this
// module's concern. The auto-seeder filters a tombstoned id out before ever
// calling this (a page the member deleted must not be silently re-added on
// the next sync), while an explicit member install (page-install.mjs) means
// to override a tombstone on purpose - delete-then-reinstall is self-service
// - and clears it itself, after a successful call here. Baking one tombstone
// policy into this shared routine would be wrong for whichever caller does
// not want it, so each caller owns its own tombstone check.
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { lintPage } from './page-lint.mjs';

// installPage(srcFile, dash, id, { from, titleJson })
//   srcFile   - path to the offered .html file (already resolved by the caller)
//   dash      - the box's dashboard dir (dashboard/pages/<id>.html is the dest)
//   id        - the page id (already validated by the caller)
//   from      - the rock this page is attributed to; omitted when empty
//   titleJson - the raw text of the offer's sibling <id>.json, or '' if there
//               is none; read by the CALLER because the sibling lives at a
//               different path depending on which offer shape resolved it
//               (offers-pages/<id>.json vs pages/<pack>/<id>.json), so this
//               module never needs to know where the offer's files live.
//
// Returns { ok: true, copied, manifestChanged } on success (copied and/or
// manifestChanged can both be false - a fully-idempotent no-op is still ok),
// or { ok: false, why: 'lint', detail, line } when the file is missing and
// the source fails the page contract - nothing is written in that case.
export function installPage(srcFile, dash, id, { from = '', titleJson = '' } = {}) {
  const pagesDir = path.join(dash, 'pages');
  mkdirSync(pagesDir, { recursive: true });
  const dst = path.join(pagesDir, `${id}.html`);

  let copied = false;
  if (!existsSync(dst)) {
    const { ok, violations } = lintPage(readFileSync(srcFile, 'utf8'));
    if (!ok) {
      const first = violations[0];
      return { ok: false, why: 'lint', detail: first.detail, line: first.line };
    }
    copyFileSync(srcFile, dst);
    copied = true;
  }

  const manifestFile = path.join(dash, 'pages.json');
  let manifest = {};
  try { manifest = JSON.parse(readFileSync(manifestFile, 'utf8')); } catch { /* no manifest yet, or unreadable: start fresh */ }
  if (!Array.isArray(manifest.pages)) manifest.pages = [];

  let manifestChanged = false;
  if (!manifest.pages.some((p) => p && p.id === id)) {
    let title = id;
    try {
      const t = JSON.parse(titleJson).title;
      if (typeof t === 'string' && t.trim()) title = t.trim().slice(0, 80);
    } catch { /* no sibling json, unreadable, unparseable, or none supplied: title falls back to the id */ }
    const entry = { id, title };
    if (from) entry.from = from;
    manifest.pages.push(entry);
    manifestChanged = true;
  }
  // Only write the manifest if it actually changed THIS call. Gating this on
  // `copied` instead of on the manifest itself was a real bug (fix wave
  // 2026-08-25, M5, seed-org-pages.mjs): a page whose file already exists on
  // disk but has no manifest entry yet still needs a fresh entry pushed
  // above, with no copy alongside it - so the guard must track whether the
  // manifest changed, never whether a file was copied. Carried forward
  // verbatim into the shared routine; do not regress it back to `copied`.
  if (manifestChanged) writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

  return { ok: true, copied, manifestChanged };
}
