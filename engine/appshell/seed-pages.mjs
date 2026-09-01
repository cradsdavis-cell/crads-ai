#!/usr/bin/env node
// seed-pages.mjs <boxDir> — seed the box-hosted app-shell surface (three-layer
// model, L3). The member app is a SHELL: what it renders beyond the built-in
// tabs lives ON THE BOX under <box>/dashboard/, templated here at first touch
// and member-owned from then on.
//
//   dashboard/pages.json       page manifest {template_version, pages:[{id,title}]}
//   dashboard/pages/<id>.html  page fragments (HTML + optional <script> using pageApi)
//   dashboard/cards.json       config-level Dashboard card overrides/additions
//   ownership.json             owns-vs-manages record (L2), default member-owned
//
// Idempotent and NON-DESTRUCTIVE: only files that are MISSING are created, so a
// member's edited pages are never overwritten by a machinery update. New template
// pages added in later engine versions appear (they're missing on the box), but
// existing files are the member's. `.template-version` records what was last
// seeded so the assistant can offer a diff-and-reapply when templates move on.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const box = path.resolve(process.argv[2] || '/state');
const TPL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates');
const dash = path.join(box, 'dashboard');
mkdirSync(path.join(dash, 'pages'), { recursive: true });

// Deleted pages stay deleted (panel iteration 2, R15). page-delete.mjs writes
// the id to dashboard/pages.deleted.json; without this the very next run (the
// app calls this seeder on every pages-list) would re-create the file and
// re-list it, undoing the member's delete silently. To bring an example page
// back, drop its id from that file and re-run.
const tombstones = (() => {
  try { const t = JSON.parse(readFileSync(path.join(dash, 'pages.deleted.json'), 'utf8')); return new Set(Array.isArray(t) ? t.map(String) : []); }
  catch { return new Set(); }
})();
const seed = (rel) => {
  const dst = path.join(dash, rel);
  if (existsSync(dst)) return false;
  writeFileSync(dst, readFileSync(path.join(TPL, rel)));
  return true;
};

let created = 0;
const manifestSeeded = seed('pages.json');
if (manifestSeeded) created++;
if (seed('cards.json')) created++;
// A freshly seeded manifest is entirely ours, so every entry is a seed entry
// (the template says so too; this holds even if a template entry forgets).
if (manifestSeeded) {
  try {
    const mf = path.join(dash, 'pages.json');
    const fresh = JSON.parse(readFileSync(mf, 'utf8'));
    if (Array.isArray(fresh.pages) && fresh.pages.some((p) => p && p.id && p.seed !== true)) {
      fresh.pages = fresh.pages.map((p) => (p && p.id ? { ...p, seed: true } : p));
      writeFileSync(mf, JSON.stringify(fresh, null, 2) + '\n');
    }
  } catch { /* not ours to fix */ }
}
const newPageFiles = [];
for (const f of readdirSync(path.join(TPL, 'pages'))) { if (tombstones.has(f.replace(/\.html$/, ''))) continue; if (seed(path.join('pages', f))) { created++; newPageFiles.push(f); } }

// Manifest merge for NEWLY-seeded pages only. The nav is driven by the member's
// own pages.json, so a template page added in a later engine version would land
// on disk invisible without this. Additive and narrow by design: an entry is
// added ONLY for a page whose file was seeded in THIS run (the member has never
// seen it, so nothing of theirs is overwritten or resurrected). A page the
// member deleted from their manifest but whose file survives is left deleted.
if (newPageFiles.length) {
  try {
    const tplManifest = JSON.parse(readFileSync(path.join(TPL, 'pages.json'), 'utf8'));
    const mf = path.join(dash, 'pages.json');
    const mine = JSON.parse(readFileSync(mf, 'utf8'));
    if (Array.isArray(mine.pages)) {
      const have = new Set(mine.pages.map((p) => p && p.id));
      let added = 0;
      // `seed: true` marks an entry as one WE wrote (panel iteration 2, R15):
      // the app renders it with an "Example page" chip and offers delete. A
      // member-authored entry never carries it, because nothing here touches
      // entries that already exist.
      for (const p of tplManifest.pages || []) {
        if (p && p.id && !have.has(p.id) && newPageFiles.includes(p.id + '.html')) { mine.pages.push({ ...p, seed: true }); added++; }
      }
      if (added) writeFileSync(mf, JSON.stringify(mine, null, 2) + '\n');
    }
  } catch { /* a manifest we cannot parse is the member's business — never touch it */ }
}

