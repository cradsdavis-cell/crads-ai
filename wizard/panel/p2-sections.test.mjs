// p2-sections.test.mjs: the Skills page reads as four zones (spec 2026-08-25 § 5.4,
// as amended: GROUPS, not tabs. Panel iteration 2 removed this page's tabs on
// 2026-08-23 and Sam ruled that direction governs).
//   node --test wizard/panel/p2-sections.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(path.join(HERE, 'member.html'), 'utf8');
const SKILLS = HTML.slice(HTML.indexOf('<section data-sec="skills">'), HTML.indexOf('</section>', HTML.indexOf('<section data-sec="skills">')));
// Pages/Prompts/Files moved off Skills onto their own Library page 2026-08-26
// (step 7a, delivery-model spec § 7). Tests that assert those zones' presence
// and ordering now read LIBRARY instead of SKILLS; tests that assert function
// bodies (loaders, renderers) are unaffected by where the markup lives.
const LIBRARY = HTML.slice(HTML.indexOf('<section data-sec="library">'), HTML.indexOf('</section>', HTML.indexOf('<section data-sec="library">')));

test('the Files section exists with the page group idiom, on the Library page', () => {
  assert.match(LIBRARY, /<h3 class="subhead zonegap">Files/, 'Files is a group heading, like Prompts');
  assert.match(LIBRARY, /id="filesNotice"/);
  assert.match(LIBRARY, /id="filesEmpty"/);
  assert.match(LIBRARY, /id="filesInstalled"/);
  assert.match(LIBRARY, /id="filesOffered"/);
});

test('the Skills section no longer contains Pages, Prompts or Files (step 7a)', () => {
  for (const id of ['pagesNotice', 'pagesEmpty', 'pagesListSection', 'pagesOffered',
                     'promptsNotice', 'promptsEmpty', 'promptsList',
                     'filesNotice', 'filesEmpty', 'filesInstalled', 'filesOffered']) {
    assert.ok(!SKILLS.includes(`id="${id}"`), `${id} moved off Skills`);
  }
  for (const h of ['Pages', 'Prompts', 'Files']) {
    assert.ok(!SKILLS.includes(`>${h}<button`), `the ${h} heading moved off Skills`);
  }
  // What stays: the cadence gate, the two skill groups, libraryNotice (the
  // skill-offers notice, unrelated to the Library page despite the name) and
  // the skill reader modal.
  for (const id of ['skillsGroups', 'skillsEmpty', 'cadenceSave', 'skillsNotice', 'libraryNotice', 'skReader']) {
    assert.ok(SKILLS.includes(`id="${id}"`), `${id} stays on Skills`);
  }
});

test('no tab markup is revived: the 23 Aug grouping ruling stands', () => {
  assert.ok(!/class="stabs"/.test(HTML), 'no .stabs container anywhere');
  assert.ok(!/class="stab[ "]/.test(HTML), 'no .stab buttons anywhere');
});

test('loadPrompts and loadFiles are wired into loadLibraryPage, not loadSkills (step 7a)', () => {
  assert.match(HTML, /function loadFiles/);
  assert.match(HTML, /function loadLibraryPage/);
  const loadSkills = HTML.slice(HTML.indexOf('function loadSkills'), HTML.indexOf('function loadLibraryPage'));
  assert.doesNotMatch(loadSkills, /loadPrompts\(\)/, 'Prompts no longer loads with Skills');
  assert.doesNotMatch(loadSkills, /loadFiles\(\)/, 'Files no longer loads with Skills');
  assert.match(loadSkills, /loadLibrary\(keep\);/, 'Skills still loads the catalogue itself: it feeds the From your rocks skill offers and sets state.catalog');
  const loadLibraryPage = HTML.slice(HTML.indexOf('function loadLibraryPage'), HTML.indexOf('function loadLibraryPage') + 500);
  assert.match(loadLibraryPage, /loadLibrary\(keep\);/, 'Library also loads the catalogue: see the state.catalog test below');
  assert.match(loadLibraryPage, /loadPrompts\(\);/);
  assert.match(loadLibraryPage, /loadFiles\(\);/);
});

