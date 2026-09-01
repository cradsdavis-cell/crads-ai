// dir-install.test.mjs: member pickup of a pack directory (spec 2026-08-25 § 5.3).
//   node --test engine/appshell/dir-install.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'dir-install.mjs');

function box() {
  const root = tmpDir('dirinst-');
  const state = join(root, 'state'), brain = join(root, 'brain');
  mkdirSync(state, { recursive: true }); mkdirSync(brain, { recursive: true });
  const w = (rel, body) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  const run = (args) => {
    try { return { code: 0, out: execFileSync('node', [CLI, state, brain, ...args], { encoding: 'utf8' }) }; }
    catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
  };
  return { root, state, brain, w, run, done: () => rmSync(root, { recursive: true, force: true }) };
}
const idx = (b) => JSON.parse(readFileSync(join(b.brain, 'library', 'index.json'), 'utf8'));

test('installs an anchor offer: tree copied, index written, kind read from the manifest', () => {
  const b = box();
  b.w('state/org-inbox/dirs/kit/coaching-templates/nested/deep.md', 'content');
  b.w('state/org-inbox/dirs/kit/coaching-templates.yaml', 'kind: templates\n');
  b.w('state/org-inbox.conf', 'ORG_GH_OWNER=acme-gh\nSLUG=jane01\n');
  const r = b.run(['coaching-templates']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /OK: coaching-templates installed to library\/kit\/coaching-templates\./);
  assert.equal(readFileSync(join(b.brain, 'library', 'kit', 'coaching-templates', 'nested', 'deep.md'), 'utf8'), 'content');
  const e = idx(b).dirs.find((d) => d.id === 'coaching-templates');
  assert.equal(e.pack, 'kit');
  assert.equal(e.kind, 'templates');
  assert.equal(e.rock, 'acme-gh');
  assert.match(e.installed, /^\d{4}-\d{2}-\d{2}$/);
  b.done();
});

test('install-once: an existing target refuses with remove-first, tree untouched', () => {
  const b = box();
  b.w('state/org-inbox/dirs/kit/tpl/a.md', 'new');
  b.w('brain/library/kit/tpl/a.md', 'mine, edited');
  const r = b.run(['tpl']);
  assert.equal(r.code, 1);
  assert.match(r.out, /already installed/i);
  assert.match(r.out, /remove/i);
  assert.equal(readFileSync(join(b.brain, 'library', 'kit', 'tpl', 'a.md'), 'utf8'), 'mine, edited');
  b.done();
});

test('an id offered by nobody refuses with the not-offered sentence', () => {
  const b = box();
  const r = b.run(['ghost']);
  assert.equal(r.code, 1);
  assert.match(r.out, /not in your inbox/i);
  b.done();
});

test('anchor wins over a joined rock offering the same id', () => {
  const b = box();
  b.w('state/org-inbox/dirs/kit/tpl/from-anchor.md', 'anchor');
  b.w('state/org-inbox.conf', 'ORG_GH_OWNER=acme-gh\nSLUG=jane01\n');
  b.w('state/org-inbox.d/tides/dirs/other/tpl/from-tides.md', 'tides');
  const r = b.run(['tpl']);
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(join(b.brain, 'library', 'kit', 'tpl', 'from-anchor.md')));
  assert.ok(!existsSync(join(b.brain, 'library', 'other', 'tpl', 'from-tides.md')));
  b.done();
});

test('two joined rocks offering one id is refused by name unless rock says which', () => {
  const b = box();
  b.w('state/org-inbox.d/tides/dirs/p1/tpl/a.md', 'tides');
  b.w('state/org-inbox.d/waves/dirs/p2/tpl/a.md', 'waves');
  let r = b.run(['tpl']);
  assert.equal(r.code, 1);
  assert.match(r.out, /more than one/i);
  assert.match(r.out, /tides/);
  assert.match(r.out, /waves/);
  r = b.run(['tpl', 'waves']);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(b.brain, 'library', 'p2', 'tpl', 'a.md'), 'utf8'), 'waves');
  assert.equal(idx(b).dirs[0].rock, 'waves');
  b.done();
});

test('a symlinked offer is refused, and outside content never lands', () => {
  const b = box();
  const outside = tmpDir('outside-');
  writeFileSync(join(outside, 'secret.md'), 'SECRET');
  mkdirSync(join(b.state, 'org-inbox', 'dirs', 'kit'), { recursive: true });
  symlinkSync(outside, join(b.state, 'org-inbox', 'dirs', 'kit', 'tpl'));
  const r = b.run(['tpl']);
  assert.equal(r.code, 1);
  assert.ok(!existsSync(join(b.brain, 'library', 'kit', 'tpl')));
  rmSync(outside, { recursive: true, force: true });
  b.done();
});

