#!/usr/bin/env node
// dir-install.mjs <state-dir> <brain-root> <id> [rock]: member pickup of a
// pack directory into library/<pack>/<id>/ (spec 2026-08-25 § 5.3).
//
// The catalog-install verb delegates kind:'dir' here. Resolution rules match
// the skill path exactly: the anchor's offer wins; a single joined rock's
// otherwise; two joined rocks offering one id is refused by name unless
// [rock] (handle or GitHub owner) says which.
//
// Install-once (R4/R5): install-once is keyed to the id, not the destination
// path (final-review fix F1): an id already present in the index refuses by
// name regardless of which pack it is filed under, and an on-disk tree at
// the destination that the index does not know about still refuses too. A
// tombstone in library/library.deleted.json is cleared by this explicit act.
// The inbox is rock-authored: ids are validated, every level is lstat-checked,
// the destination is containment-checked before anything is written (F3),
// and the copy itself never follows symlinks.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, existsSync, cpSync, rmSync, renameSync } from 'node:fs';
import path from 'node:path';
import { SAFE, isContained, readDirsIndex } from './library-path.mjs';

// A member-facing sentence for any way the offer stops matching what the box
// already checked it against: org-sync races the click (a file vanishes
// mid-copy, ENOENT from the filter's lstatSync), or the offer root itself
// gets swapped for a symlink between findOffer's check and the copy (cpSync
// then copies nothing and no dest is created). No raw error text ever
// reaches the member for either case.
const COPY_RACE_MSG = 'the offer changed while it was being copied, try again in a moment';

const [state, brain, id, rockArg] = process.argv.slice(2).map((s) => String(s || ''));
const die = (msg) => { console.log(`ERROR: ${msg}`); process.exit(1); };
if (!state || !brain || !id) die('usage: dir-install <state-dir> <brain-root> <id> [rock]');
if (!SAFE.test(id)) die('id must be a kebab-case directory id');
if (rockArg && !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(rockArg)) die('rock must be a rock handle or GitHub owner');

const realDir = (p) => { try { const st = lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };
const confVal = (file, key) => {
  try { return (readFileSync(file, 'utf8').match(new RegExp(`^${key}=["']?([A-Za-z0-9._-]+)["']?\\s*$`, 'm')) || [])[1] || ''; }
  catch { return ''; }
};

// Every inbox as { owner, handle, dirsRoot, anchor }.
function inboxes() {
  const out = [];
  const aDirs = path.join(state, 'org-inbox', 'dirs');
  if (realDir(aDirs)) {
    const owner = confVal(path.join(state, 'org-inbox.conf'), 'ORG_GH_OWNER') || 'your rock';
    let handle = '';
    try { handle = String(JSON.parse(readFileSync(path.join(state, 'org-contact.json'), 'utf8')).org || ''); } catch {}
    out.push({ owner, handle, dirsRoot: aDirs, anchor: true });
  }
  const joinedRoot = path.join(state, 'org-inbox.d');
  try {
    for (const owner of readdirSync(joinedRoot)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) continue;
      const dirsRoot = path.join(joinedRoot, owner, 'dirs');
      if (!realDir(path.join(joinedRoot, owner)) || !realDir(dirsRoot)) continue;
      const handle = confVal(path.join(joinedRoot, `${owner}.conf`), 'ORG') || owner;
      out.push({ owner, handle, dirsRoot, anchor: false });
    }
  } catch { /* no joined inboxes */ }
  return out;
}

