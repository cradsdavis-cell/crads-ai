// rocks-page.test.mjs — the Rocks page carries the rocks (Sam, 2026-08-10).
//   node --test wizard/panel/rocks-page.test.mjs
//
// Why this file exists. The page named Rocks contained no rock. A tied rock was
// a name, a tie word and a Leave button; the pages it shared with its members
// lived behind a SEPARATE "Rock brain" nav tab; and its catalogue was merged
// away into the Skills page's "From your rocks" list with no per-rock grouping
// at all. Three surfaces, and the one you would go to first had the least on it.
//
// The rebuild: one page, one row per rock, each row opening onto that rock's own
// brain, catalogue and tie. What this file guards is the set of things that
// would fail QUIETLY if a later change undid them, which is why each assertion
// below is a claim about behaviour rather than about markup for its own sake:
//   1. the Rock brain tab cannot come back as a tab, by either route in
//   2. counts are omitted when unknown and never rendered as zero
//   3. an untied rock is offered counts and never content
//   4. the anchor is pinned first, because it is not a peer
//   5. the reader is reachable only through a rock, never by URL
//   6. the asks inbox kept its only console-answer caller when it moved
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const sec = html.slice(html.indexOf('<section data-sec="rocks">'), html.indexOf('<section data-sec="rockreader">'));
const fn = (name, next) => html.split('function ' + name + '(')[1].split('function ' + next + '(')[0];

test('one page: your rocks, then discovery, and no ask paperwork', () => {
  assert.ok(sec.includes('id="rockBanners"'), 'ended-tie notices stay at the top, the never-a-silent-cut ruling');
  assert.ok(sec.includes('id="rockMine"'), 'your rocks');
  assert.ok(sec.includes('id="rockRows"'), 'open rocks below them');
  // the two org cards left for Decisions; the outbound form was deleted outright
  assert.ok(!sec.includes('id="rqRows"'), 'the asks inbox is not on this page');
  assert.ok(!html.includes('id="askSend"'), 'and the outbound ask form is gone entirely');
  for (const dead of ['ask_kind', 'ask_to', 'ask_subject', 'ask_reframe', 'ask_late', 'askLog']) {
    assert.ok(!html.includes('id="' + dead + '"'), `${dead} went with it`);
  }
});

// The tab is the thing that must not return: its existence is what split a rock
// in half. Both entry points have to map, or a hashchange arrival strands on a
// section that no longer exists while a click-through works fine.
test('the Rock brain tab is gone and every old route lands on Rocks', () => {
  assert.ok(!html.includes('<section data-sec="rockbrain"'), 'no section');
  assert.ok(!html.includes('data-sec="rockbrain">'), 'no nav button');
  assert.match(html, /if \(name === 'rockbrain'\) name = 'rocks';/, 'activateSec maps it');
  assert.match(html, /if \(h === 'rockbrain'\) h = 'rocks';/, 'and so does secFromHash');
});

test('#rocks/<handle> opens one rock, and the open drawer survives a re-render', () => {
  assert.match(html, /if \(name\.indexOf\('rocks\/'\) === 0\) \{ rockWanted = name\.slice\('rocks\/'\.length\); name = 'rocks'; \}/,
    'activateSec splits the sub-part off');
  assert.match(html, /if \(h\.indexOf\('rocks\/'\) === 0\) return document\.querySelector\('#nav button\[data-sec="rocks"\]'\) \? h : '';/,
    'secFromHash checks it against the Rocks button and hands it on whole');
  const consume = fn('rockConsumeWanted', 'rbEnter');
  assert.match(consume, /var want = rockWanted; rockWanted = '';/,
    'the target is consumed once: a later render must not re-open a drawer the reader closed');
  // the roster re-renders on every tie change and every brain read, so an open
  // drawer that did not persist would slam shut under the reader's hands
  assert.match(html, /if \(rockOpenSt\[org\]\) row\.classList\.add\('open'\);/, 'open drawers repaint open');
});

// The load-bearing honesty rule on this page. A rock whose counts we do not know
// must read as unknown, never as empty: "0 skills" on a full catalogue is worse
// than silence, and it is exactly what a stale board would say before the
// directory Worker carrying the counts is deployed.
test('counts are omitted when unknown, never rendered as zero', () => {
  const line = fn('rockCountLine', 'rockRow');
  assert.match(line, /if \(typeof skills === 'number'\)/, 'skills render only when they are a number');
  assert.match(line, /if \(typeof pages === 'number'\)/, 'and so do pages');
  // (what makes a count null in the first place is pinned by the unread-source
  // test below, which is where the driving-found bug lives)
  assert.match(line, /listing && typeof listing\.skills === 'number' \? listing\.skills : null/,
    'an untied rock takes its counts from the listing, or nothing');
  // singular/plural, because "1 skills" is the tell that nobody read the copy
  assert.match(line, /skills === 1 \? ' skill' : ' skills'/, 'skills pluralise');
  assert.match(line, /pages === 1 \? ' shared page' : ' shared pages'/, 'pages pluralise');
});

