// page-install.test.mjs: member pickup of ONE offered page (spec
// 2026-08-26-delivery-model § 5a). Modeled on dir-install.test.mjs.
//   node --test engine/appshell/page-install.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'page-install.mjs');

function box() {
  const root = tmpDir('pageinst-');
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
  const pageContent = (id) => { try { return readFileSync(join(state, 'dashboard', 'pages', `${id}.html`), 'utf8'); } catch { return null; } };
  const manifest = () => { try { return JSON.parse(readFileSync(join(state, 'dashboard', 'pages.json'), 'utf8')); } catch { return null; } };
  const tombstones = () => { try { return JSON.parse(readFileSync(join(state, 'dashboard', 'pages.deleted.json'), 'utf8')); } catch { return null; } };
  return { root, state, brain, w, run, pageContent, manifest, tombstones, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('installs from offers-pages/<id>.html, title from the sibling <id>.json, manifest carries from', () => {
  const b = box();
  b.w('state/org-inbox/offers-pages/hello-page.html', '<h1>Hello</h1>');
  b.w('state/org-inbox/offers-pages/hello-page.json', JSON.stringify({ title: 'Hello Page' }));
  b.w('state/org-inbox.conf', 'ORG_GH_OWNER=acme-gh\nSLUG=jane01\n');
  const r = b.run(['hello-page']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^OK: hello-page installed\.$/m);
  assert.equal(b.pageContent('hello-page'), '<h1>Hello</h1>');
  const entry = b.manifest().pages.find((p) => p.id === 'hello-page');
  assert.equal(entry.title, 'Hello Page');
  assert.equal(entry.from, 'acme-gh');
  b.done();
});

test('installs from the legacy pages/<pack>/<id>.html when that is where it lives', () => {
  const b = box();
  b.w('state/org-inbox/pages/starter-pack/welcome.html', '<h2>welcome</h2>');
  b.w('state/org-inbox.conf', 'ORG_GH_OWNER=acme-gh\nSLUG=jane01\n');
  const r = b.run(['welcome']);
  assert.equal(r.code, 0, r.out);
  assert.equal(b.pageContent('welcome'), '<h2>welcome</h2>');
  const entry = b.manifest().pages.find((p) => p.id === 'welcome');
  assert.equal(entry.title, 'welcome', 'no sibling json: title falls back to the id');
  b.done();
});

test('offers-pages is searched before the legacy pages path for the same id', () => {
  const b = box();
  b.w('state/org-inbox/offers-pages/dup.html', '<p>new path</p>');
  b.w('state/org-inbox/pages/pack/dup.html', '<p>legacy path</p>');
  const r = b.run(['dup']);
  assert.equal(r.code, 0, r.out);
  assert.equal(b.pageContent('dup'), '<p>new path</p>');
  b.done();
});

test('an id offered by nobody refuses with the not-offered sentence', () => {
  const b = box();
  const r = b.run(['ghost-page']);
  assert.equal(r.code, 1);
  assert.match(r.out, /not in your inbox/i);
  b.done();
});

test('anchor wins over a joined rock offering the same id', () => {
  const b = box();
  b.w('state/org-inbox/offers-pages/shared-id.html', '<p>anchor</p>');
  b.w('state/org-inbox.conf', 'ORG_GH_OWNER=acme-gh\nSLUG=jane01\n');
  b.w('state/org-inbox.d/tides/offers-pages/shared-id.html', '<p>tides</p>');
  const r = b.run(['shared-id']);
  assert.equal(r.code, 0, r.out);
  assert.equal(b.pageContent('shared-id'), '<p>anchor</p>');
  b.done();
});

test('two joined rocks offering one id is refused by name unless rock says which', () => {
  const b = box();
  b.w('state/org-inbox.d/tides/offers-pages/split.html', '<p>tides</p>');
  b.w('state/org-inbox.d/waves/offers-pages/split.html', '<p>waves</p>');
  let r = b.run(['split']);
  assert.equal(r.code, 1);
  assert.match(r.out, /more than one/i);
  assert.match(r.out, /tides/);
  assert.match(r.out, /waves/);
  r = b.run(['split', 'waves']);
  assert.equal(r.code, 0, r.out);
  assert.equal(b.pageContent('split'), '<p>waves</p>');
  const entry = b.manifest().pages.find((p) => p.id === 'split');
  assert.equal(entry.from, 'waves');
  b.done();
});

test('refuses a page that fails lintPage, naming the page, writing nothing', () => {
  const b = box();
  b.w('state/org-inbox/offers-pages/bad-page.html', '<script>fetch("/x")</script>');
  const r = b.run(['bad-page']);
  assert.equal(r.code, 1);
  assert.match(r.out, /^ERROR: /);
  assert.match(r.out, /bad-page/);
  assert.match(r.out, /will not work as written/);
  assert.equal(b.pageContent('bad-page'), null);
  assert.equal(b.manifest(), null);
  b.done();
});

test('refuses when the page is already installed (install-once): file AND manifest entry both present', () => {
  const b = box();
  b.w('state/org-inbox/offers-pages/again.html', '<p>fresh offer</p>');
  b.w('state/dashboard/pages/again.html', '<p>member content already here</p>');
  b.w('state/dashboard/pages.json', JSON.stringify({ pages: [{ id: 'again', title: 'Again' }] }));
  const r = b.run(['again']);
  assert.equal(r.code, 1);
  assert.match(r.out, /already installed/i);
  assert.equal(b.pageContent('again'), '<p>member content already here</p>', 'untouched');
  assert.deepEqual(b.manifest().pages, [{ id: 'again', title: 'Again' }], 'unchanged');
  b.done();
});

// The orphan case: the file already sits on the box (an earlier copy, or a
// file placed some other way) but never got a manifest entry, so the page
// never actually appeared in the member's nav. This used to refuse with
// "already installed" and leave the manifest empty - a false already-done,
// same shape as the M5 bug in seed-org-pages.mjs. Adoption: no file is
// touched, but the missing entry gets added, and exit is 0.
test('a file present with no manifest entry is adopted: entry added, exit 0, file untouched', () => {
  const b = box();
  b.w('state/org-inbox/offers-pages/orphan.html', '<p>offered version, never used</p>');
  b.w('state/dashboard/pages/orphan.html', '<p>member content already here</p>');
  const r = b.run(['orphan']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /already on your box/i);
  assert.match(r.out, /added to your pages/i);
  assert.doesNotMatch(r.out, /^OK: orphan installed\.$/m, 'must not claim a fresh install it did not do');
  assert.equal(b.pageContent('orphan'), '<p>member content already here</p>', 'the on-disk file is never overwritten, even when adopted');
  const entry = b.manifest().pages.find((p) => p.id === 'orphan');
  assert.ok(entry, 'the manifest entry was added');
  b.done();
});

// The mirror case: a manifest entry exists but the file itself is missing
// (e.g. deleted by hand outside the app). Not the case this fix targets,
// but the early guard must not mistake it for "already installed" either -
// it falls through to a normal install, which restores the file and leaves
// the existing entry alone.
test('a manifest entry present with no file installs the file and leaves the existing entry alone', () => {
  const b = box();
  b.w('state/org-inbox/offers-pages/tracked.html', '<p>fresh offer</p>');
  b.w('state/dashboard/pages.json', JSON.stringify({ pages: [{ id: 'tracked', title: 'Tracked' }] }));
  const r = b.run(['tracked']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^OK: tracked installed\.$/m);
  assert.equal(b.pageContent('tracked'), '<p>fresh offer</p>');
  assert.deepEqual(b.manifest().pages, [{ id: 'tracked', title: 'Tracked' }], 'the existing entry is left as it was, not duplicated');
  b.done();
});

test('neither file nor manifest entry present: a normal install, both happen', () => {
  const b = box();
  b.w('state/org-inbox/offers-pages/fresh.html', '<p>brand new</p>');
  const r = b.run(['fresh']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^OK: fresh installed\.$/m);
  assert.equal(b.pageContent('fresh'), '<p>brand new</p>');
  const entry = b.manifest().pages.find((p) => p.id === 'fresh');
  assert.ok(entry);
  b.done();
});

test('clears the tombstone on a successful explicit install (delete-then-reinstall is self-service)', () => {
  const b = box();
  b.w('state/org-inbox/offers-pages/reborn.html', '<p>back again</p>');
  b.w('state/dashboard/pages.deleted.json', JSON.stringify(['reborn', 'other-deleted']));
  const r = b.run(['reborn']);
  assert.equal(r.code, 0, r.out);
  assert.equal(b.pageContent('reborn'), '<p>back again</p>');
  assert.deepEqual(b.tombstones(), ['other-deleted']);
  b.done();
});

// Adoption is a different path through the same success branch (result.ok),
// so the tombstone-clearing step below it must fire the same way it does
// for a plain install - the file being adopted rather than copied changes
// nothing about whether this id was previously deleted.
test('clears the tombstone on adoption too (file present, no entry, tombstoned id)', () => {
  const b = box();
  b.w('state/org-inbox/offers-pages/reborn.html', '<p>offered version, never used</p>');
  b.w('state/dashboard/pages/reborn.html', '<p>member content already here</p>');
  b.w('state/dashboard/pages.deleted.json', JSON.stringify(['reborn', 'other-deleted']));
  const r = b.run(['reborn']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /already on your box/i);
  assert.equal(b.pageContent('reborn'), '<p>member content already here</p>', 'untouched by adoption');
  assert.deepEqual(b.tombstones(), ['other-deleted']);
  b.done();
});

test('a page with no tombstone entry at all installs cleanly (tombstone file absent)', () => {
  const b = box();
  b.w('state/org-inbox/offers-pages/plain.html', '<p>plain</p>');
  const r = b.run(['plain']);
  assert.equal(r.code, 0, r.out);
  assert.equal(b.tombstones(), null, 'no tombstone file was created where none existed');
  b.done();
});

test('a symlinked offer is refused and no outside content lands', () => {
  const b = box();
  const outside = tmpDir('outside-page-');
  writeFileSync(join(outside, 'secret.html'), '<p>SECRET</p>');
  mkdirSync(join(b.state, 'org-inbox', 'offers-pages'), { recursive: true });
  symlinkSync(join(outside, 'secret.html'), join(b.state, 'org-inbox', 'offers-pages', 'leaky.html'));
  const r = b.run(['leaky']);
  assert.equal(r.code, 1);
  assert.equal(b.pageContent('leaky'), null);
  rmSync(outside, { recursive: true, force: true });
  b.done();
});

test('a symlinked offers-pages directory itself is refused, falling through to a real legacy offer', () => {
  const b = box();
  const outside = tmpDir('outside-dir-page-');
  writeFileSync(join(outside, 'evil.html'), '<p>evil</p>');
  mkdirSync(join(b.state, 'org-inbox'), { recursive: true });
  symlinkSync(outside, join(b.state, 'org-inbox', 'offers-pages'));
  b.w('state/org-inbox/pages/pack/real-fallback.html', '<p>real</p>');
  // The symlinked offers-pages dir does not offer real-fallback (it is a
  // different name), so this only proves the symlinked dir itself is never
  // read as a directory of offers - findOffer must not throw or leak content.
  const r = b.run(['real-fallback']);
  assert.equal(r.code, 0, r.out);
  assert.equal(b.pageContent('real-fallback'), '<p>real</p>');
  rmSync(outside, { recursive: true, force: true });
  b.done();
});

test('an unsafe id is refused before any filesystem work', () => {
  const b = box();
  const r = b.run(['../escape']);
  assert.equal(r.code, 1);
  assert.equal(existsSync(join(b.state, 'dashboard')), false);
  assert.equal(existsSync(join(b.state, 'org-inbox')), false);
  b.done();
});

test('an unsafe rock argument is refused', () => {
  const b = box();
  b.w('state/org-inbox/offers-pages/x.html', '<p>x</p>');
  const r = b.run(['x', '../bad-rock']);
  assert.equal(r.code, 1);
  assert.match(r.out, /rock must be/i);
  b.done();
});