test('opening Library does not depend on having opened Skills first: it fetches its own catalogue', () => {
  // The Files and Pages Offered halves both read state.catalog, which
  // loadLibrary sets. Before step 7a, loadLibrary only ran as part of
  // loadSkills, so a member who opened Library (or, pre-7a, Skills' own
  // Pages/Prompts/Files zones) without visiting Skills first would never see
  // an offer. The activateSec branch for 'library' must trigger a load path
  // that reaches loadLibrary, not just loadPrompts/loadFiles.
  const activate = HTML.slice(HTML.indexOf('function activateSec'), HTML.indexOf('function activateSec') + 4000);
  const libLine = activate.match(/if \(name === 'library'[^\n]*loadLibraryPage\(\); ?\}/);
  assert.ok(libLine, 'activateSec calls loadLibraryPage when the Library section opens');
  const loadLibraryPage = HTML.slice(HTML.indexOf('function loadLibraryPage'), HTML.indexOf('function loadLibraryPage') + 500);
  assert.match(loadLibraryPage, /loadLibrary\(/, 'loadLibraryPage itself calls loadLibrary, so the catalogue is fetched even on a first-ever visit to Library');
});

test('Files reads LIBRARY_STATE and distinguishes dormant, error and empty', () => {
  const fn = HTML.slice(HTML.indexOf('function loadFiles'), HTML.indexOf('function loadFiles') + 4000);
  assert.match(fn, /LIBRARY_STATE/);
  assert.match(fn, /dormant/);
  assert.match(fn, /\.error/, 'a read failure is not rendered as an empty library');
});

test('Files installs and removes through the phase-2 verbs, adds no new mutating verb', () => {
  const fn = HTML.slice(HTML.indexOf('function loadFiles'), HTML.indexOf('function loadFiles') + 6000);
  assert.match(fn, /catalog-install/);
  assert.match(fn, /kind:\s*'dir'/);
  assert.match(fn, /dir-remove/);
});

test('member-facing copy in the new sections carries no em dashes', () => {
  const zoneIdx = LIBRARY.indexOf('>Files');
  assert.ok(zoneIdx > -1, 'sanity: the Files heading is found on the Library page');
  const zone = LIBRARY.slice(zoneIdx);
  assert.ok(!zone.includes('—'), 'no em dash in the Files section markup');
  const fn = HTML.slice(HTML.indexOf('function loadFiles'), HTML.indexOf('function loadFiles') + 6000);
  const literals = fn.match(/'[^']*'/g) || [];
  for (const s of literals) assert.ok(!s.includes('—'), `em dash in a loadFiles string literal: ${s}`);
});

test('F1: renderFilesOffered is a named function, called from loadFiles AND from loadLibrary\'s catalog-list callback', () => {
  assert.match(HTML, /function renderFilesOffered/, 'offered rendering is split into its own function, not inlined only in loadFiles');
  const between = HTML.slice(HTML.indexOf('function loadFiles'), HTML.indexOf('function renderFilesOffered'));
  assert.match(between, /renderFilesOffered\(\)/, 'loadFiles repaints Offered once its own (library-list) read resolves');
  // loadLibrary's catalog-list callback: the block that parses state.catalog out of __CATALOG__.
  const catalogListIdx = HTML.indexOf("run('catalog-list'");
  assert.ok(catalogListIdx > -1, 'sanity: catalog-list call exists');
  const catalogCallback = HTML.slice(catalogListIdx, catalogListIdx + 3000);
  assert.match(catalogCallback, /state\.catalog\s*=/, 'sanity: this is the block that sets state.catalog');
  assert.match(catalogCallback, /renderFilesOffered\(\)/, 'catalog-list resolving must also repaint Offered: it is a separate, heavier round trip than library-list and often resolves second');
  assert.doesNotMatch(catalogCallback, /loadFiles\(\)/, 'catalog-list must not re-run the whole loadFiles: that would double the library-list round trip on every Skills-page load');
});

test('F2: offered rows are deduped by id, not just filtered against installed', () => {
  const fn = HTML.slice(HTML.indexOf('function renderFilesOffered'), HTML.indexOf('function renderFilesOffered') + 3000);
  assert.match(fn, /\bseen\s*=\s*\{\}/, 'a seen-ids set exists alongside installedIds');
  assert.match(fn, /seen\[id\]/, 'the offer loop checks the seen set before pushing a row');
  assert.match(fn, /seen\[id\]\s*=\s*true/, 'the offer loop marks an id as seen once it is pushed, so a second pack offering the same id is skipped');
});

test('the Pages management section exists with the page group idiom, on the Library page', () => {
  assert.match(LIBRARY, /<h3 class="subhead zonegap">Pages/, 'Pages is a group heading');
  assert.match(LIBRARY, /id="pagesListSection"/);
  assert.match(LIBRARY, /id="pagesEmpty"/);
});

test('the Pages section reuses the existing delete path, it does not add a second one', () => {
  const fn = HTML.slice(HTML.indexOf('function renderPagesSection'), HTML.indexOf('function renderPagesSection') + 3000);
  assert.match(fn, /deleteMemberPage\(/, 'removal goes through the existing confirm + page-delete path');
  const pageDeleteCalls = (HTML.match(/run\('page-delete'/g) || []).length;
  assert.equal(pageDeleteCalls, 1, 'exactly one place calls the page-delete verb');
});

test('the Library page reads as three zones, in order: Pages, Prompts, Files', () => {
  const order = ['<h3 class="subhead zonegap">Pages', '<h3 class="subhead zonegap">Prompts', '<h3 class="subhead zonegap">Files']
    .map((m) => LIBRARY.indexOf(m));
  assert.ok(order.every((i) => i > 0), 'all three group headings are present');
  assert.deepEqual(order.slice().sort(function(a, b){ return a - b; }), order, 'Pages, then Prompts, then Files');
});

test('regression (review round 2): a pack item never reaches the skills OFFERS listing, only the Files section', () => {
  // catalog-reconcile has emitted kind:'pack' entries since the 4 Aug spec.
  // libEntries() pushes every catalogue item with no kind filter, so the
  // offers-rendering loop in renderSkills (the "From your rocks" group) is
  // the one place that must exclude packs itself, the same way offerFor
  // already does at its own call site. Without the filter, a pack renders as
  // an installable SKILL offer; clicking it calls catalog-install with no
  // kind, takes the skill path, and fails (no SKILL.md).
  const start = HTML.indexOf('// ---- group 2: From your rocks, one subsection per rock ----');
  assert.ok(start > -1, 'sanity: the offers-rendering block exists');
  const end = HTML.indexOf('// E7 (2026-08-10 tie audit)', start);
  assert.ok(end > start, 'sanity: the block ends before the next section');
  const block = HTML.slice(start, end);
  assert.match(block, /libs\.forEach\(function\(l\)\{/, 'sanity: this is the loop that walks libEntries() output');
  // Widened 2026-08-26 from the kind !== 'pack' deny-list to the isSkillOffer
  // allow-list: step 5b gave a standalone page its own top-level item,
  // kind: 'page', and the deny-list let it straight through into this listing
  // as an installable skill card. Same failure, one kind later. The pin now
  // tracks the rule rather than the one kind that first broke it.
  assert.match(block, /if \(!isSkillOffer\(l\.it\)\) return;/, 'only skills are pushed into the skills offers listing');
  assert.match(block, /return;/, 'a non-skill item is skipped, not pushed into byRock');
});

test('I2 (review round 3): a packs-only rock still gets a "From <rock>" subsection, degrading to "Nothing new" rather than vanishing', () => {
  // Round 2's fix put the pack check BEFORE byRock[l.rock] was registered, so
  // a rock whose catalogue was packs-only never entered `order` at all: the
  // skills zone printed "Your rocks haven't published anything yet" for a
  // rock that had, in fact, published something (a pack, listed correctly in
  // the Files zone below it). The registration must happen first; only the
  // ROW push is conditional on kind.
  const start = HTML.indexOf('// ---- group 2: From your rocks, one subsection per rock ----');
  const end = HTML.indexOf('// E7 (2026-08-10 tie audit)', start);
  const block = HTML.slice(start, end);
  const registerIdx = block.search(/if \(!byRock\[l\.rock\]\) \{ byRock\[l\.rock\] = \[\]; order\.push\(l\.rock\); \}/);
  const packCheckIdx = block.search(/if \(!isSkillOffer\(l\.it\)\) return;/);
  assert.ok(registerIdx > -1, 'byRock/order registration line exists');
  assert.ok(packCheckIdx > -1, 'the non-skill-skip line exists');
  assert.ok(registerIdx < packCheckIdx, 'the rock is registered into byRock/order BEFORE a non-skill offer can short-circuit the loop');
  const pushIdx = block.indexOf('byRock[l.rock].push(l)');
  assert.ok(pushIdx > packCheckIdx, 'the only content push happens after the pack check, so a pack itself is still never pushed as a row');
});

test('I6: the Pages zone has its own notice div, and a failed pages-list read says so there', () => {
  assert.match(LIBRARY, /<div class="notice" id="pagesNotice"><\/div>/, 'Pages gets a notice div like Prompts and Files');
  const fn = HTML.slice(HTML.indexOf('function loadPagesList'), HTML.indexOf('function loadPagesList') + 900);
  assert.match(fn, /if \(!r\.ok\) \{ notice\('pagesNotice', verbErr\(r, 'Could not load your pages:'\)\); return; \}/,
    'a failed read notices on the Pages zone itself, not dashNotice, which renderPagesSection never runs to make visible');
});

test('M1: renderPagesSection guards a non-array manifest, matching renderMemberNav', () => {
  const fn = HTML.slice(HTML.indexOf('function renderPagesSection'), HTML.indexOf('function renderMemberNav'));
  assert.match(fn, /if \(!Array\.isArray\(pages\)\) pages = \[\];/, 'a non-array pages value is normalised before .length or .forEach touch it');
  // renderPagesSection runs first in the loadPagesList chain (before
  // renderOwnership/renderCards/renderOrgContact): an unguarded throw here
  // takes all three down with it.
  const chain = HTML.slice(HTML.indexOf('function loadPagesList'), HTML.indexOf('function loadPagesList') + 1700);
  assert.match(chain, /renderMemberNav\(\); renderPagesSection\(\); renderOwnership\(\); renderCards\(\); renderOrgContact\(\);/,
    'sanity: renderPagesSection sits before the three renders a throw would take down');
});

test('I5: deleting a page only bounces to the dashboard when the page itself is the active section', () => {
  const fn = HTML.slice(HTML.indexOf('function deleteMemberPage'), HTML.indexOf('function deleteMemberPage') + 1600);
  assert.match(fn, /var activeSec = document\.querySelector\('main section\.active'\);/, 'reads which section is actually on screen');
  assert.match(fn, /var onThisPage = !!activeSec && activeSec\.getAttribute\('data-sec'\) === 'page:' \+ id;/);
  assert.match(fn, /notice\(onThisPage \? 'dashNotice' : 'pagesNotice', msg\);/, 'the confirmation lands on whichever screen the member is looking at');
  assert.match(fn, /if \(onThisPage\) \{ activateSec\('dashboard'\); try \{ history\.replaceState\(null, '', '#dashboard'\); \} catch \(err\) \{\} \}/,
    'activateSec + the hash rewrite only fire when the member was on the page being deleted');
  // Exactly one call site for the verb (global constraint), unmoved by this fix.
  const pageDeleteCalls = (HTML.match(/run\('page-delete'/g) || []).length;
  assert.equal(pageDeleteCalls, 1, 'exactly one place calls the page-delete verb');
});

test('M6: Pages cards use the same gtitle + hint treatment as Files cards, not a bare .sub div', () => {
  const fn = HTML.slice(HTML.indexOf('function renderPagesSection'), HTML.indexOf('function renderMemberNav'));
  assert.match(fn, /var head = document\.createElement\('p'\); head\.className = 'gtitle';/, 'title rides gtitle, like a Files card');
  assert.match(fn, /var where = document\.createElement\('p'\); where\.className = 'hint'; where\.style\.margin = '2px 0 10px';/, 'the "from X / yours / example page" line rides hint with its own margin');
  assert.doesNotMatch(fn, /head\.className = 'sub'/, 'no bare .guidecard .sub div, which has no styling rule and renders as unspaced plain text');
});

test('M2: a failed files refresh clears the installed list rather than leaving stale, dead-button cards', () => {
  const fn = HTML.slice(HTML.indexOf('function loadFiles'), HTML.indexOf('function loadFiles') + 900);
  const notOk = fn.split('if (!r.ok){')[1].split("return;\n      }")[0];
  assert.match(notOk, /installedBox\.innerHTML = '';/, 'the stale card list is cleared on a failed refresh');
  assert.match(notOk, /state\.filesDirs = \[\];/, 'installed-state is reset so a stale id cannot mark a later Offered row as already installed');
  assert.match(notOk, /renderFilesOffered\(\);/, 'Offered repaints from the reset state instead of being left with the previous read');
});

test('M5: the dev-harness starter-kit pack fixture uses a category the platform taxonomy actually allows', () => {
  const fixtures = readFileSync(path.join(HERE, '..', 'dev-harness', 'fixtures.mjs'), 'utf8');
  const idx = fixtures.indexOf("id: 'starter-kit'");
  assert.ok(idx > -1, 'sanity: the starter-kit fixture exists');
  const row = fixtures.slice(idx - 20, idx + 400);
  // Platform taxonomy: brain-template control/catalog-lib.mjs CATEGORIES.
  // 'files' is not in it, so enforceCategories would have refused this
  // manifest at materialisation and the item could never reach a real
  // catalogue; the fixture must not model an impossible state.
  const CATEGORIES = ['briefing', 'capture', 'comms', 'box', 'org', 'other'];
  const m = row.match(/category:\s*'([^']*)'/);
  assert.ok(m, 'sanity: a category is set on the fixture');
  assert.ok(CATEGORIES.includes(m[1]), `category '${m[1]}' is not one of ${CATEGORIES.join('|')}`);
});

// ---- step 5b: the Offered half of Pages (spec 2026-08-26-delivery-model
// § 5b), the same problem renderFilesOffered already solved for Files. ------

test('P0: the Pages zone has an Offered container and its own renderer', () => {
  assert.match(LIBRARY, /id="pagesOffered"/, 'a pagesOffered container sits beside pagesListSection');
  assert.match(HTML, /function renderPagesOffered/, 'offered rendering is its own named function, not inlined');
});

test('P1: renderPagesOffered is called from both loadPagesList AND loadLibrary\'s catalog-list callback', () => {
  const chain = HTML.slice(HTML.indexOf('function loadPagesList'), HTML.indexOf('function loadPagesList') + 1900);
  assert.match(chain, /renderPagesOffered\(\);/, 'loadPagesList repaints Offered once its own (pages-list) read resolves');
  const catalogListIdx = HTML.indexOf("run('catalog-list'");
  assert.ok(catalogListIdx > -1, 'sanity: catalog-list call exists');
  const catalogCallback = HTML.slice(catalogListIdx, catalogListIdx + 3000);
  assert.match(catalogCallback, /state\.catalog\s*=/, 'sanity: this is the block that sets state.catalog');
  assert.match(catalogCallback, /renderFilesOffered\(\);\s*\n\s*renderPagesOffered\(\);/,
    'catalog-list resolving must also repaint Pages Offered: the same separate, heavier round trip that already forced this for Files');
  assert.doesNotMatch(catalogCallback, /loadPagesList\(\)/, 'catalog-list must not re-run the whole loadPagesList: that would double the pages-list round trip on every Skills-page load');
});

test('P2: renderPagesOffered reads a top-level kind: page item AND a pack\'s contents.pages, guarded by Array.isArray', () => {
  const fn = HTML.slice(HTML.indexOf('function renderPagesOffered'), HTML.indexOf('function renderPagesOffered') + 3000);
  assert.match(fn, /it\.kind === 'page'/, 'a standalone page offer is read from a top-level kind: page item');
  assert.match(fn, /it\.kind === 'pack'/, 'a pack-bundled page offer is also read');
  assert.match(fn, /Array\.isArray\(it\.contents\.pages\)/, 'contents.pages is still a COUNT today (5c changes that rock-side): the array branch must be guarded, never assumed');
});

test('P3: offered pages are deduped against installed pages AND against each other', () => {
  const fn = HTML.slice(HTML.indexOf('function renderPagesOffered'), HTML.indexOf('function renderPagesOffered') + 3000);
  assert.match(fn, /installedIds\[/, 'an offer already installed (state.pagesManifest.pages) is skipped');
  assert.match(fn, /\bseen\s*=\s*\{\}/, 'a seen-ids set exists, same as renderFilesOffered\'s F2 fix');
  assert.match(fn, /seen\[[a-zA-Z.]+\]\s*=\s*true/, 'the offer loop marks an id as seen once pushed, so a second source offering the same id is skipped');
});

test('P4: renderPagesOffered normalises a non-array manifest before touching .forEach, the same guard renderPagesSection carries (M1)', () => {
  const fn = HTML.slice(HTML.indexOf('function renderPagesOffered'), HTML.indexOf('function renderPagesOffered') + 1200);
  assert.match(fn, /if \(!Array\.isArray\(installed\)\) installed = \[\];/, 'a non-array pagesManifest.pages must not throw inside renderPagesOffered');
});

test('P5: installing an offered page calls catalog-install with kind: page and, when known, the offering rock', () => {
  const fn = HTML.slice(HTML.indexOf('function renderPagesOffered'), HTML.indexOf('function renderPagesOffered') + 3000);
  assert.match(fn, /catalog-install/, 'installs go through the existing verb, no new mutating verb is added');
  assert.match(fn, /kind:\s*'page'/);
  assert.match(fn, /if \(o\.rock_id\) args\.rock = o\.rock_id;/, 'the rock argument disambiguates two rocks offering the same id, same as Files');
});

test('P6: Pages Offered cards use the gtitle + hint treatment (M6), and every field rides textContent, never innerHTML of catalogue data', () => {
  const fn = HTML.slice(HTML.indexOf('function renderPagesOffered'), HTML.indexOf('function renderPagesOffered') + 3000);
  assert.match(fn, /head\.className = 'gtitle'/, 'title rides gtitle, like every other guidecard in this zone');
  assert.match(fn, /where\.className = 'hint'/, 'the secondary line rides hint, not a bare .sub div');
  assert.doesNotMatch(fn, /\.innerHTML\s*=\s*[^'"][^;]*\bo\./, 'no field of an offer is written via innerHTML');
  assert.match(fn, /offeredBox\.innerHTML = '';/, 'the only innerHTML write in the function is the literal empty-string reset');
});

test('P7: no em dash in the Pages Offered code or its member-facing strings', () => {
  const fn = HTML.slice(HTML.indexOf('function renderPagesOffered'), HTML.indexOf('function renderPagesOffered') + 3000);
  assert.ok(!fn.includes('—'), 'no em dash in renderPagesOffered');
  const literals = fn.match(/'[^']*'/g) || [];
  for (const s of literals) assert.ok(!s.includes('—'), `em dash in a renderPagesOffered string literal: ${s}`);
});

test('P8: the dev-harness catalog-list fixture carries a standalone page offer (kind: page), and the empty world stays empty', () => {
  const fixtures = readFileSync(path.join(HERE, '..', 'dev-harness', 'fixtures.mjs'), 'utf8');
  const caseStart = fixtures.indexOf("case 'catalog-list':");
  assert.ok(caseStart > -1, 'sanity: the catalog-list fixture case exists');
  const caseEnd = fixtures.indexOf("case 'catalog-install':", caseStart);
  const block = fixtures.slice(caseStart, caseEnd);
  assert.match(block, /kind:\s*'page'/, 'the fixture offers at least one standalone page item, the new shape this step reads');
  // the empty-world branch returns before any items array is built, so it
  // must not be perturbed by this addition.
  const emptyLine = block.match(/if \(state === 'empty'\) return ok\(\[[^\n]*\]\);/);
  assert.ok(emptyLine, 'sanity: the empty-world branch still exists');
  assert.doesNotMatch(emptyLine[0], /kind/, 'the empty world carries no items at all, page or otherwise');
});
