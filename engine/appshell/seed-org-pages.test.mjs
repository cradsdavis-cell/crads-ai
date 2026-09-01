// seed-org-pages.test.mjs: the org-inbox page seeder, behaviour then gate
// (spec 2026-08-25 § 5.1), updated for the retired-leg split (delivery-model
// step 2026-08-26-delivery-model step 7c, Part B). Extracted verbatim from
// the inline `node -e` that used to live inside seed_pages() in
// engine/box/org-sync.sh; every test below is derived from reading that
// script, not from a summary of it. Tests marked "step 7c" below replace
// tests that pinned the auto-arrival behaviour this step retires (a brand
// new id used to get a file and a manifest entry from this leg; now it never
// does, and is left for the member to pick up deliberately instead).
//   node --test engine/appshell/seed-org-pages.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'seed-org-pages.mjs');

// Fixture: <root>/inbox/pages/<pack>/<id>.html (the "src" argument) and
// <root>/box/dashboard/ (the "dash" argument, under the "box" argument that
// holds ownership.json). Mirrors the five CLI args in the exact order
// org-sync.sh passes them: src dash ghOwner box fromOverride.
function fixture() {
  const root = tmpDir('seedorgpages-');
  const src = join(root, 'inbox', 'pages');
  const box = join(root, 'box');
  const dash = join(box, 'dashboard');
  mkdirSync(src, { recursive: true });
  mkdirSync(dash, { recursive: true });

  const writePage = (pack, id, html, json) => {
    const pd = join(src, pack);
    mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, `${id}.html`), html);
    if (json !== undefined) writeFileSync(join(pd, `${id}.json`), JSON.stringify(json));
  };
  const writeDashFile = (rel, body) => {
    const p = join(dash, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  const writeOwnership = (obj) => writeFileSync(join(box, 'ownership.json'), JSON.stringify(obj));
  // Step 7c: repair mode gates on the id already being in dashboard/pages.json,
  // so most tests below need to seed that manifest state up front rather than
  // let this file create it.
  const writeManifestEntries = (entries) => writeDashFile('pages.json', JSON.stringify({ pages: entries }));
  const run = (ghOwner = '', fromOverride = '') => {
    try { return { code: 0, out: execFileSync('node', [CLI, src, dash, ghOwner, box, fromOverride], { encoding: 'utf8' }) }; }
    catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
  };
  const manifest = () => { try { return JSON.parse(readFileSync(join(dash, 'pages.json'), 'utf8')); } catch { return null; } };
  const manifestExists = () => existsSync(join(dash, 'pages.json'));
  const pageContent = (id) => { try { return readFileSync(join(dash, 'pages', `${id}.html`), 'utf8'); } catch { return null; } };
  const pageExists = (id) => existsSync(join(dash, 'pages', `${id}.html`));
  const done = () => rmSync(root, { recursive: true, force: true });
  return {
    root, src, box, dash, writePage, writeDashFile, writeOwnership, writeManifestEntries,
    run, manifest, manifestExists, pageContent, pageExists, done,
  };
}

test('reads <inbox>/pages/<pack>/<id>.html, one level of pack directories', () => {
  const b = fixture();
  b.writePage('pack-a', 'hello', '<h2>hi</h2>');
  b.writePage('pack-b', 'world', '<h2>bye</h2>');
  // Both ids already carry a manifest entry, so this is the repair path: the
  // point of this test is the traversal behaviour below, not the has-entry
  // gate itself (that has its own tests further down).
  b.writeManifestEntries([{ id: 'hello', title: 'hello' }, { id: 'world', title: 'world' }]);
  // A stray file directly under the pages root (not a pack directory) must
  // not crash the statSync(pd).isDirectory() check.
  writeFileSync(join(b.src, 'not-a-pack.txt'), 'stray');
  // Anything nested deeper than one pack level is invisible: readdirSync(pd)
  // only sees entries ending in .html, and a subdirectory name never does.
  mkdirSync(join(b.src, 'pack-a', 'nested'), { recursive: true });
  writeFileSync(join(b.src, 'pack-a', 'nested', 'deep.html'), '<p>too deep</p>');

  const r = b.run('acme-gh');
  assert.equal(r.code, 0, r.out);
  assert.equal(b.pageContent('hello'), '<h2>hi</h2>');
  assert.equal(b.pageContent('world'), '<h2>bye</h2>');
  assert.equal(b.pageExists('deep'), false, 'nested-beyond-one-level pages are never seen');
  b.done();
});

test('id must match ^[a-z0-9][a-z0-9._-]{0,80}$', () => {
  const b = fixture();
  b.writePage('pack', 'Uppercase', '<p>x</p>');
  b.writePage('pack', '-leading-dash', '<p>x</p>');
  b.writePage('pack', 'has space', '<p>x</p>'); // filename itself would break; use underscore variant instead
  b.writePage('pack', 'valid.id_ok-2', '<p>ok</p>');
  // Only the one valid id can ever reach the has-entry gate; the others are
  // filtered out by the id regex first, so they need no manifest entry.
  b.writeManifestEntries([{ id: 'valid.id_ok-2', title: 'valid.id_ok-2' }]);

  const r = b.run('acme-gh');
  assert.equal(r.code, 0, r.out);
  assert.equal(b.pageExists('Uppercase'), false);
  assert.equal(b.pageExists('-leading-dash'), false);
  assert.equal(b.pageExists('valid.id_ok-2'), true, 'dots, underscores and dashes are allowed mid-id');
  const ids = b.manifest().pages.map((p) => p.id);
  assert.ok(!ids.includes('Uppercase'));
  assert.ok(!ids.includes('-leading-dash'));
  assert.ok(ids.includes('valid.id_ok-2'));
  b.done();
});

test('a page whose id is tombstoned in pages.deleted.json is never re-copied, and gets no manifest entry', () => {
  const b = fixture();
  b.writePage('pack', 'gone-page', '<p>should not land</p>');
  b.writeDashFile('pages.deleted.json', JSON.stringify(['gone-page']));

  const r = b.run('acme-gh');
  assert.equal(r.code, 0, r.out);
  assert.equal(b.pageExists('gone-page'), false);
  const m = b.manifest();
  // added stayed 0 (the only page in this run was tombstoned), so the
  // manifest is never written at all.
  assert.equal(m, null);
  b.done();
});

test('a tombstoned id is refused even when it already carries a manifest entry: the tombstone check runs before the has-entry gate', () => {
  const b = fixture();
  b.writePage('pack', 'gone-page', '<p>should not land</p>');
  b.writeDashFile('pages.deleted.json', JSON.stringify(['gone-page']));
  b.writeManifestEntries([{ id: 'gone-page', title: 'Gone page' }]);

  const r = b.run('acme-gh');
  assert.equal(r.code, 0, r.out);
  assert.equal(b.pageExists('gone-page'), false, 'the tombstone wins even for an id that already has an entry');
  b.done();
});

test('a file already at dashboard/pages/<id>.html is never overwritten', () => {
  const b = fixture();
  b.writePage('pack', 'existing', '<p>new content from the inbox</p>');
  b.writeDashFile('pages/existing.html', '<p>member-edited content</p>');
  // Give it a manifest entry too so this run has nothing else to do for it.
  b.writeDashFile('pages.json', JSON.stringify({ pages: [{ id: 'existing', title: 'Existing' }] }));

  const r = b.run('acme-gh');
  assert.equal(r.code, 0, r.out);
  assert.equal(b.pageContent('existing'), '<p>member-edited content</p>');
  b.done();
});

test('a manifest entry already present is never touched', () => {
  const b = fixture();
  // The page file is missing on disk (so it WILL be copied, added++), but a
  // manifest entry for it already exists with a member-set title.
  b.writePage('pack', 'has-entry', '<p>content</p>', { title: 'Inbox title' });
  b.writeDashFile('pages.json', JSON.stringify({ pages: [{ id: 'has-entry', title: 'Member kept this title', from: 'someone-else' }] }));

  const r = b.run('acme-gh');
  assert.equal(r.code, 0, r.out);
  assert.equal(b.pageContent('has-entry'), '<p>content</p>', 'the file still gets copied since it was missing');
  const entry = b.manifest().pages.find((p) => p.id === 'has-entry');
  assert.deepEqual(entry, { id: 'has-entry', title: 'Member kept this title', from: 'someone-else' });
  b.done();
});

test('two ids that each already have a manifest entry are both repaired in the same run', () => {
  const b = fixture();
  b.writeManifestEntries([{ id: 'already-there', title: 'Already there' }, { id: 'brand-new', title: 'Brand new' }]);
  b.writeDashFile('pages/already-there.html', '<p>member placed this directly</p>');
  b.writePage('pack', 'already-there', '<p>inbox version, never used</p>');
  b.writePage('pack', 'brand-new', '<p>fresh</p>');

  const r = b.run('acme-gh');
  assert.equal(r.code, 0, r.out);
  assert.equal(b.pageContent('already-there'), '<p>member placed this directly</p>', 'existing file stays untouched');
  assert.equal(b.pageContent('brand-new'), '<p>fresh</p>', 'missing file is recreated');
  const ids = b.manifest().pages.map((p) => p.id).sort();
  assert.deepEqual(ids, ['already-there', 'brand-new']);
  b.done();
});

// --- Step 7c: the has-entry / has-none split --------------------------------

test('an id not yet in the manifest is left alone: no file is written and no manifest entry is created', () => {
  const b = fixture();
  b.writePage('pack', 'brand-new', '<h2>hi</h2>', { title: 'A Nice Title' });

  const r = b.run('acme-gh');
  assert.equal(r.code, 0, r.out);
  assert.equal(b.pageExists('brand-new'), false);
  assert.equal(b.manifestExists(), false);
  b.done();
});

test('ownership.json anchor, gh-owner and the fromOverride argument no longer create a manifest entry for a new id', () => {
  const b = fixture();
  b.writePage('pack', 'p1', '<p>x</p>');
  b.writeOwnership({ anchor: 'acme-org' });

  const r = b.run('inbox-gh-owner', 'joined-rock-handle');
  assert.equal(r.code, 0, r.out);
  assert.equal(b.pageExists('p1'), false);
  assert.equal(b.manifestExists(), false, 'no entry is created regardless of what from-resolution would once have supplied');
  b.done();
});

// M5 (fix wave, 2026-08-25) taught this file to give an on-disk-but-manifestless
// page its manifest entry even when nothing was copied that run. Step 7c
// retires that: an id with no manifest entry is left alone, full stop,
// whether or not its file already happens to be sitting on disk (an operator,
// or a pre-migration copy, could have put it there). The M5 invariant itself
// still lives at install-page.test.mjs, unaffected: it is installPage's own
// contract, and page-install.mjs's explicit path still exercises it.
test('an id with no manifest entry stays without one even when its file already sits on disk (M5 behaviour retired here, step 7c)', () => {
  const b = fixture();
  b.writeDashFile('pages/already-there.html', '<p>member placed this directly</p>');
  b.writePage('pack', 'already-there', '<p>inbox version, never used</p>');

  const r = b.run('acme-gh');
  assert.equal(r.code, 0, r.out);
  assert.equal(b.manifestExists(), false, 'no manifest entry is created for an id this leg has no record of');
  assert.equal(b.pageContent('already-there'), '<p>member placed this directly</p>', 'the file itself is, as ever, never touched');
  b.done();
});

test('a broken sibling with no manifest entry of its own is left alone too, and is never even lint-checked (step 7c)', () => {
  const b = fixture();
  b.writeDashFile('pages/a.html', '<p>member content for a</p>');
  b.writePage('pack', 'a', '<p>inbox version of a, never used</p>');
  b.writePage('pack', 'b', '<script>fetch("/x")</script>'); // would fail lint, but this id is never reached

  const r = b.run('acme-gh');
  assert.equal(r.code, 0, r.out);
  assert.equal(b.pageExists('b'), false);
  assert.equal(b.manifestExists(), false, 'neither id has a manifest entry, so neither is touched');
  assert.doesNotMatch(r.out, /will not work as written/, 'b is left for pickup, not lint-checked and reported');
  assert.equal(b.pageContent('a'), '<p>member content for a</p>', 'the existing file is, as ever, never touched');
  b.done();
});

// --- Not in the brief's summary, found by reading the inline script -------
test('(found reading the source, not in the brief) a manifest.json that fails to parse is treated as empty, not fatal', () => {
  const b = fixture();
  b.writePage('pack', 'p1', '<p>x</p>');
  b.writeDashFile('pages.json', '{ not valid json');

  const r = b.run('acme-gh');
  assert.equal(r.code, 0, r.out, 'a broken manifest.json must not crash the run');
  // A broken manifest cannot tell this leg that p1 has an entry, so under the
  // step 7c split p1 reads as has-none: left alone, the same as any id this
  // leg has no record of. The unparseable file itself is never rewritten
  // either, since the has-none branch never touches the manifest.
  assert.equal(b.pageExists('p1'), false);
  assert.equal(readFileSync(join(b.dash, 'pages.json'), 'utf8'), '{ not valid json');
  b.done();
});

test('(found reading the source, not in the brief) a pages.deleted.json that is not an array is treated as no tombstones', () => {
  const b = fixture();
  b.writePage('pack', 'p1', '<p>x</p>');
  b.writeDashFile('pages.deleted.json', JSON.stringify({ not: 'an array' }));
  b.writeManifestEntries([{ id: 'p1', title: 'p1' }]);

  const r = b.run('acme-gh');
  assert.equal(r.code, 0, r.out);
  assert.equal(b.pageExists('p1'), true, 'not tombstoned, and p1 already has an entry, so it is repaired');
  b.done();
});

// --- Step 5 (retained): the lint gate, now exercised on the repair path ----
test('a page that fails the lint is not copied, and its skip is reported', () => {
  const b = fixture();
  b.writePage('pack', 'bad-page', '<script>fetch("/x")</script>');
  b.writeManifestEntries([{ id: 'bad-page', title: 'Bad page' }]);

  const r = b.run('acme-gh');
  assert.equal(r.code, 0, r.out, 'a lint failure never aborts the seeder');
  assert.equal(b.pageExists('bad-page'), false);
  assert.match(r.out, /bad-page/);
  assert.match(r.out, /will not work as written/);
  b.done();
});

test('a clean page in the same pack still lands next to a page that fails the lint', () => {
  const b = fixture();
  b.writePage('pack', 'bad-page', '<script>fetch("/x")</script>');
  b.writePage('pack', 'good-page', '<h2>fine</h2>');
  b.writeManifestEntries([{ id: 'bad-page', title: 'Bad page' }, { id: 'good-page', title: 'Good page' }]);

  const r = b.run('acme-gh');
  assert.equal(r.code, 0, r.out);
  assert.equal(b.pageExists('bad-page'), false);
  assert.equal(b.pageExists('good-page'), true);
  b.done();
});
