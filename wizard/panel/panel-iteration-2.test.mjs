// panel-iteration-2.test.mjs: the shell rulings of the 2026-08-23 grill
// (docs/superpowers/specs/2026-08-23-panel-iteration-2.md). Structural pins
// only: nav order, the Help page, the responsive shell, the Health card, the
// Decisions rows, the Map heading. Copy is never pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const nav = html.slice(html.indexOf('<nav id="nav">'), html.indexOf('</nav>'));
const main = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));

// ---- R17: nav order ---------------------------------------------------------
// The face collapse (2026-09-01) took Decisions and Your rock out of R17's
// ordering: one face, so the nav reads Overview · Your mineral · Network ·
// Your assistant · Privacy & access · Terminal for everyone.
test('R17: the nav reads Overview · Your mineral · Network · Your assistant · Privacy & access · Terminal', () => {
  // groups by their wrapper, tabs by their button; the Map tab inside the
  // Network group is data-sec="network" and is not what this pin orders.
  const top = nav.replace(/<div class="gitems"[\s\S]*?<\/div>/g, '');
  const order = [...top.matchAll(/<button[^>]*data-sec="([a-z]+)"|<div class="navgroup" data-group="([a-z]+)"/g)].map((m) => m[1] || m[2]);
  const want = ['dashboard', 'seat', 'network', 'assistant', 'privacy', 'terminal'];
  const seen = order.filter((x) => want.includes(x) || ['decisions', 'yourrock', 'pebbles', 'rocks'].includes(x));
  assert.deepEqual(seen, want, `nav order is ${seen.join(' · ')}`);
  const net = nav.slice(nav.indexOf('id="grp-network"'), nav.indexOf('</div>', nav.indexOf('id="grp-network"')));
  // Communities joined the group 2026-09-01 (commons-repo model); Rocks and
  // Pebbles left with the org face the same day.
  assert.deepEqual([...net.matchAll(/data-sec="([a-z]+)"/g)].map((m) => m[1]), ['network', 'commons'], 'Network = Map, Communities');
  const ast = nav.slice(nav.indexOf('id="grp-assistant"'), nav.indexOf('</div>', nav.indexOf('id="grp-assistant"')));
  // Library rejoined the group 2026-08-26 (step 7a), after Skills: Pages,
  // Prompts and Files moved off Skills onto their own page.
  assert.deepEqual([...ast.matchAll(/data-sec="([a-z]+)"/g)].map((m) => m[1]), ['brain', 'skills', 'library', 'connections', 'publish'], 'Your assistant = Brain, Skills, Library, Connections, Catalogue');
});

test('R17: the Claude Code tab and section are gone; old deep links land on Help', () => {
  assert.ok(!nav.includes('data-sec="claudecode"'), 'no nav button');
  assert.ok(!html.includes('<section data-sec="claudecode">'), 'no section');
  assert.ok(!html.includes('id="helpModal"'), 'the modal is gone');
  assert.match(html, /if \(name === 'claudecode'\) name = 'help';/, 'activateSec maps the retired id');
  assert.match(html, /if \(h === 'claudecode'\) h = 'help';/, 'secFromHash maps the retired id');
  assert.match(html, /if \(h === 'help'\) return 'help';/, 'and #help resolves without a nav button');
});

test('R17: Help is one section, reached from the footer link, carrying the connection name, the restart card and support access', () => {
  // The face collapse (2026-09-01): the org-only "Mineral software" restart
  // fold (brBtn / br_ack) and the org onboarding banner died with the org
  // face, and the surviving restart card is ungated. Support access moved
  // here from the retired Sharing page, ids intact.
  assert.match(main, /<section data-sec="help">/, 'Help lives inside <main>');
  const link = html.match(/<a class="navlink" id="helpLink"[^>]*>/);
  assert.ok(link, 'the footer link exists');
  assert.ok(!/orgonly|memonly/.test(link[0]), 'and carries no face class');
  assert.match(link[0], /title="Help"/);
  const sec = main.slice(main.indexOf('<section data-sec="help">'), main.indexOf('</section>', main.indexOf('<section data-sec="help">')));
  for (const id of ['ohHost', 'ohCopy', 'boxRefreshBtn', 'openFolderName', 'supportState', 'supportGrant', 'supportRevoke', 'supportEvents']) {
    assert.ok(sec.includes(`id="${id}"`), `${id} lives on the Help page`);
  }
  assert.ok(!sec.includes('id="brBtn"') && !sec.includes('id="br_ack"'), 'the org restart fold stays gone');
  assert.ok(!/class="[^"]*(?:memonly|orgonly)/.test(sec), 'no face-classed copy survives on the page');
  assert.match(html, /function openHelp\(\)\{ activateSec\('help'\)/, 'the opener is a section switch, not a modal');
  assert.ok(!html.includes('orgCcBannerBtn'), 'the org onboarding banner is gone with its face');
});

test('F1 / R18: nobody is told to type /state or /state/brain; the folder is the one named after the mineral', () => {
  assert.ok(!/enter <code>\/state(\/brain)?<\/code>/.test(html), 'no typed-path folder instruction');
  assert.ok(!/open(?:ing)? <code>\/state/.test(html), 'no "open /state" instruction');
  assert.match(html, /run\('open-folder', \{\}\)/, 'the folder name is asked of the box');
  assert.match(html, /id="openFolderName">state</, 'with the honest fallback word in place');
});