// record the template version that was last seeded (assistant merge anchor)
const tplVersion = (() => { try { return JSON.parse(readFileSync(path.join(TPL, 'pages.json'), 'utf8')).template_version || 1; } catch { return 1; } })();
writeFileSync(path.join(dash, '.template-version'), String(tplVersion) + '\n');

// L2 ownership record: member boxes default to member-owned (Acme Collab model).
// Provisioning may stamp a different value before first boot; never overwrite.
const own = path.join(box, 'ownership.json');
if (!existsSync(own)) {
  // UNIFORM ANCHOR RULE (Mountain model, 2026-08-04): every box has exactly one
  // anchor. A box that boots with no stamped record is self-sovereign, and
  // self-sovereign MEANS anchored to the Mountain — 'crads-ai', never empty.
  // Org machinery stamps the real org anchor before first boot and wins.
  // holder_email is the ACCOUNT this mineral belongs to, written at birth because
  // nothing else ever wrote it. The ownership/access model (2026-08-10) has the
  // mineral record its holder and grants on its own disk with the directory
  // mirroring it, but the birth path was never taught to, so every box came up
  // holderless: /app/minerals and /app/admin sat empty for boxes that plainly
  // existed, and nobody could be let in by account because grant-is-the-gate and
  // there was no grant to gate on (found live 2026-08-11).
  // See docs/design-account-bound-access.md.
  //
  // The address is the verified submitter's, proven twice before it reaches here:
  // the door sends a signed token and the worker takes the email FROM the token
  // rather than the form. AIOS_OWNER_EMAIL is what provisioning stages; the older
  // AIOS_OPERATOR_EMAIL is read as a fallback so a box stamped by the rock path
  // lands the same value.
  //
  // Empty is allowed and honest. A box whose birth staged no address is holderless
  // rather than falsely attributed, and can be claimed later; writing a guess here
  // would hand someone else's mineral to whoever the guess named.
  //
  // grants[] is NOT managed_by. Management never implies read access (a rock
  // manages its members and must never read inside one), so they stay separate
  // fields and no code path may promote one into the other.
  const holderEmail = String(process.env.AIOS_OWNER_EMAIL || process.env.AIOS_OPERATOR_EMAIL || '')
    .trim().toLowerCase();
  // WHO OWNS THIS BOX, read from the same channel as the two values above
  // (2026-08-20 audit, QA finding 188). It was hardcoded 'member', so an
  // org-asset pebble contradicted its buyer's answer from its very first boot
  // and every custody surface downstream believed the file.
  //
  // FAIL-CLOSED TO MEMBER. Absent, unknown or unparseable resolves to 'member',
  // never to 'org': not knowing who owns a box must never resolve to "the org
  // owns you". The container cannot derive any of this, which is why it comes
  // through /etc/ai-os/env like AIOS_OWNER_EMAIL and AIOS_ANCHOR_ORG.
  //
  // owner_slug comes from AIOS_ANCHOR_ORG rather than a second variable: at
  // birth the owning org IS the anchoring org (the same derivation stamp-pebble
  // used with --owner-org and --anchor both set to the stamping org), so there
  // is no second value to keep in step and no absentee owner.
  //
  // This writes the BINARY vocabulary ('member' | 'org'), not the registry's
  // movable pointer form: ownership-resolve.mjs, the promote flip and
  // org-brain-wire.sh all compare against the literal 'org', so writing a slug
  // here would silently switch org-brain-wire off on a string comparison.
  const anchorOrg = String(process.env.AIOS_ANCHOR_ORG || '').trim().toLowerCase();
  const ownerIsOrg = String(process.env.AIOS_OWNER || '').trim().toLowerCase() === 'org' && !!anchorOrg;
  writeFileSync(own, JSON.stringify({
    owner: ownerIsOrg ? 'org' : 'member', managed_by: 'org', machinery_by: 'crads-ai', tier: 'pebble',
    // anchor is left exactly as it was. The uniform-anchor rule above is a
    // separate ruling with its own stamping path, and quietly changing it here
    // because ownership moved would be a second decision smuggled into this one.
    anchor: 'crads-ai',
    ...(ownerIsOrg ? { owner_slug: anchorOrg } : {}),
    holder_email: holderEmail, grants: [],
  }, null, 2) + '\n');
  created++;
}
console.log(`appshell: ${created} file(s) seeded (template v${tplVersion})`);
