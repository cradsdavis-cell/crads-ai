// catalogue-page.test.mjs — the Catalogue page (Sam, 2026-08-10; iteration 2
// 2026-08-23; rebuilt commons-led for the face collapse, 2026-09-01).
//   node --test wizard/panel/catalogue-page.test.mjs
//
// The hosted era gave this page a per-member offer grid, an audience policy
// and Publish-on-the-row, all of which presumed a rock pushing content down to
// minerals it hosted. In the commons model membership IS the entitlement:
// read access to a git repository the owner controls. So the page is now the
// Commons card first (set up, publish, Access roster, grants) and a READ-ONLY
// inventory of the library zones a publish ships whole. What this file guards:
//   1. the hosted machinery stays retired: no offer grid, no audience policy,
//      no per-row publish, and no catalog-policy verb in the SERVED table
//   2. the Commons card leads the page, with the Access roster and the
//      bundle-line and GitHub-sign-in hints where the owner will read them
//   3. the inventory: one load from skill-list + pack-list + item-list,
//      rendered in zones by kind, each row title · chips · description only
//   4. the count strip counts per kind; empty and populated states render
//      their own thing
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERBS, MEMBER_VERBS } from './panel-server.mjs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');
const sec = html.slice(html.indexOf('<section data-sec="publish"'), html.indexOf('</section>', html.indexOf('<section data-sec="publish"')));
const js = html.slice(html.indexOf('// The catalogue, post-collapse (2026-09-01)'), html.indexOf('// ---- Pack content editor'));

// Assert on CODE shapes (a verb call, an element id, a function definition),
// not on prose: comments explaining the retirements are allowed to name what
// went.
test('the hosted-era machinery stays retired: no grid, no policy, no per-row publish', () => {
  for (const verb of ['community-catalog-push', 'community-catalog-list', 'catalog-sync', 'skill-push',
    'catalog-policy-write', 'catalog-reconcile-run']) {
    assert.ok(!html.includes(`run('${verb}'`), `member.html no longer runs ${verb}`);
  }
  for (const name of ['catToggle', 'catSetMember', 'catWritePolicy', 'catPublishRow(',
    'catInstalled', 'catDirty', 'CAT.draft', 'CAT.base', 'catAud(', 'fleetNames']) {
    assert.ok(!html.includes(name), `${name} is gone from the shell`);
  }
  for (const id of ['vendorRow', 'catTies', 'catSave', 'catSaveCtx', 'catPublish"', 'catDiscard', 'catalogSyncBtn']) {
    assert.ok(!html.includes(`id="${id}"`), `#${id} is gone`);
  }
  assert.ok(!html.includes('catInstallPanel'), 'the Install-for panel is gone, name and all');
  assert.ok(!html.includes('class="stickysave"'), 'no page-level sticky bar');
  assert.ok(!sec.includes('class="catgrid"'), 'no member grid in the markup');
});

