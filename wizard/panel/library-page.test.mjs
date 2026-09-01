// library-page.test.mjs — P4 of the skills/cadence/library spec (2026-08-04):
// the catalog verbs (member + org) and the Library page wiring.
//   node --test wizard/panel/library-page.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MEMBER_VERBS, VERBS } from './panel-server.mjs';

const memberHtml = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const orgHtml = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

// ---- member verbs -------------------------------------------------------------

test('catalog-list reads only what this box already holds (the entitled view)', () => {
  const cmd = MEMBER_VERBS['catalog-list'].build().command;
  assert.match(cmd, /org-inbox\/catalog\/catalog\.json/, 'the rock materialised this member view; no cross-box read');
  // F3 (panel iteration 2, 2026-08-23): the request queue nothing writes is no
  // longer read either, so the "installing…" chip has no source and is gone.
  assert.ok(!/catalog-requests\.json/.test(cmd), 'no request queue');
  assert.match(cmd, /skills-list\.mjs/, 'installed state joins from the same enumerator as the Skills page');
  assert.ok(!MEMBER_VERBS['catalog-list'].mutating);
});

// ONE INBOX (2026-08-17): this pinned the request round trip — queue in
// catalog-requests.json, fire a heartbeat, wait for the rock's
// requests-reconcile to push the package back. Pickup is local now (spec § 5):
// catalog-reconcile materialises the whole package into the inbox, and
// installing copies it out. Full coverage of the new contract, including the
// refusals it inherits, lives in one-inbox-pickup.test.mjs; what stays here is
// the shape this page depends on.
test('catalog-install installs from the staged inbox, with no round trip', () => {
  assert.equal(MEMBER_VERBS['catalog-install'].mutating, true);
  for (const evil of ['../up', 'X Y', '', 'a'.repeat(64)]) {
    assert.throws(() => MEMBER_VERBS['catalog-install'].build({ id: evil }), /kebab-case/);
  }
  const cmd = MEMBER_VERBS['catalog-install'].build({ id: 'deep-research' }).command;
  assert.match(cmd, /org-inbox\/skills\/deep-research/, 'copied out of staging');
  assert.match(cmd, /is not in your inbox/, 'an unoffered id still refuses box-side');
  assert.ok(!/catalog-requests\.json/.test(cmd) && !/heartbeat/.test(cmd), 'the round trip is gone');
});

// ---- org verbs ------------------------------------------------------------------

test('catalog policy verbs: read is open, write and reconcile are admin-only', () => {
  assert.ok(!VERBS['catalog-policy'].mutating);
  assert.equal(VERBS['catalog-policy-write'].adminOnly, true, 'Support must not edit entitlement (stamp-member lesson)');
  assert.equal(VERBS['catalog-policy-write'].mutating, true);
  assert.equal(VERBS['catalog-reconcile-run'].adminOnly, true);
  const w = VERBS['catalog-policy-write'].build({ content_b64: Buffer.from('{"items":{}}').toString('base64') });
  assert.match(w.command, /JSON\.parse/, 'validated as JSON box-side before it replaces the policy');
  assert.match(w.command, /catalog\/policy\.json/);
  const r = VERBS['catalog-reconcile-run'].build().command;
  assert.match(r, /catalog-reconcile\.mjs/, 'rebuilds member views');
  assert.ok(!/catalog-requests-reconcile\.mjs/.test(r), 'F3: the retired request applier is not called');
});

test('the member edition gains no org catalog powers', () => {
  assert.ok(!MEMBER_VERBS['catalog-policy-write'], 'entitlement is the rock’s dial');
  assert.ok(!MEMBER_VERBS['catalog-reconcile-run']);
});

// ---- member.html wiring -----------------------------------------------------------

// 2026-08-10: R12 merged the Library into Skills, and an IS_ORG early return
// before the catalog-list dial once emptied the rocks tab on every rock. The
// face collapse (2026-09-01) removed the last way that class of bug can come
// back: there is no edition to gate on, and the /community-catalogs shop
// window (the Organisations page's read of rocks not yet joined) went with
// the page and the route. loadLibrary keeps exactly one source.
test('loadLibrary dials catalog-list alone: no edition gate, no shop-window fetch', () => {
  const fn = memberHtml.split('function loadLibrary(')[1].split('function renderLibrary()')[0];
  assert.ok(fn.indexOf("run('catalog-list'") >= 0, 'the inbox catalogue is dialled');
  assert.ok(fn.indexOf("fetch('/community-catalogs')") < 0, 'the shop-window fetch is gone with the Organisations page');
  assert.ok(!memberHtml.includes("fetch('/community-catalogs')"), 'and nothing else fetches it either');
  assert.ok(!/if \(IS_ORG\)/.test(fn), 'no edition gate: there is no edition');
});