// Find <dirsRoot>/<pack>/<id> in one inbox; the pack is discovered, not named.
function findOffer(inbox) {
  let packs = [];
  try { packs = readdirSync(inbox.dirsRoot); } catch { return null; }
  for (const pack of packs.sort()) {
    if (!SAFE.test(pack)) continue;
    const packDir = path.join(inbox.dirsRoot, pack);
    if (!realDir(packDir)) continue;
    const offer = path.join(packDir, id);
    if (realDir(offer)) return { pack, offer, manifest: path.join(packDir, `${id}.yaml`) };
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

const libRoot = path.join(brain, 'library');
const idxFile = path.join(libRoot, 'index.json');
// F2 fix (final review): an absent index (no file yet) is the normal
// first-install case and starts empty. An index that IS present but fails to
// parse, or parses without a `dirs` array, refuses outright instead of being
// silently reset to {dirs:[]}: resetting would drop every previously
// installed dir from the index, orphaning all of them at once even though
// their trees are still sitting on disk untouched.
const loaded = readDirsIndex(idxFile);
if (!loaded.ok) die('the library index is damaged and could not be read; nothing was installed. Ask your rock or run dir-remove on the ids you know about once the index is fixed.');
const index = loaded.index;

// F1 fix (final review): install-once is keyed to the id, not the
// destination path. Refusing only on an existing library/<pack>/<id> meant
// installing the same id from a second pack (a rock renames a pack, or two
// rocks each ship an id with the same name) silently replaced the index
// entry and orphaned the first tree forever, with no verb left to find it
// again. An id already tracked in the index refuses by name, naming where it
// actually lives, regardless of which pack this offer is filed under.
const existingById = index.dirs.find((d) => d && d.id === id);
if (existingById) die(`${id} is already installed at library/${existingById.pack}/${id}. Remove it first to reinstall the current version.`);

const dest = path.join(libRoot, pick.pack, id);
// Kept alongside the id-check above: an on-disk tree at the destination that
// the index does not know about (e.g. a hand-copied directory, or a prior
// index write that never completed) still refuses, rather than being
// silently overwritten by cpSync.
if (existsSync(dest)) die(`${id} is already installed at library/${pick.pack}/${id}. Remove it first to reinstall the current version.`);

// F3 fix (final review): dir-remove has always refused a destination that
// resolves outside library/ once intermediate symlinks are accounted for
// (spec § 5.3); dir-install had no equivalent check on the write side, so a
// pre-existing library/<pack> symlink let a "successful" install write
// content entirely outside the brain, which dir-remove would then itself
// refuse to touch ("points outside the library"). Same shared guard as
// dir-remove, run BEFORE any directory is created or anything is copied.
if (!isContained(libRoot, dest)) die(`${id} could not be installed: library/${pick.pack} points outside the library.`);

let kind = '';
try {
  const st = lstatSync(pick.manifest);
  // F6 fix (final review): the manifest's kind: value was the field's only
  // validation anywhere (pack-lint never opens dirs/<id>.yaml), and the
  // original regex refused a single-quoted value and any digit in the kind
  // name, silently dropping the field rather than reading it. Widened to
  // accept single or double quotes and [a-z0-9-].
  if (st.isFile() && !st.isSymbolicLink()) kind = (readFileSync(pick.manifest, 'utf8').match(/^kind:\s*(['"]?)([a-z0-9-]{1,32})\1\s*$/m) || [])[2] || '';
} catch { /* optional manifest */ }

mkdirSync(path.dirname(dest), { recursive: true });
// verbatim copy, symlinks never followed and never recreated. F1 fix
// (2026-08-25 review): cpSync can throw mid-copy (the filter's lstatSync
// hits something the walk already listed but that is now gone, or something
// it cannot read as a regular file) — wrap it so a raced or hostile offer
// never leaves a partial library/<pack>/<id>/ with no index entry, which
// would otherwise strand the member (retry refuses "already installed",
// dir-remove refuses "not installed", no verb left to recover (dir-remove's
// F4 fallback scan now covers this case too, see dir-remove.mjs). And cpSync
// can also complete without throwing yet create nothing at all, if the
// offer root itself stopped being a real directory between findOffer's
// check and this call (its own filter call on the root then rejects it) —
// so the postcondition below checks dest actually exists before this script
// is allowed to claim OK or write an index entry for it.
try {
  cpSync(pick.offer, dest, { recursive: true, dereference: false, filter: (src) => !lstatSync(src).isSymbolicLink() });
} catch {
  rmSync(dest, { recursive: true, force: true });
  die(COPY_RACE_MSG);
}
if (!existsSync(dest)) die(COPY_RACE_MSG); // nothing was written; nothing to clean up

index.dirs = index.dirs.filter((d) => !(d && d.id === id));
const entry = { id, pack: pick.pack, rock: pick.inbox.handle || pick.inbox.owner, installed: new Date().toISOString().slice(0, 10) };
if (kind) entry.kind = kind;
index.dirs.push(entry);
// F2 fix (2026-08-25 review): tmp-file + renameSync, the same atomic-write
// idiom the codebase already uses for cadence.json (wizard/panel/panel-server.mjs
// skill-remove). A plain writeFileSync loses updates under two concurrent
// installs racing the same read-modify-write (reproduced: two OKs, one
// entry). Rename is atomic so a reader never observes a half-written file,
// and the LATER of two concurrent renames always wins outright rather than
// interleaving bytes. This narrows but does not fully close the race: both
// processes can still read the index before either one renames, so the
// second rename can still overwrite the first process's entry outright
// (last-writer-wins, not a merge). Full serialization would need an
// external lock across the read-modify-write, which is out of scope here.
const idxTmp = `${idxFile}.tmp.${process.pid}`;
writeFileSync(idxTmp, JSON.stringify(index, null, 2) + '\n');
renameSync(idxTmp, idxFile);

const tombFile = path.join(libRoot, 'library.deleted.json');
try {
  const gone = JSON.parse(readFileSync(tombFile, 'utf8'));
  if (Array.isArray(gone) && gone.includes(id)) {
    const tombTmp = `${tombFile}.tmp.${process.pid}`;
    writeFileSync(tombTmp, JSON.stringify(gone.filter((g) => g !== id)) + '\n');
    renameSync(tombTmp, tombFile);
  }
} catch { /* no tombstones */ }

console.log(`OK: ${id} installed to library/${pick.pack}/${id}.`);