test('a symlink INSIDE an offered tree is skipped while real files copy', () => {
  const b = box();
  const outside = tmpDir('outside2-');
  writeFileSync(join(outside, 'secret.md'), 'SECRET');
  b.w('state/org-inbox/dirs/kit/tpl/real.md', 'real');
  symlinkSync(join(outside, 'secret.md'), join(b.state, 'org-inbox', 'dirs', 'kit', 'tpl', 'leak.md'));
  const r = b.run(['tpl']);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(b.brain, 'library', 'kit', 'tpl', 'real.md'), 'utf8'), 'real');
  assert.ok(!existsSync(join(b.brain, 'library', 'kit', 'tpl', 'leak.md')), 'the symlink did not ride the copy');
  rmSync(outside, { recursive: true, force: true });
  b.done();
});

test('a symlinked directory nested inside an offered tree is not descended into', () => {
  // Handoff finding (task 2 review): confirm cpSync's filter blocks an
  // intermediate directory symlink, not just a symlinked leaf file or a
  // symlinked offer root. lstatSync on a directory entry returns
  // isSymbolicLink() true, so the filter returns false and cpSync skips the
  // whole subtree rather than descending into it.
  const b = box();
  const outside = tmpDir('outside3-');
  writeFileSync(join(outside, 'secret.md'), 'SECRET');
  b.w('state/org-inbox/dirs/kit/tpl/real.md', 'real');
  symlinkSync(outside, join(b.state, 'org-inbox', 'dirs', 'kit', 'tpl', 'linked-subdir'));
  const r = b.run(['tpl']);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(b.brain, 'library', 'kit', 'tpl', 'real.md'), 'utf8'), 'real');
  assert.ok(!existsSync(join(b.brain, 'library', 'kit', 'tpl', 'linked-subdir')), 'the symlinked directory was not copied');
  assert.ok(!existsSync(join(b.brain, 'library', 'kit', 'tpl', 'linked-subdir', 'secret.md')), 'nothing beneath the symlinked directory rode the copy');
  rmSync(outside, { recursive: true, force: true });
  b.done();
});

test('an unsafe id is refused before any filesystem work', () => {
  const b = box();
  const r = b.run(['../escape']);
  assert.equal(r.code, 1);
  assert.ok(!existsSync(join(b.brain, 'library')));
  b.done();
});

test('installing clears a tombstone left by an earlier remove', () => {
  const b = box();
  b.w('state/org-inbox/dirs/kit/tpl/a.md', 'x');
  b.w('brain/library/library.deleted.json', '["tpl","other"]');
  const r = b.run(['tpl']);
  assert.equal(r.code, 0, r.out);
  const gone = JSON.parse(readFileSync(join(b.brain, 'library', 'library.deleted.json'), 'utf8'));
  assert.deepEqual(gone, ['other']);
  b.done();
});

test('a second install of a different dir appends to the index, never clobbers it', () => {
  const b = box();
  b.w('state/org-inbox/dirs/kit/one/a.md', '1');
  b.w('state/org-inbox/dirs/kit/two/b.md', '2');
  assert.equal(b.run(['one']).code, 0);
  assert.equal(b.run(['two']).code, 0);
  assert.deepEqual(idx(b).dirs.map((d) => d.id).sort(), ['one', 'two']);
  b.done();
});

// --- Fix-report tests (coordinator review, 2026-08-25): F1 copy-failure
// recovery + postcondition, F2 atomic index/tombstone writes. ---

test('a refused install leaves no partial dest, and the id can still be installed once the offer is fixed', () => {
  // Recovery-contract test per the review: prove a member is never
  // permanently stuck on an id that once failed. Uses the deterministic
  // symlinked-offer-root refusal (findOffer never finds it, so cpSync never
  // runs and there is nothing to clean up) to establish "refused, no
  // partial", then swaps in a real offer for the same id and confirms
  // install proceeds normally.
  const b = box();
  const outside = tmpDir('outside-recover-');
  writeFileSync(join(outside, 'secret.md'), 'SECRET');
  mkdirSync(join(b.state, 'org-inbox', 'dirs', 'kit'), { recursive: true });
  const offerPath = join(b.state, 'org-inbox', 'dirs', 'kit', 'tpl');
  symlinkSync(outside, offerPath);
  let r = b.run(['tpl']);
  assert.equal(r.code, 1);
  assert.ok(!existsSync(join(b.brain, 'library', 'kit', 'tpl')), 'no partial dest after the refusal');
  assert.ok(!existsSync(join(b.brain, 'library', 'index.json')), 'no index written for a refused install');

  rmSync(offerPath); // remove the symlink itself, not its target
  b.w('state/org-inbox/dirs/kit/tpl/a.md', 'fixed offer');
  r = b.run(['tpl']);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(b.brain, 'library', 'kit', 'tpl', 'a.md'), 'utf8'), 'fixed offer');
  assert.ok(idx(b).dirs.find((d) => d.id === 'tpl'));
  rmSync(outside, { recursive: true, force: true });
  b.done();
});

