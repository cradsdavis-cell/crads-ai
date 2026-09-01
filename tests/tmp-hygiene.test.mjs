// tmp-hygiene.test.mjs. Run: node --test tests/tmp-hygiene.test.mjs
//
// The pin for the 2026-08-25 incident (trap 63): the suite filled this box's
// root filesystem for the second time, because ~40 test prefixes each made a
// /tmp directory per test and none of them ever removed one. 70,581 entries,
// ~3.4G of directory blocks, 95MB free on /.
//
// The fix is tests/tmp-dir.mjs. This file is what stops the next author from
// quietly reintroducing the leak: a test that reaches for the raw call fails
// the suite, in the same run, with the reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { tmpDir, cleanTmpDirs } from './tmp-dir.mjs';

const REPO = dirname(import.meta.dirname);
// Composed rather than written, so this file can scan ITSELF like any other.
const RAW = 'mkdtemp' + 'Sync';
const MKD = 'mktemp' + ' -d';
const testFiles = execFileSync('git', ['ls-files', '*.test.mjs'], { cwd: REPO, encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);

test(`${RAW} appears in no test file: scratch space comes from tmpDir()`, () => {
  assert.ok(testFiles.length > 50, `expected the whole suite, got ${testFiles.length} files`);
  const offenders = testFiles.filter((f) => readFileSync(join(REPO, f), 'utf8').includes(RAW));
  assert.deepEqual(offenders, [], 'these tests make /tmp directories nobody removes. '
    + "Use tmpDir('<prefix>-') from tests/tmp-dir.mjs: it cleans up in an after hook, "
    + 'which fires even when the test throws.');
});

// The same leak wearing a shell: one bash fragment made its scratch directory
// with the shell verb instead, and left an 8MB clone of the test's own git remote
// in /tmp on every run of git.test.mjs. Plain `mktemp` (a FILE, and the fragments
// using it delete it) is left alone: those mirror production shell, and a file is
// not the directory-block problem this trap is about.
test(`no test shells out to ${MKD} either`, () => {
  const offenders = testFiles.filter((f) => readFileSync(join(REPO, f), 'utf8').includes(MKD));
  assert.deepEqual(offenders, [], 'a shell fragment leaks the same directories a raw '
    + `${RAW} does. Make the directory with tmpDir() and pass it into the fragment.`);
});

test('every scratch directory lives under ONE root per process', () => {
  const a = tmpDir('hygiene-a-');
  const b = tmpDir('hygiene-b-');
  assert.notEqual(a, b);
  assert.equal(dirname(a), dirname(b), 'one root, so a killed run leaks one entry, not one per test');
  assert.match(relative(tmpdir(), dirname(a)), /^aios-test-/);
  assert.match(a, /hygiene-a-/, 'the prefix survives, so a stray directory still names its test');
});

test('cleanup removes the root, including a directory the test locked down', () => {
  const d = tmpDir('hygiene-locked-');
  writeFileSync(join(d, 'f'), 'x');
  chmodSync(d, 0o500);   // member-connect pins a read-only .ssh dir; cleanup must still win
  const root = dirname(d);
  cleanTmpDirs();
  assert.equal(existsSync(root), false, 'the whole root goes, not just the removable parts');
});

test('cleanup is idempotent, and the next caller gets a fresh root', () => {
  const first = dirname(tmpDir('hygiene-round1-'));
  cleanTmpDirs();
  cleanTmpDirs();   // a second call must not throw: the after hook may follow an explicit one
  const second = dirname(tmpDir('hygiene-round2-'));
  assert.notEqual(second, first);
  assert.equal(existsSync(second), true);
});
