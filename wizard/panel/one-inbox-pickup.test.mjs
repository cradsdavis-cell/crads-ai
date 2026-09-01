// one-inbox-pickup.test.mjs — P2 of the one-inbox spec (2026-08-17): nothing
// installs itself, and what a member picked up they can put back.
//   node --test wizard/panel/one-inbox-pickup.test.mjs
//
// The behaviour change here is the one a real client feels: until today a rock
// pushed a skill and org-sync copied it onto the member's box, running, without
// the member doing anything. Sam's ruling of 17 Aug ends that. These tests pin
// both halves of the replacement and, just as importantly, the refusals that
// stop pickup becoming a way to overwrite things that are not the rock's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MEMBER_VERBS } from './panel-server.mjs';

const orgSync = readFileSync(new URL('../../engine/box/org-sync.sh', import.meta.url), 'utf8');

test('org-sync stages and no longer installs: the copy loops are gone', () => {
  // The precise thing that must not come back. Both loops wrote into
  // .claude/skills from the inbox on a two-minute cron.
  assert.ok(!/cp "\$sdir\/SKILL\.md"/.test(orgSync), 'the D49 package copy is gone');
  assert.ok(!/cp "\$sk" "\$SKILLS\/\$name\/SKILL\.md"/.test(orgSync), 'the legacy pack copy is gone with it');
  assert.ok(!/\$SKILLS\/\$name\/\.origin\.json/.test(orgSync), 'and nothing stamps provenance behind the member');
  assert.match(orgSync, /ALWAYS PICKUP, NEVER AUTO/, 'and the file says why, where the next reader will look');
  // The mirror itself must survive: it IS the staging area now.
  assert.match(orgSync, /git clone --depth 1 "\$URL" "\$INBOX"/, 'the inbox is still pulled');
});

