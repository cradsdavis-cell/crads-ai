#!/usr/bin/env node
// page-install.mjs <state-dir> <brain-root> <id> [rock]: member pickup of ONE
// offered page onto their own act (spec 2026-08-26-delivery-model § 5a).
//
// DORMANT ON PURPOSE. This file has no caller yet: the verb that invokes it
// is a later step (5b). It ships now, alone, so the box side of page pickup
// is live before anything wires it up - box, then app, then rock, per the
// rollout order Sam set. Nothing about the legacy auto-seed path
// (seed-org-pages.mjs, still running on every org-sync tick) changes because
// of this file's existence, and nothing on a box reads offers-pages/ until
// the app-side verb lands.
//
// Modeled tightly on dir-install.mjs, which already solved every hard part of
// member-initiated pickup: the same inbox enumeration (anchor
// /state/org-inbox, joined /state/org-inbox.d/<owner>/), the same lstatSync
// symlink refusal at every level, the same anchor-first resolution and
// refuse-two-joined-rocks-by-name unless [rock] says which, the same id
// regex pinned before any path.join, and the same contracted `ERROR: <sentence>`
// on every refusal, never a stack trace. brain-root is accepted for CLI-shape
// parity with dir-install (whatever wires up 5b's verb dispatch passes the
// same four arguments regardless of kind) but is unused here: a page's
// destination is the box's own dashboard under state, not the brain library.
//
// An offer is found two ways per inbox, searched in this order:
//   1. <inbox-root>/offers-pages/<id>.html (+ sibling <id>.json) - what
//      catalog-reconcile.mjs stages (delivery-model step 3). No shipped box
//      reads this path yet, which is the whole point of it existing.
//   2. <inbox-root>/pages/<pack>/<id>.html (+ sibling <id>.json) - the
//      legacy path a hand-run install-pack stages; the pack is discovered,
//      not named, exactly like dir-install's findOffer.
//
// Install-once: an id already on this box (the manifest entry OR the file on
// disk) refuses by name. A tombstoned id (dashboard/pages.deleted.json) is
// NOT checked here - an explicit install means to override a delete, so it
// is cleared on success instead of blocking the attempt. Note: the
// engine-template seeder honours the same tombstone file for its OWN ids, so
// clearing it here could in principle let a later auto-seed tick resurrect
// an engine template of the same id - but the seeder is create-only and the
// file this call just wrote now exists, so it no-ops. Said here so it does
// not surprise someone later.
import { readFileSync, readdirSync, lstatSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { SAFE } from './library-path.mjs';
import { installPage } from './install-page.mjs';

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/;

// A member-facing sentence for any way the offer stops matching what was
// just checked: org-sync races the click (a file vanishes mid-copy, ENOENT
// from a read that just succeeded moments before), or the offer itself gets
// swapped between the resolve step and the copy. No raw error text ever
// reaches the member for either case. Same contract as dir-install.mjs's
// COPY_RACE_MSG.
const COPY_RACE_MSG = 'the offer changed while it was being read, try again in a moment';

const [state, brain, id, rockArg] = process.argv.slice(2).map((s) => String(s || ''));
const die = (msg) => { console.log(`ERROR: ${msg}`); process.exit(1); };
if (!state || !brain || !id) die('usage: page-install <state-dir> <brain-root> <id> [rock]');
if (!ID_RE.test(id)) die('id must be a plain slug.');
if (rockArg && !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(rockArg)) die('rock must be a rock handle or GitHub owner');

const realDir = (p) => { try { const st = lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };
const realFile = (p) => { try { const st = lstatSync(p); return st.isFile() && !st.isSymbolicLink(); } catch { return false; } };
const confVal = (file, key) => {
  try { return (readFileSync(file, 'utf8').match(new RegExp(`^${key}=["']?([A-Za-z0-9._-]+)["']?\\s*$`, 'm')) || [])[1] || ''; }
  catch { return ''; }
};

// Every inbox as { owner, handle, root, anchor }, matching dir-install's
// inboxes() exactly (same conf files, same owner/handle resolution), except
// rooted at the whole inbox checkout instead of its dirs/ subfolder, since a
// page offer can live at either of two subpaths under that same root.
function inboxes() {
  const out = [];
  const aRoot = path.join(state, 'org-inbox');
  if (realDir(aRoot)) {
    const owner = confVal(path.join(state, 'org-inbox.conf'), 'ORG_GH_OWNER') || 'your rock';
    let handle = '';
    try { handle = String(JSON.parse(readFileSync(path.join(state, 'org-contact.json'), 'utf8')).org || ''); } catch {}
    out.push({ owner, handle, root: aRoot, anchor: true });
  }
  const joinedRoot = path.join(state, 'org-inbox.d');
  try {
    for (const owner of readdirSync(joinedRoot)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) continue;
      const root = path.join(joinedRoot, owner);
      if (!realDir(root)) continue;
      const handle = confVal(path.join(joinedRoot, `${owner}.conf`), 'ORG') || owner;
      out.push({ owner, handle, root, anchor: false });
    }
  } catch { /* no joined inboxes */ }
  return out;
}

// Find this id's offer in one inbox, offers-pages first, then the legacy
// pages/<pack>/<id>.html (pack discovered, not named, like dir-install's
// findOffer). Every level is real-dir/real-file checked before use, so a
// symlink anywhere in the path - the offers-pages dir itself, a pack dir, or
// the leaf .html - is refused rather than followed.
function findOffer(inbox) {
  const opDir = path.join(inbox.root, 'offers-pages');
  if (realDir(opDir)) {
    const html = path.join(opDir, `${id}.html`);
    if (realFile(html)) {
      const json = path.join(opDir, `${id}.json`);
      return { source: 'offers-pages', html, json: realFile(json) ? json : null };
    }
  }
  const pagesRoot = path.join(inbox.root, 'pages');
  let packs = [];
  try { packs = readdirSync(pagesRoot); } catch { return null; }
  for (const pack of packs.sort()) {
    if (!SAFE.test(pack)) continue;
    const packDir = path.join(pagesRoot, pack);
    if (!realDir(packDir)) continue;
    const html = path.join(packDir, `${id}.html`);
    if (realFile(html)) {
      const json = path.join(packDir, `${id}.json`);
      return { source: 'pages', pack, html, json: realFile(json) ? json : null };
    }
  }
  return null;
}

const found = [];
for (const inbox of inboxes()) {
  if (rockArg && rockArg !== inbox.owner && rockArg !== inbox.handle) continue;
  const hit = findOffer(inbox);
  if (hit) found.push({ inbox, ...hit });
}
if (!found.length) die(`${id} is not in your inbox. Your rock has not offered it to you, or it has not arrived yet (org-sync runs every 2 minutes).`);
const anchorHit = found.find((f) => f.inbox.anchor);
let pick = anchorHit || found[0];
if (!rockArg && !anchorHit && found.length > 1) {
  die(`${id} is offered by more than one of your rocks (${found.map((f) => f.inbox.handle || f.inbox.owner).join(',')}). Say which one with rock.`);
}

const dash = path.join(state, 'dashboard');
const dstFile = path.join(dash, 'pages', `${id}.html`);
let manifest = {};
try { manifest = JSON.parse(readFileSync(path.join(dash, 'pages.json'), 'utf8')); } catch { /* no manifest yet, or unreadable: treated as no existing entries */ }
const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
// Install-once refuses only the GENUINE already-installed case: the file on
// disk AND a manifest entry both already present. That used to be "refuse
// on EITHER signal", which was wrong the same way the M5 bug in
// seed-org-pages.mjs was wrong (see install-page.mjs's comment on
// installPage): a page whose file exists but never got a manifest entry
// (an orphan - can happen if a copy landed but this process died, or an
// older build, before the manifest write) is not "already installed" from
// the member's side, it is HALF installed, and it is on their box either
// way. Refusing it here told the member "already installed" while the page
// never actually appeared in their nav - a false already-done. The other
// half-present case (a manifest entry with no file, e.g. the file was
// deleted by hand outside the app) is left to installPage below too: it
// will recreate the file and leave the existing entry alone. Only when BOTH
// signals already agree the page is here do we stop the member short.
if (existsSync(dstFile) && pages.some((p) => p && p.id === id)) {
  die(`${id} is already installed. Delete it first to reinstall the current version.`);
}

const from = pick.inbox.handle || pick.inbox.owner;
let titleJson = '';
if (pick.json) { try { titleJson = readFileSync(pick.json, 'utf8'); } catch { /* vanished between the check and here: title falls back to the id */ } }

let result;
try {
  result = installPage(pick.html, dash, id, { from, titleJson });
} catch {
  // The offer's .html vanished (or stopped being a regular file) between
  // findOffer's check and installPage's read - a genuine race, not this
  // member's fault. No partial page.json write survives a thrown read: the
  // manifest write inside installPage only ever happens after a successful
  // copy or a successful read of an already-existing pages.json, so nothing
  // is left half-done here.
  die(COPY_RACE_MSG);
}
if (!result.ok) {
  // why is always 'lint' here: installPage only refuses when the file is
  // missing (it is, we already checked) and the offer fails the page
  // contract.
  die(`${id} could not be installed: it will not work as written, ${result.detail} at line ${result.line}.`);
}

// Explicit install clears a tombstone left by an earlier delete (Sam's
// ruling): delete-then-reinstall of the SAME offer is self-service, so the
// member does not need to ask anyone to get it back.
const tombFile = path.join(dash, 'pages.deleted.json');
try {
  const gone = JSON.parse(readFileSync(tombFile, 'utf8'));
  if (Array.isArray(gone) && gone.includes(id)) {
    const tombTmp = `${tombFile}.tmp.${process.pid}`;
    writeFileSync(tombTmp, JSON.stringify(gone.filter((g) => g !== id)) + '\n');
    renameSync(tombTmp, tombFile);
  }
} catch { /* no tombstone file, unreadable, or not an array: nothing to clear */ }

// The reported line has to match what actually happened, not just say "it
// worked": the early guard above only stops the genuine both-present case,
// so installPage can still come back having done less than a full fresh
// install - the file could already have been on the box with only the
// manifest entry missing (an orphan), and all that call did was add the
// entry. Saying "installed" for that would claim a copy that never
// happened. Three outcomes:
//   copied            -> the file is newly on disk either way (a plain
//                         fresh install, or the rarer case where a
//                         manifest entry existed with no file and this
//                         call restored it) - "installed" is true either way.
//   !copied, manifestChanged -> the orphan case: file was already there,
//                         only the missing entry got added just now.
//   !copied, !manifestChanged -> nothing changed (both already agreed the
//                         page was here - only reachable via a race with
//                         another process between the guard above and here).
if (result.copied) {
  console.log(`OK: ${id} installed.`);
} else if (result.manifestChanged) {
  console.log(`OK: ${id} was already on your box. It has been added to your pages.`);
} else {
  console.log(`OK: ${id} is already installed, nothing changed.`);
}
