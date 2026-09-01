#!/usr/bin/env node
// dir-remove.mjs <brain-root> <id>: uninstall a library directory
// (spec 2026-08-25 § 4). Removes exactly library/<pack>/<id>/ (pack from the
// index entry), drops the index entry, tombstones the id. The tombstone stops
// nothing explicit: a later dir install by the member clears it. Both the id
// and the recorded pack are re-validated here so a corrupted index can never
// aim the rm outside library/.
import { readFileSync, writeFileSync, rmSync, readdirSync, lstatSync, renameSync } from 'node:fs';
import path from 'node:path';
import { SAFE, isContained, readDirsIndex } from './library-path.mjs';

const [brain, id] = process.argv.slice(2).map((s) => String(s || ''));
const die = (msg) => { console.log(`ERROR: ${msg}`); process.exit(1); };
if (!brain || !id) die('usage: dir-remove <brain-root> <id>');
if (!SAFE.test(id)) die('id must be a kebab-case directory id');

const libRoot = path.join(brain, 'library');
const idxFile = path.join(libRoot, 'index.json');
// F2 fix (final review): distinguish an absent index (no file yet, so
// nothing is installed) from a present-but-unparseable one. Silently
// resetting the latter to {dirs:[]} used to make every previously installed
// dir look uninstalled, and a remove that then "succeeded" against the empty
// index would have written a fresh index with only the tombstone in it,
// permanently dropping the rest. Refuse instead of guessing.
const loaded = readDirsIndex(idxFile);
if (!loaded.ok) die('the library index is damaged and could not be read; nothing was removed. Ask your rock or fix the index by hand before retrying.');
const index = loaded.index;

let entry = index.dirs.find((d) => d && d.id === id);
let recoveredFromPack = '';
if (!entry) {
  // F4 fix (final review): the index having no entry for this id does not
  // mean nothing is there. F1's cross-pack reinstall and F2's old
  // reset-on-corruption both orphan a real library/<pack>/<id> tree while
  // leaving the id untracked, and a copy that aborts mid-tree (dir-install's
  // own COPY_RACE_MSG path) can in principle do the same. Scan library/*/<id>
  // directly for a recoverable match: only kebab-case pack segments pass
  // (SAFE, same shape as everywhere else an untrusted path component is
  // checked), and only ones that pass the same containment guard dir-install
  // now runs before ever writing. Exactly one match removes cleanly and says
  // which pack it came from; more than one refuses and names all of them
  // rather than guessing; none falls through to the ordinary refusal below.
  let packs = [];
  try { packs = readdirSync(libRoot); } catch { packs = []; }
  const hits = [];
  for (const pack of packs) {
    if (!SAFE.test(pack)) continue;
    const candidate = path.join(libRoot, pack, id);
    try { lstatSync(candidate); } catch { continue; }
    if (!isContained(libRoot, candidate)) continue;
    hits.push(pack);
  }
  if (hits.length === 1) {
    entry = { id, pack: hits[0] };
    recoveredFromPack = hits[0];
  } else if (hits.length > 1) {
    die(`${id} is not in the library index and exists in more than one pack (${hits.join(', ')}). Remove the extra copies by hand, or ask your rock which one is current.`);
  }
}
if (!entry) die(`${id} is not installed in your library.`);
if (!SAFE.test(String(entry.pack || ''))) die(`the library index entry for ${id} is damaged; nothing was removed.`);

const target = path.join(libRoot, entry.pack, id);
// F3 fix (final review): same shared containment guard dir-install now runs
// before it writes, applied here on the removal side too (this is where the
// guard originated). Refuses a target that resolves outside library/, either
// because the top-level join escaped (traversal pack name) or because an
// intermediate segment is a symlink pointing elsewhere.
if (!isContained(libRoot, target)) die(`the library index entry for ${id} points outside the library; nothing was removed.`);
const resolved = path.resolve(target);

// F2 fix (2026-08-25 review): wrap destructive rmSync in try/catch to suppress raw
// stack traces, matching dir-install.mjs COPY_RACE_MSG pattern.
try {
  rmSync(resolved, { recursive: true, force: true });
} catch {
  die('that directory could not be removed just now, try again in a moment');
}

index.dirs = index.dirs.filter((d) => !(d && d.id === id));
// Atomic write: tmp-file + renameSync, matching Task 3 idiom. Ensures readers
// never observe a half-written file, and the later of two concurrent renames
// always wins.
const idxTmp = `${idxFile}.tmp.${process.pid}`;
writeFileSync(idxTmp, JSON.stringify(index, null, 2) + '\n');
renameSync(idxTmp, idxFile);

const tombFile = path.join(libRoot, 'library.deleted.json');
let gone = [];
try { const t = JSON.parse(readFileSync(tombFile, 'utf8')); if (Array.isArray(t)) gone = t.map(String); } catch {}
if (!gone.includes(id)) gone.push(id);
// Atomic write: tmp-file + renameSync, matching Task 3 idiom.
const tombTmp = `${tombFile}.tmp.${process.pid}`;
writeFileSync(tombTmp, JSON.stringify(gone) + '\n');
renameSync(tombTmp, tombFile);

console.log(recoveredFromPack
  ? `OK: ${id} removed from your library (recovered from library/${recoveredFromPack}; it had no library index entry).`
  : `OK: ${id} removed from your library.`);
