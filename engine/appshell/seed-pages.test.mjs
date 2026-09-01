// seed-pages.test.mjs — the non-destructive seeding contract (three-layer L3).
//   node --test engine/appshell/seed-pages.test.mjs
// Contract under test: missing files are seeded; a member's edited files are
// NEVER overwritten; template pages added in later engine versions appear on
// disk AND in the member's manifest (newly-seeded only); a page the member
// removed from their manifest stays removed even though its file survives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_API_VERBS, lintPage } from './page-lint.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, 'seed-pages.mjs');
const TPL = JSON.parse(readFileSync(join(HERE, 'templates', 'pages.json'), 'utf8'));
const run = (box) => execFileSync('node', [SEED, box], { encoding: 'utf8' });
const rdj = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('first seed: full template lands, manifest + version + ownership written', () => {
  const box = tmpDir('seed-');
  run(box);
  const mf = rdj(join(box, 'dashboard', 'pages.json'));
  assert.equal(mf.template_version, TPL.template_version);
  assert.deepEqual(mf.pages.map((p) => p.id).sort(), TPL.pages.map((p) => p.id).sort());
  for (const p of TPL.pages) assert.ok(existsSync(join(box, 'dashboard', 'pages', p.id + '.html')), `${p.id}.html seeded`);
  assert.equal(readFileSync(join(box, 'dashboard', '.template-version'), 'utf8').trim(), String(TPL.template_version));
  assert.equal(rdj(join(box, 'ownership.json')).owner, 'member');
  assert.equal(rdj(join(box, 'ownership.json')).tier, 'pebble', 'backstop ownership carries the tier');
  assert.equal(rdj(join(box, 'ownership.json')).anchor, 'crads-ai', 'uniform anchor rule: no anchorless state — the backstop anchors to the Mountain');
  rmSync(box, { recursive: true, force: true });
});

test('re-seed never overwrites: edited page and edited manifest survive verbatim', () => {
  const box = tmpDir('seed-');
  run(box);
  const page = join(box, 'dashboard', 'pages', 'welcome.html');
  const mf = join(box, 'dashboard', 'pages.json');
  writeFileSync(page, '<h2>MINE</h2>');
  const myManifest = JSON.stringify({ template_version: TPL.template_version, pages: [{ id: 'welcome', title: 'Renamed by me' }, ...TPL.pages.filter((p) => p.id !== 'welcome')] }, null, 2) + '\n';
  writeFileSync(mf, myManifest);
  run(box);
  assert.equal(readFileSync(page, 'utf8'), '<h2>MINE</h2>', 'edited page untouched');
  assert.equal(readFileSync(mf, 'utf8'), myManifest, 'edited manifest untouched when nothing new to add');
  rmSync(box, { recursive: true, force: true });
});

test('later template generation: new page file seeds AND joins the member manifest; deleted entries stay deleted', () => {
  const box = tmpDir('seed-');
  run(box);
  const mf = join(box, 'dashboard', 'pages.json');
  // member deletes one template page from their manifest (keeps the file) and edits another page
  const kept = TPL.pages.filter((p) => p.id !== 'ask-me');
  writeFileSync(mf, JSON.stringify({ template_version: TPL.template_version, pages: kept }, null, 2) + '\n');
  // simulate a later engine version: remove one seeded FILE so the next run re-seeds it fresh
  // (equivalent to a brand-new template page arriving)
  rmSync(join(box, 'dashboard', 'pages', 'my-people.html'));
  const before = rdj(mf).pages.map((p) => p.id);
  assert.ok(before.includes('my-people'), 'precondition: my-people entry present');
  writeFileSync(mf, JSON.stringify({ template_version: TPL.template_version, pages: kept.filter((p) => p.id !== 'my-people') }, null, 2) + '\n');
  run(box);
  const after = rdj(mf).pages.map((p) => p.id);
  assert.ok(after.includes('my-people'), 'newly-seeded page joined the manifest');
  assert.ok(!after.includes('ask-me'), 'a page the member removed (file still on disk) is NOT resurrected');
  assert.ok(existsSync(join(box, 'dashboard', 'pages', 'my-people.html')), 'file re-seeded');
  rmSync(box, { recursive: true, force: true });
});