// Both of these were found by DRIVING the page, not by reading it, and neither
// was visible to the assertions above. They share one cause: everything a
// drawer shows is tie-gated at the directory, so every source answers empty
// until a sign-in lands, and the page read them exactly once — before it.
test('an unread source is unknown, not empty: no count is derived from a fetch that has not answered', () => {
  const line = fn('rockCountLine', 'rockRow');
  // symptom was a rock with a full catalogue advertising itself as "0 skills"
  // for as long as the catalogue fetch took, on its own page. The count also
  // excludes packs (I3, 2026-08-25): a pack is not a skill, and counting it
  // in overstated the number by whatever bundles the rock also publishes.
  assert.match(line, /skills = rockCatLoaded\(\) \? rockCatOf\(org\)\.filter\(isSkillOffer\)\.length : null;/,
    'skills are null until a catalogue read has actually happened, and only skills count as skills');
  assert.match(line, /pages = !rockBrains \|\| rockBrains\.signedIn === false \? null :/,
    'pages are null while unread or refused');
  // ...but a read that DID happen and found nothing is a real zero, not unknown
  assert.match(line, /br \? \(br\.items \|\| \[\]\)\.length : 0;/,
    'a rock that genuinely shares nothing counts 0, which is different from unknown');
  const loaded = fn('rockCatLoaded', 'rockCountLine');
  assert.match(loaded, /return !!state\.communityCatalogs \|\| !!state\.catalog;/,
    'loaded means a source object exists, not that it has entries');
});

test('signing in re-reads what the directory refused before it', () => {
  const refresh = fn('rockMineRefresh', 'rockAsk');
  assert.match(refresh, /if \(j\.signedIn\) rockLoadSubstance\(\);/,
    'a landed sign-in re-reads the manifests and catalogues');
  const load = fn('rockLoadSubstance', 'rbEnter');
  assert.match(load, /fetch\('\/rock-brains'\)/, 'manifests');
  assert.match(load, /loadLibrary\(\);/, 'and catalogues');
  assert.match(fn('loadRocks', 'rockLoadSubstance'), /rockLoadSubstance\(\);/,
    'and the page load uses the same function, so the two paths cannot drift');
  // the catalogue fetch finishes on its own clock, so its render has to reach
  // the roster or the drawer stays empty until the page is re-entered
  assert.match(fn('renderLibrary', 'normEntryClient'),
    /if \(document\.querySelector\('section\[data-sec="rocks"\]\.active'\)\) rockRenderMine\(\);/,
    'a catalogue arriving repaints the roster, but only while it is on screen');
});

