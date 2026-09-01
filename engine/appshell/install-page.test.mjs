// install-page.test.mjs: the shared page-pickup routine, extracted from
// seed-org-pages.mjs so the legacy auto-seeder and the new explicit member
// install verb (page-install.mjs) share ONE implementation (spec
// 2026-08-26-delivery-model § 5a).
//   node --test engine/appshell/install-page.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { installPage } from './install-page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function box() {
  const root = tmpDir('installpage-');
  const dash = join(root, 'dashboard');
  mkdirSync(dash, { recursive: true });
  const src = (name, body) => { const p = join(root, name); writeFileSync(p, body); return p; };
  const pageContent = (id) => { try { return readFileSync(join(dash, 'pages', `${id}.html`), 'utf8'); } catch { return null; } };
  const manifest = () => { try { return JSON.parse(readFileSync(join(dash, 'pages.json'), 'utf8')); } catch { return null; } };
  const writeDashFile = (rel, body) => { const p = join(dash, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
  return { root, dash, src, pageContent, manifest, writeDashFile };
}

// --- The extraction itself: proof the seeder shares this, not a copy -------

test('seed-org-pages.mjs imports installPage rather than duplicating the copy/manifest logic', () => {
  const seederSrc = readFileSync(join(HERE, 'seed-org-pages.mjs'), 'utf8');
  assert.match(seederSrc, /import\s*\{\s*installPage\s*\}\s*from\s*['"]\.\/install-page\.mjs['"]/,
    'the seeder must import installPage from the shared module');
  assert.ok(!seederSrc.includes('copyFileSync'), 'the seeder no longer calls copyFileSync itself');
  assert.ok(!seederSrc.includes('lintPage'), 'the seeder no longer calls lintPage itself - that lives in install-page.mjs now');
});

test('page-install.mjs also imports installPage from the same shared module', () => {
  const cliSrc = readFileSync(join(HERE, 'page-install.mjs'), 'utf8');
  assert.match(cliSrc, /import\s*\{\s*installPage\s*\}\s*from\s*['"]\.\/install-page\.mjs['"]/);
});

// --- The routine's own contract ---------------------------------------------

test('a missing page is copied and gets a manifest entry with the given title and from', () => {
  const b = box();
  const html = b.src('offer.html', '<h2>hi</h2>');
  const r = installPage(html, b.dash, 'hello', { from: 'acme', titleJson: JSON.stringify({ title: 'Hello there' }) });
  assert.deepEqual(r, { ok: true, copied: true, manifestChanged: true });
  assert.equal(b.pageContent('hello'), '<h2>hi</h2>');
  assert.deepEqual(b.manifest().pages, [{ id: 'hello', title: 'Hello there', from: 'acme' }]);
});

test('an existing file at dashboard/pages/<id>.html is never overwritten, and copied is false', () => {
  const b = box();
  b.writeDashFile('pages/existing.html', '<p>member content</p>');
  const html = b.src('offer.html', '<p>inbox content, never used</p>');
  const r = installPage(html, b.dash, 'existing', {});
  assert.equal(r.ok, true);
  assert.equal(r.copied, false);
  assert.equal(b.pageContent('existing'), '<p>member content</p>');
});

test('a source that fails page-lint refuses without copying or touching the manifest (why: lint)', () => {
  const b = box();
  const html = b.src('bad.html', '<script>fetch("/x")</script>');
  const r = installPage(html, b.dash, 'bad-page', {});
  assert.equal(r.ok, false);
  assert.equal(r.why, 'lint');
  assert.match(r.detail, /which the page CSP blocks/);
  assert.equal(typeof r.line, 'number');
  assert.equal(existsSync(join(b.dash, 'pages', 'bad-page.html')), false);
  assert.equal(b.manifest(), null, 'no manifest is written for a refused install');
});

// The M5 invariant, pinned directly against the shared routine (not just
// through the seeder CLI): the manifest write is gated on the manifest
// having changed, never on whether a file was copied this call.
test('M5: the manifest is written when a page gains an entry even when the file was NOT copied', () => {
  const b = box();
  b.writeDashFile('pages/already-there.html', '<p>member placed this directly</p>');
  const html = b.src('offer.html', '<p>inbox version, never used</p>');
  const r = installPage(html, b.dash, 'already-there', {});
  assert.equal(r.copied, false, 'the file already existed');
  assert.equal(r.manifestChanged, true, 'it still needed a manifest entry');
  const entry = b.manifest().pages.find((p) => p.id === 'already-there');
  assert.ok(entry);
  assert.equal(b.pageContent('already-there'), '<p>member placed this directly</p>');
});

test('a fully-present page (file AND manifest entry) is a true no-op: ok, nothing copied, nothing changed', () => {
  const b = box();
  b.writeDashFile('pages/settled.html', '<p>already here</p>');
  b.writeDashFile('pages.json', JSON.stringify({ pages: [{ id: 'settled', title: 'Settled' }] }));
  const html = b.src('offer.html', '<p>never used</p>');
  const r = installPage(html, b.dash, 'settled', {});
  assert.deepEqual(r, { ok: true, copied: false, manifestChanged: false });
  assert.equal(b.pageContent('settled'), '<p>already here</p>');
  assert.deepEqual(b.manifest().pages, [{ id: 'settled', title: 'Settled' }]);
});
