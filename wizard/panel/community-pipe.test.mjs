// community-pipe.test.mjs — the app half of the joined-rock publish pipe
// (2026-08-09 audit, R9). The directory half is directory/community-catalog
// .test.mjs; this file pins the verbs and the page wiring.
//   node --test wizard/panel/community-pipe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MEMBER_VERBS, VERBS } from './panel-server.mjs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// ---- member verb: community-skill-apply ------------------------------------

// ONE INBOX (2026-08-17). Two tests stood here: one pinning
// community-skill-apply's validation, one pinning that the rock IMPORTED it
// across the org-verb wall so a rock could install from a rock it had joined.
// Both describe a delivery path that no longer exists. The verb wrote a package
// the app had fetched from the directory straight onto a box, and it was the
// only writer that installed content the box had not received through its own
// inbox. Its two good refusals live on in catalog-install, pinned in
// one-inbox-pickup.test.mjs.
//
// What is worth pinning is that it is GONE, on both faces: a stale caller must
// get "unknown verb", never a half-working second path.
test('the community install verb is gone from both verb tables', () => {
  assert.ok(!MEMBER_VERBS['community-skill-apply'], 'not a member verb');
  assert.ok(!VERBS['community-skill-apply'], 'nor an org one');
  assert.doesNotMatch(server, /'community-skill-apply'\]/, 'and not imported across the org-verb wall');
});

test('a rock installs from a rock it joined the same way a pebble does', () => {
  // The reason the verb crossed the wall in the first place was that a rock is
  // a box and wanted its joined rocks' skills. That need did not go away; it is
  // met by the ordinary installer now, because a rock gets an inbox from every
  // rock it is tied to.
  // Imported across the wall, not an org native: an imported mutating verb is
  // rewritten adminOnly for the org face, which a native entry would not be.
  assert.ok(!VERBS['catalog-install'], 'not an org NATIVE verb');
  assert.match(server, /'catalog-list', 'catalog-install', 'skill-remove',/, 'the rock imports the member ones');
  assert.equal(MEMBER_VERBS['catalog-install'].mutating, true, 'so the import lands adminOnly on the rock');
  assert.equal(VERBS['community-catalog-push'].adminOnly, true, 'publishing is still an Admin action');
  assert.ok(!MEMBER_VERBS['community-catalog-push'], 'a pebble still cannot publish a catalogue');
});

// ---- org verb: community-catalog-push --------------------------------------

test('community-catalog-push reads the rock’s own token + skills and enforces the vocabulary (R7)', () => {
  for (const evil of [['a b'], ['../etc'], Array.from({ length: 65 }, (_, i) => 'x' + i)]) {
    assert.throws(() => VERBS['community-catalog-push'].build({ ids: evil }));
  }
  // 0 ids became LEGAL on 2026-08-10. The floor used to be 1, which made
  // "listed nowhere" unreachable: once a rock had published anything, the
  // catalogue could be replaced but never emptied. The worker has always taken
  // an empty items array; only this guard stood in the way.
  const empty = VERBS['community-catalog-push'].build({ ids: [] }).command;
  assert.match(empty, /is now empty/, 'un-listing everything is expressible and says so plainly');
  assert.match(empty, /ORG_PULL_TOKEN/, 'and still authenticates as the rock');
  const cmd = VERBS['community-catalog-push'].build({ ids: ['deep-research'] }).command;
  assert.match(cmd, /ORG_PULL_TOKEN/, 'authenticates with the rock’s directory token');
  assert.match(cmd, /community-catalog/, 'posts to the directory catalogue route');
  assert.match(cmd, /"briefing","capture","comms","box","org","other"/, 'carries the vocabulary for the named refusal (R7 on the rock’s own screen)');
  // ONE STORE (Sam, 2026-08-10): this read the mineral’s INSTALLED skills while
  // the member audience read the distribution library, so the Catalogue could
  // agree with neither the Skills page nor itself. Both audiences read the
  // library now, which also fixes the category bug below.
  assert.match(cmd, /skills-library\/"\+id/, 'reads the rock’s distribution library');
  assert.ok(!cmd.includes('/state/.claude/skills/'), 'and never the installed-skills store');
  assert.match(cmd, /skill\.yaml/, 'category comes from the manifest, where the template puts it');
  assert.match(cmd, /content_b64/, 'ships the content so a joined member can install without any box channel');
});

// ---- panel routes -----------------------------------------------------------

test('the panel serves the shop window, and no longer serves content', () => {
  assert.match(server, /path === '\/community-catalogs'/, 'the manifest route survives: browsing is not acquiring');
  assert.doesNotMatch(server, /path === '\/community-item'\) \{/, 'the content route is gone');
  assert.match(server, /cache\[org\]\.at > 60000/, 'manifest fetches are still cached a minute');
});

// ---- page wiring ------------------------------------------------------------

test('the member page reads ONE source, and installs with one call', () => {
  assert.match(html, /function libEntries\(\)/, 'the list builder exists');
  assert.match(html, /fetch\('\/community-catalogs'\)/, 'the shop window still loads for the Organisations page');
  // The merge is what had to go: every rock a box is tied to writes into that
  // box's own inbox, so catalog-list already carries all of them and merging
  // the window back in would render every row twice.
  const fn = html.split('function libEntries()')[1].split('function renderSkills()')[0];
  assert.doesNotMatch(fn, /communityCatalogs/, 'the shop window is not merged into the member list');
  assert.doesNotMatch(fn, /community: true/, 'and no row is marked as arriving by another channel');
  const inst = html.split('function rockInstall(')[1].split('function rockRemove(')[0];
  assert.match(inst, /run\('catalog-install'/, 'one installer');
  // Assert on what the function DOES, not on words: the explanatory comment
  // above it names the retired verbs on purpose, so a source-string search for
  // them matches the history rather than the behaviour.
  const body = inst.slice(inst.indexOf('var it = l.it'));
  assert.doesNotMatch(body, /fetch\(/, 'no network leg');
  assert.doesNotMatch(body, /sign-in-needed/, 'the sign-in failure went with the fetch that could raise it');
  assert.doesNotMatch(body, /l\.community/, 'and no branch on which channel a row came from');
});

// Rewritten 2026-08-10: the standalone Community catalogue card is gone and the
// pipe rode the right-hand switch on every Catalogue row. RETIRED AGAIN in
// panel iteration 2 (R4 + F2, 2026-08-23): rock-to-rock distribution left the
// page entirely. The push verb STAYS in the table for now (unreachable), the
// 400 it drew from the worker (F2) is moot, and the Catalogue publishes to
// ONE audience, its members, from the row. catalogue-page.test.mjs pins the
// new shape; this file pins only that the old wiring did not come back.
test('R4/F2: the rock face no longer publishes to the community from the Catalogue', () => {
  assert.ok(!html.includes('id="commCatCard"'), 'the separate community card is gone');
  assert.ok(!html.includes('function loadCommCat('), 'and its loader with it');
  for (const id of ['catRows', 'catState', 'catNotice']) {
    assert.ok(html.includes(`id="${id}"`), `${id} present`);
  }
  assert.ok(!html.includes("run('community-catalog-push'"), 'the page never calls the push verb (F2: the worker 400s on it)');
  assert.ok(!html.includes("run('community-catalog-list'"), 'nor reads the listing');
  assert.ok(!html.includes('function catCommIds('), 'and the listed-set builder is gone');
  assert.ok(VERBS['community-catalog-push'], 'the verb itself stays, unreachable from the page');
  assert.match(html, /if \(name === 'publish'\) loadCatalogue\(\);/, 'opening the Catalogue still loads it');
});