test('template pages obey the sandbox contract: no external URLs, only whitelisted pageApi verbs', () => {
  for (const p of TPL.pages) {
    const src = readFileSync(join(HERE, 'templates', 'pages', p.id + '.html'), 'utf8');
    const { ok, violations } = lintPage(src);
    assert.ok(ok, `${p.id}: ${violations.map((v) => `line ${v.line} ${v.rule}: ${v.detail}`).join('; ')} (whitelist: ${PAGE_API_VERBS.join(', ')})`);
  }
});

test('PROMOTED BOX: a rock ownership record survives re-seeding untouched (personal seat parity)', () => {
  // Promote ruling § 1 (2026-08-04): a promoted rock keeps its owner's personal
  // seat, and under brokered promotion the box keeps the member entrypoint. The
  // seeder re-runs on every boot, so the one way promotion could silently revert
  // is this backstop overwriting the flipped record. Pin: it never does.
  const box = tmpDir('seed-');
  const rock = { owner: 'org', owner_slug: 'my-org', managed_by: 'crads-ai', machinery_by: 'crads-ai', tier: 'rock', anchor: 'crads-ai' };
  writeFileSync(join(box, 'ownership.json'), JSON.stringify(rock, null, 2) + '\n');
  run(box);
  assert.deepEqual(rdj(join(box, 'ownership.json')), rock, 'a promoted record must never be reset to the pebble default');
});

// ---- who owns the box, at first boot (2026-08-20 audit, QA finding 188) -----
// The record was hardcoded owner: 'member', so an org-asset pebble contradicted
// its buyer's answer from its very first boot, and every custody surface
// downstream believed the file: deprovision-member refuses to tear down a
// member-owned box, /rock-tie-leave only blocks a walk-away on an org edge, and
// org-brain-wire.sh exits 0. The container cannot derive any of this, so it
// comes through /etc/ai-os/env alongside AIOS_OWNER_EMAIL and AIOS_ANCHOR_ORG.
const runEnv = (box, env) => execFileSync('node', [SEED, box], { encoding: 'utf8', env: { ...process.env, ...env } });

test('a rock-owned pebble is born the rock\'s, and says which rock', () => {
  const box = tmpDir('seed-');
  runEnv(box, { AIOS_OWNER: 'org', AIOS_ANCHOR_ORG: 'acme' });
  const own = rdj(join(box, 'ownership.json'));
  assert.equal(own.owner, 'org');
  // owner_slug comes from AIOS_ANCHOR_ORG rather than a second variable: at
  // birth the owning org IS the anchoring org, so there is nothing to keep in
  // step and no absentee owner.
  assert.equal(own.owner_slug, 'acme');
  // THE BINARY VOCABULARY, not the registry's movable pointer form.
  // ownership-resolve.mjs, the promote flip and org-brain-wire.sh all compare
  // against the literal 'org', so writing the slug into `owner` would switch
  // org-brain-wire off on a string comparison.
  assert.notEqual(own.owner, 'acme');
  rmSync(box, { recursive: true, force: true });
});

test('and it FAILS CLOSED: not knowing never resolves to "the org owns you"', () => {
  for (const env of [
    {},                                              // nothing staged at all
    { AIOS_OWNER: '' },                              // staged empty
    { AIOS_OWNER: 'ORG' },                           // wrong case is not a match
    { AIOS_OWNER: 'orgg' },                          // near miss
    { AIOS_OWNER: 'org' },                           // org with NO anchor: absentee owner
  ]) {
    const box = tmpDir('seed-');
    runEnv(box, env);
    const own = rdj(join(box, 'ownership.json'));
    assert.equal(own.owner, 'member', `${JSON.stringify(env)} must resolve to member`);
    assert.ok(!('owner_slug' in own), 'and a member-owned box names no owning org');
    rmSync(box, { recursive: true, force: true });
  }
});

test('the uniform anchor rule is not quietly rewritten by an ownership change', () => {
  // Changing `anchor` because ownership moved would be a second decision
  // smuggled into this one. It has its own stamping path and its own ruling.
  const box = tmpDir('seed-');
  runEnv(box, { AIOS_OWNER: 'org', AIOS_ANCHOR_ORG: 'acme' });
  assert.equal(rdj(join(box, 'ownership.json')).anchor, 'crads-ai');
  rmSync(box, { recursive: true, force: true });
});

