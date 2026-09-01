#!/usr/bin/env node
// library-list.mjs <brain-root>: one JSON snapshot of the directories this
// box has installed, for the app's Files section (spec 2026-08-25 § 5.4).
//
// Read-only, same prefix-line idiom as skills-list.mjs and prompts-list.mjs.
// The index is the record; this never touches the trees it names, so a stale
// entry is reported as-is rather than quietly repaired. Repair is dir-remove's
// job, and it has the containment guard for it.
import path from 'node:path';
import { SAFE, readDirsIndex } from './library-path.mjs';

const brain = path.resolve(process.argv[2] || '/state');
const emit = (o) => { process.stdout.write(`LIBRARY_STATE ${JSON.stringify(o)}\n`); process.exit(0); };

// index.json is rock-influenced (spec § 5.3/5.4 threat model), so free-text
// fields get the same treatment phase 1 gave prompt titles: a hard length
// cap, and object/array values collapsed to empty rather than serialized via
// bare String() (which would ship the member "[object Object]").
const FIELD_CAP = 200;
const text = (v) => {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const s = String(v);
  return s.length > FIELD_CAP ? s.slice(0, FIELD_CAP) : s;
};

// readDirsIndex takes the index FILE path (not the brain root), matching the
// call convention already used by dir-install.mjs and dir-remove.mjs.
const libRoot = path.join(brain, 'library');
const idxFile = path.join(libRoot, 'index.json');
const loaded = readDirsIndex(idxFile);
if (!loaded.ok) emit({ dirs: [], error: 'the library index on this box could not be read' });

const dirs = [];
for (const d of (loaded.index.dirs || [])) {
  if (!d || typeof d !== 'object') continue;
  if (!SAFE.test(String(d.id || ''))) continue;
  if (!SAFE.test(String(d.pack || ''))) continue;
  dirs.push({
    id: String(d.id),
    pack: String(d.pack),
    rock: text(d.rock),
    installed: text(d.installed),
    kind: text(d.kind),
  });
}
dirs.sort((a, b) => a.pack.localeCompare(b.pack) || a.id.localeCompare(b.id));
emit({ dirs });