test('org-sync still does the jobs that were never about installing', () => {
  assert.match(orgSync, /member\.authorized_keys/, 'device keys still land');
  assert.match(orgSync, /org-brain-wire\.sh/, 'brain wiring still runs');
  assert.match(orgSync, /MEMBERSHIP\.yaml/, 'the membership gate still reads');
  // 2026-08-25 task 3: the page-seed logic itself moved out of org-sync.sh
  // into a real file (engine/appshell/seed-org-pages.mjs), so the literal
  // "pages.json" text is no longer in this script: org-sync.sh still calls
  // the seeder, and the seeder is the one that writes the manifest.
  assert.match(orgSync, /seed-org-pages\.mjs/, 'inert page seeds still apply');
  const seeder = readFileSync(new URL('../../engine/appshell/seed-org-pages.mjs', import.meta.url), 'utf8');
  // 2026-08-26 step 5a: the copy-plus-manifest routine moved one level
  // further, out of the seeder and into install-page.mjs, shared with the
  // new (still dormant) explicit page-install verb, so the two paths cannot
  // drift apart. "pages.json" is therefore no longer a literal in the seeder
  // itself; assert the delegation instead, and confirm the manifest-writing
  // code the seeder now relies on is still there.
  assert.match(seeder, /import\s*\{\s*installPage\s*\}\s*from\s*['"]\.\/install-page\.mjs['"]/,
    'the seeder delegates the copy/manifest work to the shared installer');
  const shared = readFileSync(new URL('../../engine/appshell/install-page.mjs', import.meta.url), 'utf8');
  assert.match(shared, /pages\.json/, 'the extracted seeder still writes the page manifest, via the shared installer');
});

// ---- pickup -------------------------------------------------------------------

const install = (id) => MEMBER_VERBS['catalog-install'].build({ id }).command;

test('installing copies out of the staged inbox, with no network leg at all', () => {
  const cmd = install('deep-research');
  assert.match(cmd, /\/state\/org-inbox\/offers\/deep-research/, 'reads the staging area org-sync maintains');
  assert.match(cmd, /\$BR\/\.claude\/skills\/deep-research/, 'writes the installed location');
  // the nine-hop round trip is gone
  assert.ok(!/catalog-requests\.json/.test(cmd), 'no request queued');
  assert.ok(!/heartbeat/.test(cmd), 'no heartbeat fired');
  assert.ok(!/curl|fetch/.test(cmd), 'and nothing dialled');
});

test('a package that was never offered is refused, and the message says why', () => {
  const cmd = install('never-offered');
  assert.match(cmd, /is not in your inbox/);
  assert.match(cmd, /org-sync runs every 2 minutes/, 'distinguishes "not offered" from "not arrived yet"');
});

test('the two refusals that protect what is already on the box survive verbatim', () => {
  const cmd = install('deep-research');
  assert.match(cmd, /already exists on this mineral and is not a rock-published skill/,
    'never overwrite something the member wrote');
  assert.match(cmd, /already installed from a different rock/,
    'and one rock cannot replace another rock’s skill under the same id');
  assert.match(cmd, /nothing was changed/, 'both refusals say the box is untouched');
});

test('the manifest travels, and first-installed survives a re-install', () => {
  const cmd = install('deep-research');
  assert.match(cmd, /skill\.yaml/, 'the manifest comes too, so cadence and category still read');
  assert.match(cmd, /context\//, 'and any bundled reference files');
  assert.match(cmd, /"installed":\\s\*"\\K\[\^"\]\+/, 'the existing installed date is read back');
  assert.match(cmd, /INST="\$\(date -u \+%Y-%m-%d\)"|\[ -n "\$INST" \] \|\| INST=/, 'and only defaulted when absent');
});

test('legacy packs are installable without a second code path', () => {
  const cmd = install('old-skill');
  assert.match(cmd, /org-inbox\/packs\/\*\/skills\/old-skill\.md/, 'found by search, not by a parallel branch');
});

test('ids are validated before any of it', () => {
  for (const evil of ['../up', 'X Y', '', 'a'.repeat(64), 'semi;colon']) {
    assert.throws(() => MEMBER_VERBS['catalog-install'].build({ id: evil }), /kebab-case/);
    assert.throws(() => MEMBER_VERBS['skill-remove'].build({ id: evil }), /kebab-case/);
  }
});

// ---- remove -------------------------------------------------------------------

// UPDATED 2026-08-23 (panel iteration 2, R11). The 17 Aug rule was "only what
// a rock published": gated on .origin.json, self-authored dirs refused. Sam's
// 23 Aug ruling widens removal to anything that is not an ENGINE skill, with
// the are-you-sure carrying the "only copy" warning for self-authored ones.
// The cadence entry now goes with the skill. Full fixture-driven coverage is
// in p2-skill-member-verbs.test.mjs; this pin keeps the shape the page relies on.
test('remove exists, refuses engine ids by name, and reaches everything else', () => {
  assert.ok(MEMBER_VERBS['skill-remove'], 'the gap the 17 Aug audit found is closed');
  assert.equal(MEMBER_VERBS['skill-remove'].mutating, true);
  const cmd = MEMBER_VERBS['skill-remove'].build({ id: 'deep-research' }).command;
  assert.match(cmd, /\/app\/engine\/skills\/deep-research\.md/, 'engine ids are refused by name, not by marker');
  assert.match(cmd, /is a built-in skill and cannot be removed/);
  assert.ok(!/did not come from a rock/.test(cmd), 'the .origin.json gate is gone: self-authored dirs are removable');
  assert.match(cmd, /Your rock still offers it/, 'a rock-published removal says the offer stands');
  assert.match(cmd, /That was the only copy/, 'a self-authored removal says what it was');
  assert.match(cmd, /is not installed on this mineral/, 'removing nothing says so rather than succeeding quietly');
});

test('removing strips the schedule too (R11): no orphaned cadence entry', () => {
  const cmd = MEMBER_VERBS['skill-remove'].build({ id: 'deep-research' }).command;
  assert.match(cmd, /cadence\.json/, 'the cadence entry goes with the skill');
  assert.match(cmd, /renameSync/, 'atomically');
});

test('remove is a member power, and installing entitlement stays the rock’s', () => {
  assert.ok(!MEMBER_VERBS['catalog-policy-write'], 'entitlement is not a member dial');
  assert.ok(MEMBER_VERBS['catalog-install'] && MEMBER_VERBS['skill-remove'],
    'but both halves of pickup are');
});

// Found while reading the deploy path (2026-08-17), and the reason offers/ is
// not skills/. :v2 is what every box pulls and each picks it up on restart, so
// there is always a window of new rocks and old pebbles. An old org-sync copies
// everything under inbox/skills/ into .claude/skills, because before one-inbox
// that folder only held packages the member had already requested. Materialising
// the entitled set there would have auto-installed a rock's whole catalogue on
// every box not yet updated: the exact behaviour always-pickup removes, on live
// client boxes.
test('offers land where an old box will not auto-install them', () => {
  const cmd = install('deep-research');
  assert.match(cmd, /org-inbox\/offers\//, 'the rock materialises into a folder old boxes do not read');
  const orgSync = readFileSync(new URL('../../engine/box/org-sync.sh', import.meta.url), 'utf8');
  assert.ok(!/offers/.test(orgSync), 'and this engine does not copy it either: pickup is the only way in');
});

test('a member who updates ahead of their rock can still install what was already pushed', () => {
  // The other direction of the same window. An un-updated rock still pushes to
  // skills/ on the old fulfilment path, so the fallback keeps those installable
  // rather than stranding them behind a folder that rock will never write.
  const cmd = install('deep-research');
  assert.match(cmd, /\|\| SRC="\/state\/org-inbox\/skills\/deep-research"/, 'skills/ is the fallback, not the primary');
});
