// tmp-dir.mjs: the one way a test asks for scratch space.
//
// Run: imported by every *.test.mjs that needs a directory. Pinned by
// tests/tmp-hygiene.test.mjs, which fails the suite if a test reaches for
// mkdtempSync itself again.
//
// WHY THIS EXISTS (2026-08-25, second time): the suite filled this box's root
// filesystem. /tmp held 70,581 entries across ~40 prefixes, every one of them a
// test that called `mkdtempSync(join(tmpdir(), '<prefix>-'))` and never removed
// it. Individually a few blocks; together ~3.4G of directory overhead and 95MB
// free on the root disk. The cockpit disk-guard reaper (second-brain 243fd103,
// daily, reaps scratch older than 2h) is the safety net, not the fix; the fix is
// that a healthy run now leaves the reaper nothing to find.
//
// Two properties do the work:
//   ONE ROOT PER TEST PROCESS. Every directory handed out is a child of a single
//   /tmp/aios-test-XXXXXX, so the worst case (`kill -9`, where no hook of any
//   kind runs) leaks ONE entry instead of one per test.
//   REMOVAL IN node:test's ROOT `after` HOOK, registered here at import time so
//   the test file cannot forget it. That hook fires when the file's tests
//   finish INCLUDING when they throw, which is exactly what a stray
//   `rmSync` at the end of a test body does not do, and what
//   `process.on('exit')` does not do on a killed run.
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

let root = null;

// A scratch directory for this test, removed when the file's tests finish.
// `prefix` is kept in the directory name so a leak (or a debugger) still says
// which test made it: /tmp/aios-test-a1b2c3/mcpc-d4e5f6.
export function tmpDir(prefix = 'scratch-') {
  if (root === null) root = mkdtempSync(join(tmpdir(), 'aios-test-'));
  return mkdtempSync(join(root, prefix));
}

// Tests legitimately chmod directories read-only (member-connect pins that a
// 0o500 .ssh dir cannot be cleaned), and a plain recursive rmSync cannot descend
// into one. Reopen the tree first rather than let cleanup fail the file it was
// meant to serve.
function reopen(p) {
  let s;
  try { s = statSync(p); } catch { return; }
  try { chmodSync(p, s.isDirectory() ? 0o700 : 0o600); } catch { /* best effort */ }
  if (!s.isDirectory()) return;
  for (const e of readdirSync(p)) reopen(join(p, e));
}

// Remove everything tmpDir() handed out. Idempotent, and never throws: a
// cleanup that fails a green test file would teach the next author to stop
// calling it.
export function cleanTmpDirs() {
  if (root === null) return;
  const dead = root;
  root = null;
  try {
    rmSync(dead, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    try { reopen(dead); rmSync(dead, { recursive: true, force: true, maxRetries: 3 }); } catch { /* the reaper's job now */ }
  }
}

after(cleanTmpDirs);
