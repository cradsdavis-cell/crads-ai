// catalogue-page.test.mjs — the rock's Catalogue page (Sam, 2026-08-10;
// rewritten for panel iteration 2, 2026-08-23: R3, R4, R13, F2, R25).
//   node --test wizard/panel/catalogue-page.test.mjs
//
// Iteration 2 took the page down to ONE audience (your members), ONE control
// per skill per member (the offer toggle), and Publish ON THE ROW. What this
// file guards:
//   1. the retired surfaces stay retired (R3/R4/F2): no rock-to-rock push, no
//      vendor fold, no "Install for…" panel, no page-level sticky bar
//   2. the row anatomy: title · /id · version · description · member grid with
//      three states and an offer toggle · a per-row Publish + Undo
//   3. the dirty baseline does not alias its working copy, and comparison is
//      normalised (an empty chosen-list IS nobody)
//   4. publish writes the FULL policy, then reconciles, and a scrub refusal
//      renders its file:line hits under the row while keeping the draft
//   5. the count strip and empty state point the right way
//   6. R27: org form labels + chips are not uppercase
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERBS } from './panel-server.mjs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const sec = html.slice(html.indexOf('<section data-sec="publish"'), html.indexOf('</section>', html.indexOf('<section data-sec="publish"')));
const js = html.slice(html.indexOf('// ---- Catalogue (Sam, 2026-08-10'), html.indexOf('// ---- Progress steps + plain-words errors'));

// F2 + R4 + R3. Assert on CODE shapes (a verb call, an element id, a function
// definition), not on prose: the comments explaining the retirement are
// allowed to name what went.
test('R4/R3/F2: the page no longer calls the retired verbs or mounts the retired surfaces', () => {
  for (const verb of ['community-catalog-push', 'community-catalog-list', 'catalog-sync', 'skill-push']) {
    assert.ok(!html.includes(`run('${verb}'`), `member.html no longer runs ${verb}`);
    assert.ok(!html.includes(`'${verb}'`), `and does not name ${verb} as a string anywhere`);
  }
  for (const id of ['vendorRow', 'catTies', 'catSave', 'catSaveCtx', 'catPublish', 'catDiscard', 'catalogSyncBtn']) {
    assert.ok(!html.includes(`id="${id}"`), `#${id} is gone`);
    assert.ok(!html.includes(`$('${id}')`), `and nothing looks it up`);
  }
  assert.ok(!html.includes('catInstallPanel'), 'the Install-for panel is gone, name and all');
  assert.ok(!html.includes('CAT.dormant'), 'and the directory-dormant lock with it');
  assert.ok(!html.includes('class="stickysave"'), 'no page-level sticky bar');
  assert.ok(!/\.stickysave\{/.test(html), 'and its rule is retired');
  assert.ok(!html.includes("data-aud=\"comm\""), 'no tied-rock audience segment');
  assert.ok(!js.includes('catSeg('), 'the segmented control is gone with both audiences');
});

test('the page is one list of rows, with no page-level save', () => {
  assert.ok(sec.includes('id="catRows"'), 'one row list');
  assert.ok(sec.includes('id="catState"'), 'a count strip');
  assert.ok(sec.includes('id="catEmpty"'), 'an empty state');
  assert.ok(!sec.includes('listhead'), 'no list heading: the rows are the page');
  assert.match(sec, /<h2>Catalogue<button class="info"[^>]*data-tip="[^"]*not the same list as Skills/, 'the heading bubble draws the line from Skills');
  assert.match(sec, /<p>What this rock offers its members\.<\/p>/, 'one-line sub-copy');
  assert.ok(!/[—]/.test(sec), 'zero em dashes');
});