// ---- R16: responsive shell --------------------------------------------------
test('R16: under 900px the sidebar is a top bar with a menu button; under 640px grids go single column', () => {
  assert.match(html, /<button class="navtoggle" id="navToggle" type="button" aria-label="[^"]+" aria-expanded="false" aria-controls="nav">/, 'the menu button exists with its aria contract');
  const m900 = html.match(/@media \(max-width:900px\)\{([\s\S]*?)\n  \}/);
  assert.ok(m900, 'the 900px breakpoint exists');
  assert.match(m900[1], /\.shell\{flex-direction:column\}/, 'the shell stacks');
  assert.match(m900[1], /aside\{[^}]*flex-direction:row/, 'the sidebar becomes a bar');
  assert.match(m900[1], /\.navtoggle\{display:inline-flex\}/, 'the menu button shows');
  assert.match(m900[1], /aside\.open nav/, 'the nav is a drawer the button opens');
  assert.match(m900[1], /main\{padding:0 16px/, 'main padding tightens');
  const m640 = html.match(/@media \(max-width:640px\)\{([\s\S]*?)\n  \}/);
  assert.ok(m640, 'the 640px breakpoint exists');
  for (const sel of ['.cards', '.strip', '.auds', '.fleetgrid']) assert.ok(m640[1].includes(sel), `${sel} goes single column`);
  assert.match(m640[1], /\.pendrow input[^{]*\{[^}]*width:100%/, 'row inputs go full width');
  assert.match(m640[1], /table\{display:block;overflow-x:auto/, 'tables scroll in their own box');
  assert.match(html, /function navDrawer\(open\)/, 'the drawer toggle exists');
  assert.match(html, /if \(b && b\.getAttribute\('data-sec'\)\) navDrawer\(false\);/, 'a tab click closes the drawer');
});

// ---- R19a: the Health card ----------------------------------------------------
test('R19a: Health = headline, Checked N ago, one jobs line; the job list folds, open only when something is not ok', () => {
  const fn = html.split('function machineryHtml(rows, sick){')[1].split('\n  }')[0];
  assert.match(fn, /<details class="machfold"' \+ \(sick \? ' open' : ''\) \+ '>'/, 'open iff sick');
  assert.match(fn, /', all fine'/, 'the all-fine line');
  assert.match(fn, /' a look<\/span>'/, 'the needs-a-look line');
  assert.match(fn, /<ul class="mach">/, 'the per-job rows survive inside the fold');
  const card = html.split("{ id: 'health'")[1].split("{ id: 'skills'")[0];
  assert.match(card, /">Checked '\s*\+ esc\(seen \|\| 'just now'\)/, 'Checked N ago');
  assert.match(card, /\+ machineryHtml\(mach, sick\);/, 'the card hands its own sick count to the fold');
  assert.doesNotMatch(card, /everything it needs is working/, 'the reassurance sentence is gone; the jobs line carries it');
});

// ---- R19b: Decisions rows -------------------------------------------------------
test('R19b is RETIRED (2026-09-01): the Decisions page left with the org face', () => {
  // foldRow, renderPending, renderJoinRequests and the attnErr honesty rails
  // existed to serve a rock owner deciding on join requests and tie asks.
  // Nothing central remains to ask: joining a community is a bundle the member
  // pastes, and device approval is wizard-local. The stronger truth is that
  // the whole machinery stays gone; if any of these names return, the hosted
  // decision queue is growing back.
  for (const gone of ['foldRow', 'renderPending', 'renderJoinRequests', 'attnErrState',
    "run('join-approve'", "run('join-decline'", 'data-sec="decisions"']) {
    assert.ok(!html.includes(gone), `${gone} stays out of the shell`);
  }
  assert.match(html, /if \(name === 'pebbles' \|\| name === 'decisions' \|\| name === 'yourrock'\) name = 'seat';/,
    'an old #decisions deep link lands on the seat rather than nowhere');
});

// ---- R22: the Map heading -----------------------------------------------------
test('R22: the data-sec="network" section is headed Map; Network is only the nav group', () => {
  const sec = html.slice(html.indexOf('<section data-sec="network">'), html.indexOf('</div>', html.indexOf('<section data-sec="network">')));
  assert.match(sec, /<h2>Map(<button class="info"[^>]*>\?<\/button>)?<\/h2>/, 'the heading says Map');
  assert.match(nav, /data-group-toggle="network"[^>]*>[\s\S]*?Network<svg/, 'the group header says Network');
  assert.match(nav, /data-sec="network">[\s\S]*?Map<\/button>/, 'the tab says Map');
});

// 2026-08-23: a three-way merge of the style block left conflict markers in
// the page and every test stayed green, because CSS swallows garbage lines.
test('member.html carries no merge conflict markers', () => {
  const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
  assert.ok(!/^(<<<<<<<|=======|>>>>>>>)/m.test(html), 'conflict markers in member.html');
});