// ---- seed: true (panel iteration 2, R15, 2026-08-23) -----------------------
// A manifest entry WE wrote carries `seed: true`, so the app can chip it
// "Example page" and offer delete. A member-authored entry never gets it.
test('every seeded manifest entry carries seed: true; a member-authored entry never does', () => {
  const box = tmpDir('seed-');
  run(box);
  const mf = join(box, 'dashboard', 'pages.json');
  for (const p of rdj(mf).pages) assert.equal(p.seed, true, `${p.id} is a seeded entry`);
  // the member adds their own page and removes a seeded file so the next run re-seeds it
  const mine = rdj(mf);
  mine.pages.push({ id: 'mine', title: 'Mine' });
  mine.pages = mine.pages.filter((p) => p.id !== 'ask-me');
  writeFileSync(mf, JSON.stringify(mine, null, 2) + '\n');
  writeFileSync(join(box, 'dashboard', 'pages', 'mine.html'), '<h2>mine</h2>');
  rmSync(join(box, 'dashboard', 'pages', 'ask-me.html'));
  run(box);
  const after = rdj(mf).pages;
  const own = after.find((p) => p.id === 'mine');
  assert.ok(own && !('seed' in own), 'the member entry is untouched: no seed flag');
  const back = after.find((p) => p.id === 'ask-me');
  assert.ok(back && back.seed === true, 'the re-seeded entry (additive merge) carries the flag');
  rmSync(box, { recursive: true, force: true });
});

test('the template manifest itself declares seed: true on every page', () => {
  for (const p of TPL.pages) assert.equal(p.seed, true, `${p.id} in templates/pages.json`);
});

// ---- page-delete.mjs: the file AND the manifest entry go, nothing else -------
test('page-delete removes the fragment and the manifest entry, leaves the rest, names unknown ids', async () => {
  const { deletePage } = await import('./page-delete.mjs');
  const box = tmpDir('seed-');
  run(box);
  const mf = join(box, 'dashboard', 'pages.json');
  const before = rdj(mf).pages.length;
  const r = deletePage(box, 'welcome');
  assert.equal(r.ok, true);
  assert.match(r.msg, /^OK: page welcome deleted\.$/);
  assert.ok(!existsSync(join(box, 'dashboard', 'pages', 'welcome.html')), 'file gone');
  const pages = rdj(mf).pages;
  assert.equal(pages.length, before - 1);
  assert.ok(!pages.some((p) => p.id === 'welcome'), 'manifest entry gone');
  assert.ok(pages.some((p) => p.id === 'ask-me'), 'other entries untouched');
  const again = deletePage(box, 'welcome');
  assert.equal(again.ok, false);
  assert.match(again.msg, /^ERROR: /);
  for (const id of ['../x', 'a/b', '', 'Bad']) assert.equal(deletePage(box, id).ok, false, `refused ${JSON.stringify(id)}`);
  // the CLI face says the same thing
  const out = execFileSync('node', [join(HERE, 'page-delete.mjs'), box, 'ask-me'], { encoding: 'utf8' });
  assert.match(out, /^OK: page ask-me deleted\./);
  assert.ok(!existsSync(join(box, 'dashboard', 'pages', 'ask-me.html')));
  // and a deleted seeded page is NOT resurrected by the next seed run (the app
  // runs the seeder on every pages-list): the tombstone holds it down.
  run(box);
  assert.ok(!existsSync(join(box, 'dashboard', 'pages', 'ask-me.html')), 'deleted example stays deleted after re-seed');
  assert.ok(!rdj(mf).pages.some((p) => p.id === 'ask-me' || p.id === 'welcome'), 'and stays out of the manifest');
  assert.deepEqual(rdj(join(box, 'dashboard', 'pages.deleted.json')).sort(), ['ask-me', 'welcome']);
  // dropping the tombstone is the way back
  writeFileSync(join(box, 'dashboard', 'pages.deleted.json'), '["welcome"]\n');
  run(box);
  assert.ok(existsSync(join(box, 'dashboard', 'pages', 'ask-me.html')), 'un-tombstoned example returns');
  assert.ok(rdj(mf).pages.some((p) => p.id === 'ask-me' && p.seed === true), 'listed again, still flagged as an example');
  assert.ok(!existsSync(join(box, 'dashboard', 'pages', 'welcome.html')), 'the still-tombstoned one does not');
  rmSync(box, { recursive: true, force: true });
});