test('a tied row opens onto the rock; an untied row opens onto counts only', () => {
  const row = fn('rockRow', 'rockTieBlock');
  assert.match(row, /if \(tied\) \{ d\.appendChild\(rockBrainBlock\([\s\S]{0,60}rockCatBlock\(/, 'tied: brain + catalogue');
  assert.match(row, /else d\.appendChild\(rockJoinBlock\(org, listing\)\);/, 'untied: the join block instead');
  assert.match(row, /d\.appendChild\(rockTieBlock\(org, tie\)\);/, 'both carry the tie block');
  // R4 (iteration 2, 2026-08-23): the "Behind the door" browse of another
  // rock's catalogue is gone; the untied drawer is the join/anchor actions and
  // one line on what joining buys. Content stays tie-gated at the directory.
  const join = fn('rockJoinBlock', 'rockInstall');
  assert.match(join, /Join to get what they share with members/, 'the untied drawer says what joining buys');
  assert.ok(!/Behind the door/.test(join), 'and no longer browses the rock\'s catalogue');
  assert.ok(!/rockCountLine/.test(join), 'nor counts it');
  assert.ok(!/rbEnter/.test(join), 'and offers no way to read a page');
  assert.ok(!/rockInstall/.test(join), 'nor to install a skill');
});

// Found by photographing the page, not by running it. Both were invisible to
// every assertion in this file, which is the argument for taking the picture.
test('an open drawer wraps instead of crushing its own header', () => {
  // .cadrow is display:flex. An open .drawer is a width:100% block, so without
  // flex-wrap it becomes a sibling COLUMN: the header is squeezed to a few
  // characters wide and the drawer text runs over it. This exact defect has a
  // note against #skillsGroups in the stylesheet ("crushed their titles, caught
  // on camera") and recurred verbatim here the first time the page was shot.
  assert.match(html, /#rockMine \.cadrow,#rockRows \.cadrow\{cursor:pointer;flex-wrap:wrap\}/,
    'both rock row containers wrap');
});

test('one rock is one row: email-keyed ties do not render a rock once per pebble', () => {
  const mine = fn('rockRenderMine', 'rockConsumeWanted');
  // /rock-mine keys ties to the signed-in email, so an operator who owns two
  // pebbles both joined to one rock got two identical cards, each with a full
  // drawer. Dedupe is on org+tie, NOT org: two different ties to one rock is a
  // real distinction and must still render as two rows.
  assert.match(mine, /var k = m\.org \+ '::' \+ m\.tie;/, 'the key carries the tie, not just the rock');
  assert.match(mine, /if \(seenTie\[k\]\) \{ seenTie\[k\]\.minerals\.push/, 'and duplicates fold into the row that survives');
  // ONE ROW, EVERY NAME (2026-08-16, finding 152's siblings). The fold used to
  // `return false` on the duplicate, which dropped the second mineral's SLUG,
  // and the Leave button in that row is the one control that has to say which
  // mineral it acts on. Collapsing the row is still right (the drawer is the
  // rock's brain and catalogue, identical for both); collapsing the name was
  // not. The group rides on `minerals`, and rockTieBlock draws one Leave per
  // name. See rock-tie-names-the-mineral.test.mjs for the behavioural proof.
  assert.match(mine, /row\.minerals = \[String\(m\.slug \|\| ''\)\]/, 'the surviving row starts the group with its own name');
});

// A NUL byte reached this file as a separator literal on 2026-08-10. It was
// harmless to the browser and invisible in every diff, and it was caught only
// because a regex that should have matched did not. One assertion is cheaper
// than the next hour of that.
test('the page source carries no control characters', () => {
  // tab (09), newline (0A) and carriage return (0D) are the only ones legitimate
  // in source; everything else in the C0 range, DEL included, is corruption.
  const bad = html.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g);
  assert.equal(bad, null, `member.html carries ${bad ? bad.length : 0} control character(s)`);
});

test('the anchor is pinned first and marked, because it is not a peer', () => {
  const mine = fn('rockRenderMine', 'rockConsumeWanted');
  assert.match(mine, /a\.owner === 'org' \? 0 : a\.tie === 'anchored' \? 1 : 2/,
    'ownership then anchor then joined: the sort is explicit, not incidental');
  const row = fn('rockRow', 'rockTieBlock');
  assert.match(row, /row\.classList\.add\('anchorrock'\)/, 'and the anchor row is marked');
  assert.match(html, /#rockMine \.cadrow\.anchorrock\{/, 'with styling that actually exists');
});

// -------------------------------- the board follows the picker too (182)
//
// 180 partitioned Your rocks on the picked mineral and stopped at the fold.
// The Open-rocks subtraction still ran on the ACCOUNT's ties, so with jeff
// picked, a public rock only test-pebble-sam holds was listed above as held
// by another pebble AND missing from the board below: the one mineral with
// no tie had nowhere to join it, and the empty state claimed a freshly-listed
// rock had not appeared. Seen by Sam on build 1172, minutes after listing it.
test('a rock the PICKED mineral is tied to never appears under Open rocks', () => {
  const board = fn('rockRenderBoard', 'rockRenderMine');
  assert.match(board, /\.filter\(function\(c\)\{ return !tiedHere\[c\.org\]; \}\)/,
    'the board subtracts ties: a Join button on a rock you are in would refuse itself');
  assert.match(board, /if \(!s \|\| s === sel\) tiedHere\[t\.org\] = true;/,
    'but only the picked mineral\'s ties, plus any row that names no mineral (the 180 caution)');
  assert.match(board, /if \(rockLocalAnchor && rockLocalAnchor\.org\) tiedHere\[rockLocalAnchor\.org\] = true;/,
    'the mineral\'s own locally-recorded anchor hides its rock too');
  assert.match(board, /tiedHere = rockTieMap\(\);/,
    'the org face keeps the whole map: /rock-mine already narrows it to the rock\'s own rows');
  assert.match(board, /is already tied to every rock that has opened its door\./,
    'the tied-to-everything case has its own sentence, not a bare empty list');
  assert.match(board, /esc\(sel\) \+ ' is already tied/,
    'and on the member face that sentence names the mineral, because "you" is the ambiguity 169 died on');
});

// The reader replaced a tab, so it must not BE a tab: reachable from a rock,
// unreachable by URL. secFromHash only resolves names with a nav button, which
// is what enforces it — assert that rather than trusting it.
test('the reader is reached only through a rock', () => {
  assert.ok(html.includes('<section data-sec="rockreader">'), 'the section exists');
  assert.ok(!html.includes('data-sec="rockreader">\n') || !/<button[^>]*data-sec="rockreader"/.test(html),
    'but it has no nav button');
  assert.match(html, /var lit = name === 'rockreader' \? 'rocks' : name;/,
    'it lights the Rocks tab while open, so the sidebar does not go dark');
  const enter = fn('rbEnter', 'rbCur');
  assert.match(enter, /rb\.org = org;/, 'the caller always sets the rock: there is no picker to fall back on');
  assert.match(html, /\$\('rbBack'\)\.onclick = function\(\)\{ activateSec\('rocks'\); \};/, 'and back returns to the roster');
  assert.ok(!html.includes('id="rbPicker"'), 'the old rock picker is gone: the roster is the picker now');
});

test('a retracted page refreshes the manifest instead of calling a dead function', () => {
  const page = fn('rbPage', 'netPresence');
  assert.match(page, /if \(j && \/does not share\|no tie\/\.test\(String\(j\.error \|\| ''\)\)\) rbRefresh\(\);/,
    'mid-read retraction re-reads the manifests');
  const refresh = fn('rbRefresh', 'rbPage');
  assert.match(refresh, /rbRender\(\); rockRenderMine\(\);/,
    'and repaints the roster behind the reader, whose counts just changed');
});

// The move to Decisions is only safe because the inbox came WITH its answer
// path. console-answer has no other caller anywhere in the app: losing it would
// deadlock every arriving two-consent move, silently, until someone tried one.
test('the asks inbox moved to Decisions with its answer path intact', () => {
  const dec = html.slice(html.indexOf('<section data-sec="decisions"'), html.indexOf('<section data-sec="yourrock"'));
  assert.ok(dec.includes('id="rockAsksCard"'), 'the card is on Decisions');
  assert.ok(dec.includes('id="rqRows"'), 'with its rows');
  assert.ok(dec.includes('id="rqLog"'), 'and its log');
  const answers = (html.match(/run\('console-answer'/g) || []).length;
  assert.equal(answers, 1, 'exactly one console-answer caller exists, and it is this card');
  // the reconcilers ride console-state, so the loader had to follow the card
  assert.match(html, /if \(name === 'decisions'\) \{ loadJoinRequests\(\); loadPending\(\); loadRockState\(\); loadPlane\(\); \}/,
    'loadPlane fires on Decisions now');
  assert.ok(!/if \(name === 'rocks'\) loadPlane\(\);/.test(html), 'and no longer on Rocks');
});

test('the asks feed distinguishes a failed read from an empty one', () => {
  const render = html.split('function renderRocksOrg(')[1];
  assert.match(render, /if \(\$\('rqEmpty'\)\) \{ \$\('rqEmpty'\)\.style\.display = 'none'; \$\('rqEmpty'\)\.textContent = ''; \}/,
    'a successful read clears the error line: whatever it said is stale');
  assert.match(render, /attn\.asks = reqs\.length \+ handover\.length;/, 'and the count feeds the attention chip');
  const note = html.split('function planeFeedNote(')[1].split('function loadPlane(')[0];
  assert.match(note, /attn\.asks = 0;/, 'a failed read claims nothing is waiting');
  assert.match(note, /\$\('rockAsksCard'\)\.style\.display = 'none';/, 'and hides the card rather than showing an empty one');
  // the house rule: attnEmpty must not say "nothing is owed" over a refused read
  assert.match(html, /var asksErr = \$\('rqEmpty'\) && \$\('rqEmpty'\)\.style\.display !== 'none';/,
    'updateAttention treats a visible error line as a reason to stay quiet');
});

// ------------------------------------- the platform lane is not a rock (168)
//
// A standalone pebble is anchored to `crads-solo` (the Mountain's staging lane)
// and mirrors anchor `crads-ai`. Both are the platform itself, and both leaked
// onto rock-listing surfaces as if the member had tied to a community named
// "crads-solo". Four ways in, each pinned; the behavioural proof of the first
// lives in panel.test.mjs ("/rock-mine never lists the platform lane").
test('the platform lane never renders as a rock, on any of its ways in', () => {
  const src = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');
  assert.match(src, /const PLATFORM_LANES = new Set\(\['crads-solo', 'crads-ai'\]\);/,
    'the lanes are named once, beside the validation constants');
  const mineRoute = src.slice(src.indexOf("path === '/rock-mine'"), src.indexOf("path === '/rock-mine/refresh'"));
  assert.match(mineRoute, /!PLATFORM_LANES\.has\(String\(x\.org \|\| ''\)\.toLowerCase\(\)\)/,
    'the Rocks page list drops them, while st.edges keeps them for the wiring machinery');
  const sync = src.slice(src.indexOf('const syncTiesToBox'), src.indexOf('const syncTiesToAll'));
  assert.match(sync, /PLATFORM_LANES\.has/, 'they never ride ties.json down to a box');
  const wf = src.slice(src.indexOf('function worldFacts'), src.indexOf('async function topologyWorld'));
  assert.match(wf, /PLATFORM_LANES\.has\(key\.toLowerCase\(\)\)/,
    'and the map reader holds the rule too: E2 forbids clearing a ties.json written before it');
  const note = fn('rockNoteAnchor', 'rockTieMap');
  assert.match(note, /if \(slug === 'crads-ai' \|\| slug === 'crads-solo'\) \{ rockLocalAnchor = null; return; \}/,
    'a mineral anchored to the Mountain has no rock above it, as rockNoteAnchor always claimed');
});

// ------------------------------- whose tie is this? say so on the face (169)
//
// /rock-mine keys ties to the signed-in EMAIL. With two pebbles on one account
// the page draws ties held by a mineral OTHER than the one picked in the
// header, and a card that does not say whose tie it is reads as "this pebble
// is anchored twice" — observed live on 2026-08-17, a fresh solo pebble
// apparently ANCHORED to a rock only a QA pebble had ever touched.
test('with more than one mineral on the account, every tie card names its holder', () => {
  const mine = fn('rockRenderMine', 'rockConsumeWanted');
  assert.match(mine, /rockManyMinerals = Object\.keys\(ownedNames\)\.length > 1;/,
    'the flag counts distinct minerals, not rows');
  assert.match(mine, /\(state\.targets \|\| \[\]\)\.forEach/,
    'connected minerals count even before they hold a tie');
  const row = fn('rockRow', 'rockTieBlock');
  assert.match(row, /rockManyMinerals \? \(tie\.minerals \|\| \[\]\)\.filter\(Boolean\) : \[\]/,
    'names draw only when there is a second mineral to confuse with');
  assert.match(row, /'your pebbles: ' : 'your pebble: '/, 'and pluralise');
});

// --------------------------- the roster follows the picker (180, then 200)
//
// 169's fix named the holder on the card and stopped there. The page header
// says "Connected to your mineral: jeff"; every other section is scoped to
// that pick; Rocks still opened with a rock jeff holds no tie to, because the
// account's edges all rendered in one list. Seen by Sam on build 1169, on the
// very screen 169 was meant to fix. 180 first moved the other minerals' ties
// under a "Held by your other pebbles" heading; Sam read that as a second
// confusing roster (finding 200, 2026-08-17), so the scope is now total:
// another mineral's tie does not draw here at all. It renders when that
// mineral is picked, and a rock's own memberships render on the rock face
// (Organisations + the Network map, finding 201).
test('the roster follows the picker: another pebble\'s tie never draws on this page', () => {
  const mine = fn('rockRenderMine', 'rockConsumeWanted');
  assert.match(mine, /names\.indexOf\(selSlug\) >= 0;/,
    'ties filter on the picked mineral');
  assert.match(mine, /m\.local \|\| !names\.length \|\|/,
    'the mineral\'s own recorded anchor and a row that names nobody stay in the list');
  assert.ok(!/Held by your other pebbles/.test(mine),
    'the second roster is gone (finding 200): other minerals\' ties are not drawn at all');
  assert.match(mine, /is not tied to any rocks\. You own your pebble/,
    'and the empty state names the picked mineral instead of saying "you"');
  assert.ok(mine.indexOf('if (!IS_ORG) {') < mine.indexOf('held.forEach(draw)'),
    'the org face keeps its single list: /rock-mine already narrows it to the rock\'s own rows');
});

// ----------------------------------------------- a rock cannot join itself
//
// Sam, 2026-08-10: "a rock shouldn't be able to join itself". Guarded at the
// worker (the boundary) AND here (the surface that can explain it in the same
// breath, and that ships without a worker deploy).
test('the tie proxy refuses this rock its own handle, before any network call', async () => {
  const { createPanelServer } = await import('./panel-server.mjs');
  const src = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');
  const proxy = src.slice(src.indexOf("const slug = t.host.replace(/-(box|rock)$/, '');"));
  const guard = proxy.slice(0, proxy.indexOf('communityFetcher'));
  assert.match(guard, /if \(org === slug\)/, 'the self case is refused');
  assert.match(guard, /cannot join itself/i, 'and said in words');
  assert.ok(guard.indexOf('if (org === slug)') < guard.length, 'before the fetch that would ask the directory');
  assert.ok(typeof createPanelServer === 'function');
});

// -------------------------------- nor is it its own member (finding 202)
//
// Refusing the ASK was only half of "a rock cannot join itself". Sam, on
// qa-r2-gmail, 2026-08-17: the rock's Organisations page drew the rock itself
// under "Your rocks" with a JOINED chip, directly beneath the sentence saying
// these are the ones this rock has joined. The row was real: the operator's own
// admin membership of their own org comes back from /edges as {org:
// qa-r2-gmail, slug: qa-r2-gmail, rel: joined}, and the org face narrowed on
// the SLUG alone ("is this the rock's edge or the operator's pebble's"), never
// on the org at the other end. One-mineral-one-name makes those two strings
// identical on a rock, so the org has to be excluded explicitly.
//
// Both readers of these edges are pinned. The Network map (finding 201, the day
// before) copied the narrowing verbatim and inherited the same self-row.
test('a rock never renders as a community it has joined, on either reader of its edges', () => {
  const src = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');
  const mineRoute = src.slice(src.indexOf("path === '/rock-mine'"), src.indexOf("path === '/rock-mine/refresh'"));
  // The self-row's signature is org === slug (one-mineral-one-name), and THAT
  // is the exclusion — not "org is any rock this machine drives". The broad
  // version erased a real tie on a machine wired to both of its ends
  // (2026-08-18, flat-earth-society-of-america → qa-r2-gmail: A's page said
  // nothing joined, B's page showed A, the directory held the edge throughout).
  assert.match(mineRoute, /faceSlugs\.includes\(String\(x\.slug \|\| ''\)\)\s*\n\s*&& String\(x\.org \|\| ''\) !== String\(x\.slug \|\| ''\)/,
    'Your rocks excludes exactly the self-row and keeps the slug test that scopes to the rock');
  assert.ok(!/!slugs\.includes\(String\(x\.org \|\| ''\)\)/.test(mineRoute),
    'the machine-wide org exclusion is gone: driving both ends of a tie must not erase it');
  const map = src.slice(src.indexOf('const joinedRocks ='), src.indexOf('ok: true, rock: true,'));
  assert.match(map, /String\(x\.slug \|\| ''\) === orgSlug/, 'the map still scopes to this rock\'s own rows');
  assert.match(map, /String\(x\.org \|\| ''\) !== orgSlug/, 'and never hangs the rock off itself');
});

// ------------------- the Organisations page asks as ONE face (2026-08-18)
//
// /rock-mine serves every rock wired on the machine, and the org face used to
// take the union. Fine with one rock per machine, wrong the day one laptop
// drives two: rows must belong to the face that is asking, or A's tie renders
// on B's page (finding 202's symptom, resurrected by the very machine shape QA
// uses). The page names its face (?host=) and the route honours it — the same
// per-face scoping orgTopologyWorld has carried since finding 201.
test('the org face scopes /rock-mine to the asking face, like the map always did', () => {
  const src = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');
  const mineRoute = src.slice(src.indexOf("path === '/rock-mine'"), src.indexOf("path === '/rock-mine/refresh'"));
  assert.match(mineRoute, /url\.searchParams\.get\('host'\)/, 'the route reads which face is asking');
  assert.match(mineRoute, /const faceSlugs = \(face \? \[face\] : targetsR\)/,
    'a named face narrows to itself; no face keeps the old union for aggregate callers');
  const page = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
  assert.ok(page.includes("'/rock-mine' + (state.host ? '?host=' + encodeURIComponent(state.host) : '')"),
    'the Organisations page sends its face on both reads (load and the sign-in poll)');
});
