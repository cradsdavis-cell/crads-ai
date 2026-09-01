// dir-remove.test.mjs: uninstall of a library directory (spec 2026-08-25 § 4).
//   node --test engine/appshell/dir-remove.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, symlinkSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'dir-remove.mjs');

function brainWith(entries) {
  const brain = tmpDir('dirrm-');
  mkdirSync(join(brain, 'library'), { recursive: true });
  writeFileSync(join(brain, 'library', 'index.json'), JSON.stringify({ dirs: entries }, null, 2));
  for (const e of entries) {
    const d = join(brain, 'library', e.pack, e.id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'f.md'), 'x');
  }
  return brain;
}
const run = (brain, id) => {
  try { return { code: 0, out: execFileSync('node', [CLI, brain, id], { encoding: 'utf8' }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
};

test('removes the tree, drops the index entry, tombstones the id', () => {
  const brain = brainWith([
    { id: 'tpl', pack: 'kit', rock: 'acme', installed: '2026-08-25' },
    { id: 'keep', pack: 'kit', rock: 'acme', installed: '2026-08-25' },
  ]);
  const r = run(brain, 'tpl');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /OK: tpl removed/);
  assert.ok(!existsSync(join(brain, 'library', 'kit', 'tpl')));
  assert.ok(existsSync(join(brain, 'library', 'kit', 'keep', 'f.md')), 'siblings untouched');
  const idx = JSON.parse(readFileSync(join(brain, 'library', 'index.json'), 'utf8'));
  assert.deepEqual(idx.dirs.map((d) => d.id), ['keep']);
  assert.deepEqual(JSON.parse(readFileSync(join(brain, 'library', 'library.deleted.json'), 'utf8')), ['tpl']);
  rmSync(brain, { recursive: true, force: true });
});

test('an id not in the index refuses and removes nothing', () => {
  const brain = brainWith([{ id: 'keep', pack: 'kit', rock: 'acme', installed: '2026-08-25' }]);
  const r = run(brain, 'ghost');
  assert.equal(r.code, 1);
  assert.match(r.out, /not installed/i);
  assert.ok(existsSync(join(brain, 'library', 'kit', 'keep', 'f.md')));
  rmSync(brain, { recursive: true, force: true });
});

test('an index entry with a traversal pack cannot reach outside library/', () => {
  const brain = brainWith([]);
  writeFileSync(join(brain, 'library', 'index.json'), JSON.stringify({ dirs: [{ id: 'x', pack: '../..', rock: 'a', installed: '2026-08-25' }] }));
  writeFileSync(join(brain, 'precious.md'), 'do not touch');
  const r = run(brain, 'x');
  assert.equal(r.code, 1);
  assert.ok(existsSync(join(brain, 'precious.md')));
  rmSync(brain, { recursive: true, force: true });
});

test('removing twice tombstones once', () => {
  const brain = brainWith([{ id: 'tpl', pack: 'kit', rock: 'acme', installed: '2026-08-25' }]);
  assert.equal(run(brain, 'tpl').code, 0);
  assert.equal(run(brain, 'tpl').code, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(brain, 'library', 'library.deleted.json'), 'utf8')), ['tpl']);
  rmSync(brain, { recursive: true, force: true });
});

test('after a successful remove, no stray .tmp.* file remains in library/', () => {
  const brain = brainWith([{ id: 'tpl', pack: 'kit', rock: 'acme', installed: '2026-08-25' }]);
  const r = run(brain, 'tpl');
  assert.equal(r.code, 0, r.out);
  const libDir = join(brain, 'library');
  const tmpFiles = readdirSync(libDir).filter((f) => f.startsWith('.tmp.') || f.match(/\.tmp\.\d+$/));
  assert.equal(tmpFiles.length, 0, `found stray tmp files: ${tmpFiles.join(', ')}`);
  rmSync(brain, { recursive: true, force: true });
});