test('the served verb table carries the catalogue dozen and never the policy verbs', () => {
  // One verb table since the face collapse: MEMBER_VERBS plus the named
  // CATALOGUE_VERBS list. catalog-policy-write stays exported from VERBS for
  // its own unit tests, but it must never be in the served list, or the
  // audience machinery is reachable again from any browser.
  const m = server.match(/const CATALOGUE_VERBS = \[([\s\S]*?)\];/);
  assert.ok(m, 'the served catalogue list is a named literal');
  const served = [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
  assert.deepEqual(served, ['skill-list', 'pack-list', 'item-list', 'pack-content-list',
    'prompt-write', 'page-write', 'commons-status', 'commons-roster', 'commons-init',
    'commons-publish', 'commons-grant', 'commons-revoke'], 'exactly the catalogue dozen');
  assert.ok(!served.includes('catalog-policy-write') && !served.includes('catalog-reconcile-run'),
    'no policy verb rides the served table');
  for (const v of served) assert.ok(VERBS[v] || MEMBER_VERBS[v], `${v} really exists to serve`);
});

test('the Commons card leads the page and the roster is headed Access', () => {
  const commonsAt = sec.indexOf('id="commonsCard"');
  const libraryAt = sec.indexOf('>Your library<');
  assert.ok(commonsAt > 0 && libraryAt > commonsAt, 'Commons first, the library inventory below it');
  assert.match(sec, /<h3 class="subhead" id="commonsCard">Commons<button class="info"/, 'the card head carries its bubble');
  assert.match(sec, /<h4 class="subhead"[^>]*>Access<button class="info"/, 'the roster subheading is Access');
  assert.match(sec, /sends their GitHub invitation when you give their username, and makes their join link/, 'the grant hint leads with the link + the sent invitation');
  assert.match(sec, /Send the link in a direct message, never a public post/, 'the out-of-band rule survives in the hint');
  assert.match(sec, /the one the Backup card on <b>Your mineral<\/b> connects/, 'the setup hint points GitHub sign-in at the seat Backup card');
  assert.match(sec, /<p>What this mineral shares when it hosts a community\.<\/p>/, 'one-line sub-copy, role not edition');
  assert.ok(!/[—]/.test(sec), 'zero em dashes');
});

test('the loaders are un-gated: opening the Catalogue loads commons, inventory and pack authoring', () => {
  assert.match(html, /if \(name === 'publish'\) loadCatalogue\(\);/, 'a visit loads the inventory');
  assert.match(html, /if \(name === 'publish'\) loadPackAuthoring\(\);/, 'and the pack editor');
  assert.match(html, /if \(name === 'publish'\) loadCommons\(\);/, 'and the commons state');
  assert.ok(!sec.includes('orgsec'), 'the section carries no org-face class');
});

test('the inventory is one read: skill-list + pack-list + item-list, no policy read', () => {
  assert.match(js, /run\('skill-list', \{\}\), run\('pack-list', \{\}\)/, 'the two library verbs');
  assert.match(js, /run\('item-list', \{\}\)\.catch\(function\(\)\{ return ''; \}\)/,
    'item-list degrades to empty on an older image, not to an error');
  assert.ok(!js.includes('community-catalogs'), 'the hosted catalog fetch is gone');
  assert.match(js, /if \(!force && CAT\.loading\) return CAT\.loading;/, 'a load in flight is reused');
});

test('rows render in zones by kind, and an unknown kind still gets a zone', () => {
  for (const z of ['skill', 'prompt', 'page', 'dir', 'pack']) {
    assert.match(js, new RegExp(`\\['${z}',`), `zone ${z} declared`);
  }
  assert.match(js, /zone\('Other', 'Newer kinds this app does not have a name for yet\.',/,
    'a newer mineral’s items never silently vanish');
});

test('each row is read-only: title · kind or /id chip · version · description, nothing pressable but the bubble', () => {
  const row = js.slice(js.indexOf('function catRow('));
  assert.match(row, /<span class="nm">' \+ esc\(it\.title\)/, 'title');
  assert.match(row, /KIND_CHIP\[it\.kind\] \? esc\(KIND_CHIP\[it\.kind\]\) : '\/' \+ esc\(it\.id\)/,
    'only a skill is chipped /id: a prompt is not a command anyone can type');
  assert.match(row, /<span class="chip">v' \+ esc\(String\(it\.version/, 'version chip');
  assert.match(row, /warnchip">sends outbound/, 'an outbound skill is flagged');
  assert.match(row, /desc\.length > 150/, 'a long description folds into a bubble');
  assert.ok(!row.includes('catToggle') && !row.includes('Publish'), 'no toggle and no publish on the row');
});

test('the count strip counts per kind, from the same items the zones render', () => {
  const st = js.slice(js.indexOf('function renderCatState('), js.indexOf('function catRow('));
  assert.match(st, /'In your library'/, 'the total leads');
  assert.match(st, /byKind\[k\] = \(byKind\[k\] \|\| 0\) \+ 1;/, 'counts are per kind');
  assert.ok(!st.includes('Offered to someone') && !st.includes('Installed somewhere'),
    'the hosted-era cells are gone: a commons has no per-member ledger to count');
});

test('empty and populated states each render their own thing', () => {
  assert.match(js, /\$\('catEmpty'\)\.style\.display = CAT\.items\.length \? 'none' : 'block';/,
    'the empty message shows when there is nothing, not when there is something');
  assert.match(js, /\$\('catState'\)\.style\.display = CAT\.items\.length \? 'flex' : 'none';/,
    'and the count strip hides with it');
  assert.match(sec, /published to nobody until you set up a commons and press Publish/,
    'the empty state points at the commons, not at a retired surface');
  assert.match(sec, /\/write-skill/, 'and names the authoring route');
});

test('each live catalogue selector is defined exactly once in the sheet', () => {
  // The predecessor pinned everything into the iteration-2 CSS block; the
  // zones rebuild (delivery-model step 7) legitimately homed the zone rules
  // in the main sheet, so the survivable rule is single definition, wherever
  // it lives: a second copy is how the 2026-08-23 three-way merge hid itself.
  for (const sel of ['.catzone{', '.catrow{', '.catstate{']) {
    const first = html.indexOf(sel);
    assert.ok(first > 0, `${sel} exists`);
    assert.equal(html.indexOf(sel, first + 1), -1, `${sel} is defined only once`);
  }
});
