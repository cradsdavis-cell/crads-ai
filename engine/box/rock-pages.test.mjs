// rock-pages.test.mjs — Pages on rocks (panel iteration 2, R15, 2026-08-23).
// Pages were pebble-only: boot-rock.sh never called the seeder, and the rock
// inbox sync listed pushed pages with no title and no origin. Pins:
//   1. boot-rock.sh runs engine/appshell/seed-pages.mjs against $STATE_DIR,
//      non-fatally, the way box-up.sh does (structural).
//   2. org-sync.sh marks an inbox-born manifest entry `from: <rock>` with a
//      title from a sibling <id>.json (else the id), never `seed: true`, and
//      honours the page-delete tombstone (behavioural: the inline node block
//      is lifted out of the script and run against a temp box).
//   node --test engine/box/rock-pages.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const BOOT = readFileSync(join(ROOT, 'provisioning', 'rock', 'boot-rock.sh'), 'utf8');
const BOXUP = readFileSync(join(ROOT, 'engine', 'box-up.sh'), 'utf8');
const ORGSYNC = readFileSync(join(ROOT, 'engine', 'box', 'org-sync.sh'), 'utf8');
const exec = (src) => src.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');

test('boot-rock.sh seeds pages at /state the way box-up.sh does, and cannot fail the boot on it', () => {
  const lines = exec(BOOT).split('\n').filter((l) => /seed-pages\.mjs/.test(l));
  assert.equal(lines.length, 1, 'exactly one call to the seeder');
  const call = lines[0];
  assert.match(call, /engine\/appshell\/seed-pages\.mjs"?\s+"\$STATE_DIR"/, 'runs against $STATE_DIR (the rock\'s /state), not the brain root');
  // non-fatal under set -e: either `|| true` / `|| pend` or an if-guard
  const guarded = /\|\|/.test(call) || /^\s*if\s+node/.test(call);
  assert.ok(guarded, `the seeder call is guarded: ${call.trim()}`);
  // parity with the pebble entrypoint: same script, same shape
  assert.match(exec(BOXUP), /engine\/appshell\/seed-pages\.mjs|\$ENGINE\/appshell\/seed-pages\.mjs/, 'box-up.sh still seeds too');
  // and it runs AFTER ownership.json is written, so the seeder's pebble backstop never fires on a rock
  assert.ok(BOOT.indexOf('ownership.json') < BOOT.indexOf('seed-pages.mjs'), 'ownership record is written before the seeder runs');
});

test('boot-rock.sh stays person- and org-free around the new call (clean-gate shape)', () => {
  const block = BOOT.slice(BOOT.indexOf('# ---- pages (panel iteration 2'), BOOT.indexOf('seed-pages.mjs') + 400);
  assert.ok(!/@|gmail|impact|harriet|sam\b/i.test(block), 'no person or org names near the pages block');
});

// M8 (2026-08-25 fix wave): nothing pinned the call path in org-sync.sh's
// seed_pages(), so an edit that changes "${AIOS_DIR:-/app}/engine/appshell/"
// to a wrong prefix left every test green while every org page silently
// stopped seeding. Same in-style pin as the boot-rock.sh check above.
test('org-sync.sh calls the org-page seeder at the fixed member-image path', () => {
  const lines = exec(ORGSYNC).split('\n').filter((l) => /node .*seed-org-pages\.mjs/.test(l));
  assert.equal(lines.length, 1, 'exactly one call to the org-page seeder');
  const call = lines[0];
  assert.match(
    call,
    /\$\{AIOS_DIR:-\/app\}\/engine\/appshell\/seed-org-pages\.mjs/,
    'runs at the fixed member-image engine path (the copied boot-time script cannot resolve a sibling appshell/ by relative path)'
  );
});

// Was: lift the inline node program out of org-sync.sh's seed_pages() and run
// it with `node -e`. 2026-08-25 task 3 extracted that program verbatim into
// engine/appshell/seed-org-pages.mjs (org-sync.sh now just calls it), so there
// is no inline text left to lift — run the real file instead. Same behaviour,
// same five-argument order; only the invocation mechanism changed, the
// assertions below are untouched.
const SEED_ORG_PAGES = join(HERE, '..', 'appshell', 'seed-org-pages.mjs');
function runInbox(box, inboxPages, ghOwner) {
  return execFileSync('node', [SEED_ORG_PAGES, inboxPages, join(box, 'dashboard'), ghOwner, box, ''], { encoding: 'utf8' });
}

// Was: 'an inbox-born page is listed from: <rock> with the pack title, never
// seed: true', asserting house-rules and untitled got BRAND NEW manifest
// entries with from/title derived at arrival. Retired by delivery-model step
// 7c, Part B: reconcile now stages every kind automatically to
// offers-pages/ (pickup-only), so this leg no longer creates an entry for an
// id it has no manifest record of, on a rock inbox same as an org inbox. The
// still-live half (existing entries untouched, an off-slug id skipped, and a
// repair recreating a missing file without touching its from/title) is split
// into the two tests below.
test('a brand-new inbox page is left for pickup: no entry, no file, existing entries and off-slug ids unaffected', () => {
  const box = tmpDir('rockpages-');
  const inbox = join(box, 'org-inbox', 'pages', 'welcome-pack');
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, 'house-rules.html'), '<h2>rules</h2>');
  writeFileSync(join(inbox, 'house-rules.json'), JSON.stringify({ title: 'House rules' }));
  writeFileSync(join(inbox, 'untitled.html'), '<h2>x</h2>');
  writeFileSync(join(inbox, 'Bad Name.html'), '<h2>no</h2>');
  mkdirSync(join(box, 'dashboard'), { recursive: true });
  writeFileSync(join(box, 'dashboard', 'pages.json'), JSON.stringify({ template_version: 2, pages: [{ id: 'welcome', title: 'Welcome', seed: true }] }, null, 2) + '\n');
  writeFileSync(join(box, 'ownership.json'), JSON.stringify({ owner: 'member', anchor: 'harriets-rock' }));
  runInbox(box, join(box, 'org-inbox', 'pages'), 'some-gh-owner');
  const pages = JSON.parse(readFileSync(join(box, 'dashboard', 'pages.json'), 'utf8')).pages;
  assert.ok(!pages.some((p) => p.id === 'house-rules'), 'no entry for an id with no prior manifest record');
  assert.ok(!pages.some((p) => p.id === 'untitled'), 'same for one with no sibling json');
  assert.ok(!existsSync(join(box, 'dashboard', 'pages', 'house-rules.html')), 'and no file either');
  assert.ok(!pages.some((p) => /Bad/.test(p.id)), 'an id outside the slug shape is still skipped');
  assert.deepEqual(pages, [{ id: 'welcome', title: 'Welcome', seed: true }], 'existing entries untouched, nothing added');
  rmSync(box, { recursive: true, force: true });
});

