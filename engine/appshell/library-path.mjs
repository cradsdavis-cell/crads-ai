// library-path.mjs: shared library/ path-safety + index-read helpers for
// dir-install.mjs and dir-remove.mjs (spec 2026-08-25 §§ 4, 5.3). One id
// format, one containment guard, one index-parse contract: both scripts must
// refuse an escaping path, and an unparseable index, exactly the same way,
// so the check lives here once instead of drifting between two copies.
import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';

// kebab-case id validator. Reused for dir ids AND for pack segment names
// (whether read from the index or discovered by scanning an inbox or
// library/), since both are the same shape and both are attacker-controlled
// in the rock-authored-inbox threat model.
export const SAFE = /^[a-z0-9][a-z0-9-]{0,62}$/;

// True iff `target` resolves inside `libRoot` AND no path segment between
// libRoot and target's parent is a symlink. path.resolve() alone is not
// enough: if an intermediate segment (e.g. library/<pack>) is itself a
// symlink to somewhere outside libRoot, the resolved string can still look
// contained right up until the OS walks the symlink for real. The final
// segment (the id itself) being a symlink is fine: dir-remove unlinks it
// without following it, and dir-install simply must not create through one.
export function isContained(libRoot, target) {
  const base = path.resolve(libRoot);
  const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return false;
  const rel = resolved.slice(base.length + 1);
  if (!rel) return true;
  const segments = rel.split(path.sep);
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (!segment) continue;
    const segmentPath = path.join(base, ...segments.slice(0, i + 1));
    try {
      const st = lstatSync(segmentPath);
      if (st.isSymbolicLink()) return false;
    } catch {
      // ENOENT or other errors: treat as OK for now, the caller's own fs
      // call (cpSync / rmSync) fails on it if it truly is not there.
    }
  }
  return true;
}

// Reads library/index.json and distinguishes ABSENT (no file yet: normal
// first install, start empty) from PRESENT-BUT-UNPARSEABLE (file exists but
// is not valid JSON, or does not have a `dirs` array). Returns
// { ok: true, index } for the first two cases (empty index counts as ok),
// { ok: false } for the third. A caller must refuse on ok:false rather than
// silently resetting to an empty index, or every previously installed dir
// still on disk becomes untracked and effectively orphaned (F2).
export function readDirsIndex(idxFile) {
  let raw;
  try {
    raw = readFileSync(idxFile, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, index: { dirs: [] } };
    return { ok: false };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ok: false }; }
  if (parsed && Array.isArray(parsed.dirs)) return { ok: true, index: parsed };
  return { ok: false };
}