// Trap 23 (2026-08-10): loadLibrary cleared the notice on entry, so a verb that
// wrote its own outcome and THEN reloaded had the words wiped in the same tick.
// The row flipped to "installed" in silence and nothing went red. The DRIVEN pin
// is in qa-org-skills.test.mjs, which the default suite command excludes (trap
// 15), so the contract is pinned here too, where it always runs.
test('a reload a verb triggers preserves the confirmation that verb just wrote', () => {
  const lib = memberHtml.split('function loadLibrary(')[1].split('function renderLibrary()')[0];
  assert.match(lib, /if \(!keep\) notice\('libraryNotice', ''\);/,
    'loadLibrary clears the notice only when this is not a verb’s own refresh');
  const skills = memberHtml.split('function loadSkills(')[1].split('function skTitle(')[0];
  assert.match(skills, /if \(!keep\) notice\('skillsNotice', ''\);/, 'loadSkills honours the same flag');

  // The install handler: write the outcome, then tell the reload to keep it.
  // Order is asserted because the old code was correct only by accident of it.
  // The face collapse (2026-09-01) took the Organisations page's catalogue
  // block with it, so rockInstall has two callers now: the offers row on
  // Skills and the Update button on an installed row. One function, one
  // sequence, still no bare reload.
  const inst = memberHtml.split('function rockInstall(')[1].split('function rockRemove(')[0];
  assert.match(inst, /notice\(noticeId, outLines\(rr\)\.slice\(-2\)\.join\('\\n'\)\);\s*loadLibrary\(true\);/,
    'the install keeps its confirmation through the reload');
  assert.ok(!/loadLibrary\(\);|loadSkills\(\);/.test(inst),
    'no bare reload inside the install handler: it follows a notice it must not eat');

  // and both callers still route through it, or the extraction just moved the
  // duplication somewhere the assertion above cannot see
  const row = memberHtml.split('function libRow(')[1].split('function loadLibrary(')[0];
  assert.match(row, /rockInstall\(l, btn, 'libraryNotice'\)/, 'the Skills offers row calls it');
  assert.match(memberHtml, /rockInstall\(newer, updBtn, 'skillsNotice'\)/, 'and so does the Update button, with its own notice target');
  // the retired verb survives in one explanatory comment, so the pin is on
  // the call shape, not the raw name
  assert.ok(!memberHtml.includes("run('community-skill-apply'"), 'no caller keeps a private copy of the install');
});