test('an inbox page that already has a manifest entry is repaired: missing file recreated, from/title left exactly as they were', () => {
  const box = tmpDir('rockpages-');
  const inbox = join(box, 'org-inbox', 'pages', 'welcome-pack');
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, 'house-rules.html'), '<h2>rules</h2>');
  writeFileSync(join(inbox, 'house-rules.json'), JSON.stringify({ title: 'A different title, never used' }));
  mkdirSync(join(box, 'dashboard'), { recursive: true });
  writeFileSync(join(box, 'dashboard', 'pages.json'), JSON.stringify({
    pages: [{ id: 'welcome', title: 'Welcome', seed: true }, { id: 'house-rules', title: 'House rules', from: 'harriets-rock' }],
  }, null, 2) + '\n');
  writeFileSync(join(box, 'ownership.json'), JSON.stringify({ owner: 'member', anchor: 'harriets-rock' }));
  runInbox(box, join(box, 'org-inbox', 'pages'), 'some-gh-owner');
  const pages = JSON.parse(readFileSync(join(box, 'dashboard', 'pages.json'), 'utf8')).pages;
  const rules = pages.find((p) => p.id === 'house-rules');
  assert.deepEqual(rules, { id: 'house-rules', title: 'House rules', from: 'harriets-rock' }, 'the entry is never touched, even though the file was missing');
  assert.ok(existsSync(join(box, 'dashboard', 'pages', 'house-rules.html')), 'the missing file is recreated');
  rmSync(box, { recursive: true, force: true });
});

test('with no manifest entry, the origin no longer falls back to the inbox GitHub owner: the id is simply left alone', () => {
  const box = tmpDir('rockpages-');
  const inbox = join(box, 'org-inbox', 'pages', 'p');
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, 'a.html'), '<p>a</p>');
  mkdirSync(join(box, 'dashboard'), { recursive: true });
  writeFileSync(join(box, 'ownership.json'), JSON.stringify({ owner: 'member', anchor: 'crads-ai' }));
  runInbox(box, join(box, 'org-inbox', 'pages'), 'gh-owner');
  assert.equal(existsSync(join(box, 'dashboard', 'pages.json')), false, 'no manifest is written at all');
  assert.equal(existsSync(join(box, 'dashboard', 'pages', 'a.html')), false);
  rmSync(box, { recursive: true, force: true });
});

test('a page the member deleted is not pushed back by the next inbox sync', () => {
  const box = tmpDir('rockpages-');
  const inbox = join(box, 'org-inbox', 'pages', 'p');
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, 'gone.html'), '<p>gone</p>');
  writeFileSync(join(inbox, 'kept.html'), '<p>kept, from a re-run repairing a missing file</p>');
  mkdirSync(join(box, 'dashboard'), { recursive: true });
  writeFileSync(join(box, 'dashboard', 'pages.deleted.json'), '["gone"]\n');
  // 'kept' already has a manifest entry (as it would on the very next sync
  // after the run that first delivered it): this test is about the tombstone,
  // not about a brand-new arrival, which is covered on its own above.
  writeFileSync(join(box, 'dashboard', 'pages.json'), JSON.stringify({ pages: [{ id: 'kept', title: 'kept' }] }));
  runInbox(box, join(box, 'org-inbox', 'pages'), 'gh');
  const pages = JSON.parse(readFileSync(join(box, 'dashboard', 'pages.json'), 'utf8')).pages;
  assert.ok(!pages.some((p) => p.id === 'gone'), 'tombstoned id not listed');
  assert.ok(!existsSync(join(box, 'dashboard', 'pages', 'gone.html')), 'and not copied');
  assert.ok(existsSync(join(box, 'dashboard', 'pages', 'kept.html')), 'the other page is still repaired');
  rmSync(box, { recursive: true, force: true });
});