test('F1: intermediate symlink containment (pack as symlink to outside dir)', () => {
  const brain = tmpDir('dirrm-');
  const outside = tmpDir('dirrm-outside-');
  const preciousFile = join(outside, 'precious.md');
  writeFileSync(preciousFile, 'do not touch');

  mkdirSync(join(brain, 'library'), { recursive: true });
  // Create library/<pack> as a symlink to an outside directory
  symlinkSync(outside, join(brain, 'library', 'kit'));
  writeFileSync(join(brain, 'library', 'index.json'), JSON.stringify({
    dirs: [{ id: 'tpl', pack: 'kit', rock: 'acme', installed: '2026-08-25' }],
  }, null, 2));

  const r = run(brain, 'tpl');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /points outside the library/i);
  // Verify the outside file still exists
  assert.ok(existsSync(preciousFile), 'outside file was protected');
  // Verify the symlink itself still exists
  assert.ok(existsSync(join(brain, 'library', 'kit')), 'symlink was not removed');

  rmSync(brain, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('final-component symlink works correctly (target is a symlink, not a dir)', () => {
  const brain = tmpDir('dirrm-');
  const outside = tmpDir('dirrm-outside-');
  const outsideTarget = join(outside, 'target-dir');
  mkdirSync(outsideTarget);
  const preciousFile = join(outsideTarget, 'precious.md');
  writeFileSync(preciousFile, 'keep this');

  mkdirSync(join(brain, 'library', 'kit'), { recursive: true });
  // Create library/kit/tpl as a symlink to the outside target
  symlinkSync(outsideTarget, join(brain, 'library', 'kit', 'tpl'));
  writeFileSync(join(brain, 'library', 'index.json'), JSON.stringify({
    dirs: [{ id: 'tpl', pack: 'kit', rock: 'acme', installed: '2026-08-25' }],
  }, null, 2));

  const r = run(brain, 'tpl');
  assert.equal(r.code, 0, r.out);
  // The symlink should be removed
  assert.ok(!existsSync(join(brain, 'library', 'kit', 'tpl')), 'symlink was removed');
  // But the target directory and its contents should survive
  assert.ok(existsSync(preciousFile), 'outside target was not removed');

  rmSync(brain, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('F2: rmSync failure surfaces cleanly without raw stack trace', { skip: process.getuid?.() === 0 ? 'skipped on root (chmod no-op)' : undefined }, () => {
  const brain = tmpDir('dirrm-');
  mkdirSync(join(brain, 'library'), { recursive: true });
  const packDir = join(brain, 'library', 'kit');
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, 'tpl'), 'x');
  writeFileSync(join(brain, 'library', 'index.json'), JSON.stringify({
    dirs: [{ id: 'tpl', pack: 'kit', rock: 'acme', installed: '2026-08-25' }],
  }, null, 2));

  // Make the pack directory unwritable to trigger EACCES during rmSync
  chmodSync(packDir, 0o555);

  const r = run(brain, 'tpl');
  assert.equal(r.code, 1, r.out);
  // Verify the error message is clean and contracted
  assert.match(r.out, /^ERROR: /m);
  // Should NOT contain raw stack frame markers (node stack traces have " at " at line start)
  assert.ok(!r.out.match(/^\s+at /m), `found stack frame in: ${r.out}`);
  // Should NOT contain absolute paths like /tmp
  assert.ok(!r.out.includes('/tmp'), `found absolute path in: ${r.out}`);

  // Restore permissions so cleanup can work
  chmodSync(packDir, 0o755);

  rmSync(brain, { recursive: true, force: true });
});

// --- Final-fix-wave tests (2026-08-25): F2 unparseable index refuses instead
// of resetting, F4 orphan recovery via a library/*/<id> scan. ---

test('F2: an unparseable library/index.json refuses cleanly instead of being silently reset', () => {
  const brain = tmpDir('dirrm-');
  mkdirSync(join(brain, 'library', 'kit', 'tpl'), { recursive: true });
  writeFileSync(join(brain, 'library', 'kit', 'tpl', 'f.md'), 'x');
  writeFileSync(join(brain, 'library', 'index.json'), '{not valid json');
  const r = run(brain, 'tpl');
  assert.equal(r.code, 1);
  assert.match(r.out, /^ERROR: /);
  assert.match(r.out, /damaged/i);
  assert.ok(existsSync(join(brain, 'library', 'kit', 'tpl', 'f.md')), 'nothing was removed');
  assert.equal(readFileSync(join(brain, 'library', 'index.json'), 'utf8'), '{not valid json', 'the damaged index was left untouched, not reset');
  rmSync(brain, { recursive: true, force: true });
});

test('F4: an id missing from the index but present in exactly one pack recovers, reporting which pack', () => {
  const brain = tmpDir('dirrm-');
  mkdirSync(join(brain, 'library', 'kit', 'tpl'), { recursive: true });
  writeFileSync(join(brain, 'library', 'kit', 'tpl', 'f.md'), 'orphaned');
  mkdirSync(join(brain, 'library'), { recursive: true });
  writeFileSync(join(brain, 'library', 'index.json'), JSON.stringify({ dirs: [] }));
  const r = run(brain, 'tpl');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /recovered from library\/kit/i);
  assert.ok(!existsSync(join(brain, 'library', 'kit', 'tpl')), 'the orphaned tree was removed');
  const idxAfter = JSON.parse(readFileSync(join(brain, 'library', 'index.json'), 'utf8'));
  assert.deepEqual(idxAfter.dirs, [], 'no phantom entry was added for the recovered id');
  assert.deepEqual(JSON.parse(readFileSync(join(brain, 'library', 'library.deleted.json'), 'utf8')), ['tpl']);
  rmSync(brain, { recursive: true, force: true });
});

test('F4: an id missing from the index but present in more than one pack refuses and names them', () => {
  const brain = tmpDir('dirrm-');
  mkdirSync(join(brain, 'library', 'kit', 'tpl'), { recursive: true });
  writeFileSync(join(brain, 'library', 'kit', 'tpl', 'f.md'), 'a');
  mkdirSync(join(brain, 'library', 'other', 'tpl'), { recursive: true });
  writeFileSync(join(brain, 'library', 'other', 'tpl', 'f.md'), 'b');
  writeFileSync(join(brain, 'library', 'index.json'), JSON.stringify({ dirs: [] }));
  const r = run(brain, 'tpl');
  assert.equal(r.code, 1);
  assert.match(r.out, /more than one/i);
  assert.match(r.out, /kit/);
  assert.match(r.out, /other/);
  assert.ok(existsSync(join(brain, 'library', 'kit', 'tpl', 'f.md')), 'neither copy was touched');
  assert.ok(existsSync(join(brain, 'library', 'other', 'tpl', 'f.md')), 'neither copy was touched');
  rmSync(brain, { recursive: true, force: true });
});