test('a copy failure mid-tree cleans up the partial, refuses with the contracted sentence, and writes no index entry', async () => {
  // False-OK / mid-copy-failure postcondition test. A real TOCTOU race
  // (org-sync racing the click) is not deterministically constructible from
  // outside the CLI's single synchronous run, so this constructs an
  // equally genuine, fully deterministic cpSync failure instead: a Unix
  // domain socket file inside the offered tree. lstatSync succeeds on it
  // (so dir-install's symlink filter does not skip it) but cpSync cannot
  // copy a non-regular file and throws synchronously partway through the
  // walk, after some sibling files have already landed, exactly matching
  // the "vanishes mid-copy" failure shape the fix guards against. No
  // external binary (e.g. mkfifo) needed: node:net creates the socket file.
  const b = box();
  b.w('state/org-inbox/dirs/kit/tpl/real.md', 'real');
  const sockPath = join(b.state, 'org-inbox', 'dirs', 'kit', 'tpl', 'asocket');
  const srv = net.createServer();
  await new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(sockPath, resolve);
  });
  try {
    const r = b.run(['tpl']);
    assert.equal(r.code, 1);
    assert.match(r.out, new RegExp('ERROR: the offer changed while it was being copied'));
    assert.ok(!/at Object|at Module|ERR_INTERNAL_ASSERTION/.test(r.out), 'no raw Node error text reached the member');
    assert.ok(!existsSync(join(b.brain, 'library', 'kit', 'tpl')), 'the partial dest was cleaned up, not left behind');
    assert.ok(!existsSync(join(b.brain, 'library', 'index.json')), 'no index entry for a failed copy');
  } finally {
    srv.close();
  }
  b.done();
});

test('the index is written via tmp-file plus rename: no stray tmp file, valid JSON', () => {
  const b = box();
  b.w('state/org-inbox/dirs/kit/tpl/a.md', 'x');
  const r = b.run(['tpl']);
  assert.equal(r.code, 0, r.out);
  const libFiles = readdirSync(join(b.brain, 'library'));
  assert.ok(!libFiles.some((f) => f.includes('.tmp.')), `no stray tmp file beside index.json: ${libFiles.join(',')}`);
  assert.deepEqual(idx(b).dirs.map((d) => d.id), ['tpl']);
  b.done();
});

// --- Final-fix-wave tests (2026-08-25): F1 install-once keyed to the id,
// F2 unparseable index refuses instead of resetting, F3 destination
// containment, F6 kind-manifest regex widened. ---

test('F1: install-once is keyed to the id, not the destination path (a pack rename does not orphan the first install)', () => {
  // Reproduces the review finding directly: a rock renames a pack (same id,
  // new pack folder) and a second install must not go through just because
  // the new destination path happens to be free.
  const b = box();
  b.w('state/org-inbox/dirs/kit/tpl/a.md', 'first');
  const r1 = b.run(['tpl']);
  assert.equal(r1.code, 0, r1.out);
  rmSync(join(b.root, 'state', 'org-inbox', 'dirs', 'kit'), { recursive: true, force: true });
  b.w('state/org-inbox/dirs/renamed/tpl/a.md', 'second');
  const r2 = b.run(['tpl']);
  assert.equal(r2.code, 1);
  assert.match(r2.out, /already installed at library\/kit\/tpl/);
  assert.ok(!existsSync(join(b.brain, 'library', 'renamed', 'tpl')), 'the second pack never got written');
  assert.equal(readFileSync(join(b.brain, 'library', 'kit', 'tpl', 'a.md'), 'utf8'), 'first', 'the original tree is untouched');
  assert.equal(idx(b).dirs.length, 1, 'the index still has exactly one entry for tpl, not a replaced one');
  b.done();
});

test('F2: an unparseable library/index.json refuses cleanly instead of being silently reset', () => {
  const b = box();
  b.w('state/org-inbox/dirs/kit/tpl/a.md', 'x');
  b.w('brain/library/index.json', '{not valid json');
  const r = b.run(['tpl']);
  assert.equal(r.code, 1);
  assert.match(r.out, /^ERROR: /);
  assert.match(r.out, /damaged/i);
  assert.ok(!existsSync(join(b.brain, 'library', 'kit', 'tpl')), 'nothing was installed');
  assert.equal(readFileSync(join(b.brain, 'library', 'index.json'), 'utf8'), '{not valid json', 'the damaged index was left untouched, not reset to {dirs:[]}');
  b.done();
});

test('F3: a destination pack that is a symlink to outside the library refuses before anything is copied', () => {
  const b = box();
  const outside = tmpDir('outside-dest-');
  b.w('state/org-inbox/dirs/kit/tpl/a.md', 'content');
  mkdirSync(join(b.brain, 'library'), { recursive: true });
  symlinkSync(outside, join(b.brain, 'library', 'kit'));
  const r = b.run(['tpl']);
  assert.equal(r.code, 1);
  assert.match(r.out, /points outside the library/i);
  assert.ok(!existsSync(join(outside, 'tpl')), 'nothing was written outside the brain');
  rmSync(outside, { recursive: true, force: true });
  b.done();
});

test('F6: kind manifest accepts single quotes and digits, not just double quotes and letters', () => {
  const b = box();
  b.w('state/org-inbox/dirs/kit/tpl/a.md', 'x');
  b.w('state/org-inbox/dirs/kit/tpl.yaml', "kind: 'v2-templates'\n");
  const r = b.run(['tpl']);
  assert.equal(r.code, 0, r.out);
  assert.equal(idx(b).dirs.find((d) => d.id === 'tpl').kind, 'v2-templates');
  b.done();
});