// R13: the row anatomy.
test('R13: each row carries title · /id · version · description · a member grid · Publish on the row', () => {
  const row = js.slice(js.indexOf('function catRow('), js.indexOf('function catScrubHits('));
  assert.match(row, /<span class="nm">' \+ esc\(it\.title\)/, 'title');
  assert.match(row, /'\/' \+ esc\(it\.id\)/, '/id chip');
  assert.match(row, /<span class="chip">v' \+ esc\(String\(it\.version/, 'version chip');
  assert.match(row, /desc\.length > 150/, 'a long description folds into a bubble');
  assert.match(row, /<div class="catgrid"><\/div>/, 'the member grid');
  assert.match(row, /line\.setAttribute\('data-member', x\.slug\)/, 'one line per live member');
  assert.match(row, /fleetNames\(x\.m, x\.y\)/, 'headed by the mineral’s live name, via the one naming helper');
  assert.match(row, /<span class="mono">' \+ esc\(x\.slug\)/, 'slug in mono');
  assert.match(row, /chip\.setAttribute\('data-state', st\)/, 'a state chip per member');
  assert.match(row, /catToggle\(on, /, 'and an offer toggle per member');
  assert.match(row, /'Offer \/' \+ it\.id \+ ' to everyone'/, 'an Everyone switch at the top of the grid');
  // publish lives on the row
  assert.match(row, /ctx\.textContent = 'Not published yet'/, 'a dirty row says so on the row');
  assert.match(row, /undo\.textContent = 'Undo'/, 'with Undo');
  assert.match(row, /go\.textContent = CAT\.busy\[it\.id\] \? 'Publishing…' : 'Publish'/, 'and Publish');
  assert.match(row, /go\.onclick = function\(\)\{ catPublishRow\(it\); \}/, 'wired to the per-row publisher');
});

test('R2/R13: the three states come from the receipt and the PUBLISHED policy, not the registry', () => {
  assert.match(js, /function catInstalled\(id, slug\)\{[\s\S]*?skills_from_rocks/, 'installed reads the heartbeat receipt');
  assert.match(js, /if \(catInstalled\(id, slug\)\) return 'installed';/, 'installed first');
  assert.match(js, /return catOffers\(CAT\.base\[id\], slug\) \? 'offered' : 'not offered';/, 'then offered / not offered from the published base');
  assert.ok(!js.includes('m.skills'), 'the registry’s pushed-skill lines are not read as installed');
  assert.match(js, /aud === 'all' \|\| \(Array\.isArray\(aud\) && aud\.indexOf\(slug\) >= 0\)/, 'audience all counts as offered');
});

test('the Everyone switch and the per-member rule from all', () => {
  assert.match(js, /CAT\.draft\[it\.id\] = draft === 'all' \? 'none' : 'all';/, 'Everyone on = all, off = nobody');
  const set = js.slice(js.indexOf('function catSetMember('), js.indexOf('function catRow('));
  assert.match(set, /cur === 'all' \? members\.map\(function\(x\)\{ return x\.slug; \}\)/, 'turning one member off from all = the explicit list minus that one');
  assert.match(set, /CAT\.draft\[id\] = catAud\(list\);/, 'and an emptied list normalises to nobody');
});

// Both of these produced a save line that lied. Aliasing made every edit report
// "no changes"; un-normalised comparison made an empty chosen-list a pending
// change against a base of 'none'.
test('the dirty baseline is honest: no aliasing, normalised comparison', () => {
  assert.match(js, /CAT\.base\[it\.id\] = catAud\(raw\); CAT\.draft\[it\.id\] = catAud\(raw\);/, 'baseline and working copy are two separate arrays');
  assert.match(js, /function catDirty\(id\)\{ return !catAudEq\(catAud\(CAT\.draft\[id\]\), catAud\(CAT\.base\[id\]\)\); \}/, 'dirtiness compares normal forms');
  assert.match(js, /a\.length \? a : 'none'/, 'an empty chosen-list normalises to nobody');
});

test('the unsaved-edits guard does not block its own post-publish reload', () => {
  assert.match(js, /function loadCatalogue\(force\)/, 'the reload takes a force flag');
  assert.match(js, /if \(!force && CAT\.loaded && catChanges\(\)\.length\)/, 'the guard respects it');
  assert.match(html, /if \(name === 'publish'\) loadCatalogue\(\);/, 'a plain visit does not force');
  // the two loaders prefetch each other; neither may recurse forever
  assert.match(js, /if \(CAT\.loading\) return CAT\.loading;/, 'a load in flight is reused');
  assert.match(html, /if \(!CAT\.loaded && !CAT\.loading\) loadCatalogue\(\);/, 'and the fleet prefetch checks it');
});

// Publish writes the WHOLE policy, keeps every id the page never saw, and
// reconciles in the same click. A scrub refusal (R25) leaves the draft in place
// and puts the file:line hits under the row.
test('publish = full policy write, then reconcile; a scrub refusal keeps the draft and shows the hits', () => {
  const w = js.slice(js.indexOf('function catWritePolicy('), js.indexOf('function catPublishRow('));
  assert.match(w, /Object\.keys\(CAT\.policyItems\)\.forEach\(function\(k\)\{ items\[k\] = CAT\.policyItems\[k\]; \}\);/, 'ids this page never saw are preserved');
  assert.match(w, /run\('catalog-policy-write', \{ content_b64: b64utf8\(payload\) \}/, 'writes the policy');
  assert.match(w, /run\('catalog-reconcile-run', \{\}/, 'then reconciles');
  assert.match(w, /hits: catScrubHits\(r\)/, 'a refused write reports the scrub hits');
  assert.match(js, /\/\^ERROR: \\\/\[a-z0-9-\]\+ cannot be published\/\.test\(l\) \|\| \/\^\\s\+\\S\+:\\d\+: \/\.test\(l\)/, 'hits = the header line + file:line lines, exactly what the verb prints');
  const pr = js.slice(js.indexOf('function catPublishRow('));
  assert.match(pr, /if \(res\.hits\.length\) \{ CAT\.hits\[it\.id\] = res\.hits; renderCatalogue\(\); return; \}/, 'the draft is kept and the row re-renders with the hits');
  assert.match(js, /err\.innerHTML = '<b>Not published\.<\/b>/, 'the row says it was not published');
  // the verb really prints those shapes
  const cmd = VERBS['catalog-policy-write'].build({ content_b64: 'e30=' }).command;
  assert.match(cmd, /skill-scrub\.mjs/, 'the verb scrubs before writing');
  assert.match(cmd, /ERROR: nothing was published/, 'and refuses whole');
});

test('the count strip reads library · offered to someone · installed somewhere', () => {
  const st = js.slice(js.indexOf('function renderCatState('), js.indexOf('function catToggle('));
  assert.match(st, /'In your library'/);
  assert.match(st, /'Offered to someone'/);
  assert.match(st, /'Installed somewhere'/);
  assert.ok(!st.includes('Tied rocks'), 'no tied-rock cell');
  assert.match(st, /catAud\(CAT\.base\[it\.id\]\)/, 'offered counts the PUBLISHED policy, never a draft');
});

test('empty and populated states each render their own thing', () => {
  assert.match(js, /\$\('catEmpty'\)\.style\.display = CAT\.items\.length \? 'none' : 'block';/,
    'the empty message shows when there is nothing, not when there is something');
  assert.match(js, /\$\('catState'\)\.style\.display = CAT\.items\.length \? 'flex' : 'none';/,
    'and the count strip hides with it');
  assert.match(sec, /offered to nobody until you say so/, 'the empty state is one sentence with one action');
  assert.ok(!sec.includes('pull the ones your rock has been granted'), 'and no longer points at the retired vendor fold');
});

// R27 (2026-08-23): the org face's form label and the chip lost
// text-transform:uppercase, so nothing a member reads is shouted.
test('R27: org form labels and chips are sentence case', () => {
  const formLabel = html.match(/\.orgsec label,\.orgonly label\{[^}]*\}/);
  assert.ok(formLabel, 'the org form-label rule exists');
  assert.ok(!formLabel[0].includes('text-transform:uppercase'), 'org form labels are sentence case');
  const chip = html.match(/\n  \.chip\{[^}]*\}/);
  assert.ok(chip && !chip[0].includes('text-transform:uppercase'), 'chips render as entered');
  assert.ok(!html.includes('.picker label{'), 'the old picker (and its uppercase reset) is gone with the segment');
});

test('all new CSS sits in the one iteration-2 block at the end of the main sheet', () => {
  const mark = html.indexOf('/* ===== iteration 2: catalogue / members ===== */');
  const end = html.indexOf('</style>', mark);
  assert.ok(mark > 0 && end > mark, 'the block exists and closes the main sheet');
  const block = html.slice(mark, end);
  for (const sel of ['.catgrid{', '.catline{', '.catpub{', '.caterr{', '.fcstate{', '.chip.st-active{', '.chip.st-quiet{']) {
    assert.ok(block.includes(sel), `${sel} lives in the block`);
    assert.equal(html.indexOf(sel), mark + block.indexOf(sel), `${sel} is defined nowhere earlier`);
  }
});