// R6 (2026-08-09 audit): the Library page folded into Skills. The catalogue
// (the "From your rocks" skill-offers group) still renders below the
// member's own skills, and its loader still rides loadSkills. What CHANGED
// (2026-08-26, step 7a): a member-facing page named Library exists again,
// reclaimed for a different purpose (Pages/Prompts/Files, not this
// catalogue), so the old "no Library section at all" and "#library lands on
// Skills" assertions no longer hold. Skills keeps the skill catalogue this
// test is about; only the NAME "library" moved to a new page.
test('the skill catalogue still lives inside the Skills page as a second group with honest empty states', () => {
  const skills = memberHtml.slice(memberHtml.indexOf('<section data-sec="skills">'), memberHtml.indexOf('</section>', memberHtml.indexOf('<section data-sec="skills">')));
  // Panel iteration 2 (R11/R12, 2026-08-23): the three filter tabs of S7b are
  // GONE. Two groups on one page: "On this mineral" then "From your rocks",
  // one subsection per rock. The sectioned library container stays gone too.
  assert.ok(!skills.includes('id="skillsTabs"'), 'no tab strip in the Skills section');
  assert.ok(!skills.includes('data-tab='), 'no tab buttons at all');
  assert.ok(skills.includes('id="skillsGroups"'), 'one container carries both groups');
  assert.ok(skills.includes('id="libraryNotice"'), 'install outcomes still have a notice');
  assert.ok(!skills.includes('id="libraryGroups"'), 'the sectioned library container is gone');
  assert.match(memberHtml, /if \(name === 'cadence'\) name = 'skills';/, 'cadence still rewrites to Skills (activateSec)');
  assert.match(memberHtml, /if \(h === 'cadence'\) h = 'skills';/, 'cadence still rewrites to Skills (hashchange)');
  assert.doesNotMatch(memberHtml, /'cadence' \|\| name === 'library'/, 'library no longer piggybacks on the cadence rewrite (activateSec)');
  assert.doesNotMatch(memberHtml, /'cadence' \|\| h === 'library'/, 'library no longer piggybacks on the cadence rewrite (hashchange)');
  assert.match(memberHtml, /<section data-sec="library">/, 'library is its own section again, reclaimed for Pages/Prompts/Files');
  const loader = memberHtml.split('function loadSkills(')[1].split('function loadLibraryPage(')[0];
  assert.match(loader, /loadLibrary\(keep\);/, 'the catalogue loads with the page, passing the preserve flag through');
  assert.doesNotMatch(loader, /loadPrompts\(\)|loadFiles\(\)/, 'Prompts and Files no longer load with Skills: they moved to Library (step 7a)');
  // The group renamed with the face collapse (2026-09-01): communities, not
  // rocks, and the unattached state points at the Communities page.
  assert.match(memberHtml, /'From your communities'/, 'group 2 is headed From your communities');
  assert.match(memberHtml, /g2\.setAttribute\('data-group', 'rocks'\)/, 'the structural hook keeps its old name for the shots rig');
  assert.match(memberHtml, /Your communities haven’t published anything yet\./, 'attached-but-empty state');
  assert.match(memberHtml, /No community yet\./, 'unattached state');
  assert.match(memberHtml, /Join one on the Communities page/, 'and it points at the Communities page');
  // F3: the catalog-requests residue is gone, and with it the chip that read it
  assert.doesNotMatch(memberHtml, /installing…/, 'no pending-request chip: pickup is local and instant');
  assert.doesNotMatch(memberHtml, /pendingBy/, 'and no reader of catalog-requests in the row');
  assert.match(memberHtml, /installing never needs a further approval/, 'publish-is-the-consent stated to the member');
});

// Rewritten 2026-08-17 (one-inbox): this pinned the MERGE, where joined rocks'
// community listings were folded into the same tabbed list as the anchor's
// entitled catalogue. There is one source now. Every rock a box is tied to
// writes into that box's own inbox, so catalog-list already carries all of them
// and merging the shop window back in would render every row twice.
test('the rocks group reads the inbox alone, grouped per rock, provenance still a drawer chip', () => {
  const fn = memberHtml.split('function libEntries()')[1].split('function renderSkills()')[0];
  assert.match(fn, /state\.catalog/, 'the one source is the staged inbox');
  assert.doesNotMatch(fn, /communityCatalogs/, 'the shop window is not merged in');
  assert.doesNotMatch(fn, /community: true/, 'and no row is tagged as arriving another way');
  const lib = memberHtml.split('function libRow(')[1].split('function renderLibrary()')[0];
  assert.match(lib, /from ' \+ esc\(l\.rock/, 'provenance still renders as a chip in the drawer');
  // R12 (panel iteration 2): ONE subsection per rock is the rule now, read
  // from the item's own rock (falling back to the catalogue's / the anchor's)
  assert.match(fn, /it\.rock \|\| rock/, 'an item names its rock when the inbox holds more than one');
  const render = memberHtml.split('function renderSkills()')[1].split('function skillRow(')[0];
  assert.match(render, /'From ' \+ rock/, 'a subsection header per rock');
  assert.match(render, /Nothing new from ' \+ rock/, 'with its own empty copy');
});

// Rewritten 2026-08-25 (I3/I4, review round 3). The old version of this test
// pinned libRow's pack branch by grepping its source text, which passed
// whether or not that branch could ever actually run. It cannot: libEntries()
// includes packs, but renderSkills's libs.forEach (I2) filters every pack out
// BEFORE it reaches byRock, so libRow (and offerInstalled's pack branch,
// called only from inside that same loop) never sees one in practice. The one
// surface that DOES still render a pack row unfiltered is rockCatBlock on the
// Organisations page (I3); that row used to hand the pack to rockInstall,
// which calls catalog-install with no kind and can only ever fulfil a skill,
// so the click was guaranteed to fail. The fix keeps the pack visible
// (informational: what it ships, what it costs) and removes the action
// (I4's ruling): a member should see a pack exists without being offered a
// button that cannot work.
test('I3/I4 are RETIRED with the Organisations page; the allow-list that outlived them still guards the offers loop', () => {
  // rockCatBlock, rockJoinBlock and rockCountLine rendered a rock's catalogue
  // on the Organisations page, and I3/I4 were about never wiring an Install
  // click that catalog-install (no kind) was guaranteed to refuse. The page
  // and its blocks left with the face collapse (2026-09-01), so the pin is
  // that they stay gone. What SURVIVES of the lesson is the isSkillOffer
  // allow-list in the Skills offers loop, which is the one place a non-skill
  // offer could still be handed a doomed install button.
  for (const gone of ['rockCatBlock', 'rockJoinBlock', 'rockCountLine', 'rockRenderBoard', 'rockHasAnchor']) {
    assert.ok(!memberHtml.includes(gone), `${gone} stays out of the shell`);
  }
  assert.match(memberHtml, /if \(!isSkillOffer\(l\.it\)\) return;/, 'the offers loop still skips every non-skill kind');
});

test('libRow\'s pack branch is dead code: renderSkills filters packs out before any row reaches it (I4)', () => {
  // libEntries() carries every catalogue item, packs included...
  const entries = memberHtml.split('function libEntries()')[1].split('function offerInstalled(')[0];
  assert.doesNotMatch(entries, /kind === 'pack'/, 'libEntries does not filter: packs are still in the list it returns');
  // ...but renderSkills's group-2 loop registers the rock subsection and THEN
  // returns on a pack, before that item is ever pushed into byRock, which is
  // the only thing libRow's caller iterates.
  const skillsLoop = memberHtml.split('// ---- group 2: From your rocks')[1].split('order.forEach(function(rock)')[0];
  assert.match(skillsLoop, /if \(!byRock\[l\.rock\]\)/, 'the rock subsection is registered first (I2)');
  assert.match(skillsLoop, /if \(!isSkillOffer\(l\.it\)\) return;/, 'then anything that is not a skill is skipped before it can reach byRock');
  const pushLine = skillsLoop.split(/if \(!isSkillOffer\(l\.it\)\) return;/)[1];
  assert.match(pushLine, /byRock\[l\.rock\]\.push\(l\)/, 'the only push into byRock happens after that check, so it never fires for a pack or a page');
  // Which means libRow (rows.forEach(function(l){ box.appendChild(libRow(l)); }))
  // and offerInstalled's own pack branch, called only from inside this same
  // loop, are unreachable from every live surface. They stay in the source
  // (deleting them is a separate cleanup) but this test pins THAT fact,
  // rather than pinning a source-text grep of dead code as if it were live.
  const libRowFn = memberHtml.split('function libRow(')[1].split('function renderLibrary()')[0];
  assert.match(libRowFn, /isPack = it\.kind === 'pack'/, 'the dead branch is still present in source, unreached');
});

test('the Catalogue lists v2 packs in the one row list', () => {
  assert.ok(VERBS['pack-list'] && !VERBS['pack-list'].mutating, 'pack-list is a read-only verb');
  assert.match(orgHtml, /pit\.kind = 'pack';/, 'packs are merged into the one row list');
  assert.match(orgHtml, /KIND_CHIP = \{ pack: 'pack',/, 'pack rows are chipped by kind, not as /commands');
  // The tied-rock audience retired in panel iteration 2 (R4, 2026-08-23), so
  // the "bundles cannot be listed for tied rocks" refusal went with it: a pack
  // ships in the commons exactly like a skill.
  assert.ok(!orgHtml.includes('Bundles cannot be listed for tied rocks'), 'no tied-rock refusal survives');
});

// ---- the audience machinery ------------------------------------------------

// Rewritten 2026-08-10, again for panel iteration 2 (R13), and RETIRED with
// the face collapse (2026-09-01). The member audience, the offer toggles and
// the write-then-reconcile flow all presumed a rock deciding per member what
// to publish; in the commons model membership is the entitlement and a
// publish ships the library whole, so the page has nothing per-member to
// write. catalogue-page.test.mjs pins the read-only inventory that replaced
// it; this pin holds that the policy legs stay gone from the shell.
test('the member-audience machinery is RETIRED: no policy write reachable from the page', () => {
  assert.ok(!orgHtml.includes('catSetMember'), 'no per-member offer writer');
  assert.ok(!orgHtml.includes("run('catalog-policy-write'"), 'the page never writes the policy');
  assert.ok(!orgHtml.includes("run('catalog-reconcile-run'"), 'nor reconciles one');
  assert.ok(!orgHtml.includes('slugs, comma-separated'), 'the slug textbox stays gone');
  assert.ok(!orgHtml.includes("label: 'Chosen'"), 'and the segmented control with it');
});
