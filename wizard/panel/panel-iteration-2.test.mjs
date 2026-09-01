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
test('R17: the nav reads Overview · Decisions · Your rock / Your pebble · Network · Your assistant · Privacy & access · Terminal', () => {
  // groups by their wrapper, tabs by their button; the Map tab inside the
  // Network group is data-sec="network" and is not what this pin orders.
  const top = nav.replace(/<div class="gitems"[\s\S]*?<\/div>/g, '');
  const order = [...top.matchAll(/<button[^>]*data-sec="([a-z]+)"|<div class="navgroup" data-group="([a-z]+)"/g)].map((m) => m[1] || m[2]);
  const want = ['dashboard', 'decisions', 'yourrock', 'seat', 'network', 'assistant', 'privacy', 'terminal'];
  const seen = order.filter((x) => want.includes(x));
  assert.deepEqual(seen, want, `nav order is ${seen.join(' · ')}`);
  const net = nav.slice(nav.indexOf('id="grp-network"'), nav.indexOf('</div>', nav.indexOf('id="grp-network"')));
  // Communities joined the group 2026-09-01 (commons-repo model), member-only.
  assert.deepEqual([...net.matchAll(/data-sec="([a-z]+)"/g)].map((m) => m[1]), ['network', 'rocks', 'commons', 'pebbles'], 'Network = Map, Organisations, Communities, Members');
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

test('R17: Help is a section on both faces, reached from the footer link, carrying the connection name and the update folds', () => {
  assert.match(main, /<section data-sec="help">/, 'Help lives inside <main>');
  const link = html.match(/<a class="navlink" id="helpLink"[^>]*>/);
  assert.ok(link, 'the footer link exists');
  assert.ok(!/orgonly|memonly/.test(link[0]), 'and carries no face class');
  assert.match(link[0], /title="Help"/);
  const sec = main.slice(main.indexOf('<section data-sec="help">'), main.indexOf('</section>', main.indexOf('<section data-sec="help">')));
  for (const id of ['ohHost', 'ohCopy', 'boxRefreshBtn', 'brBtn', 'br_ack', 'openFolderName']) {
    assert.ok(sec.includes(`id="${id}"`), `${id} lives on the Help page`);
  }
  assert.match(sec, /class="[^"]*memonly/, 'face-aware copy: member');
  assert.match(sec, /class="[^"]*orgonly/, 'face-aware copy: rock');
  assert.match(html, /function openHelp\(\)\{ activateSec\('help'\)/, 'the opener is a section switch, not a modal');
  assert.match(html, /\$\('orgCcBannerBtn'\)\.onclick = openHelp;/, 'the onboarding banner still lands on it');
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
test('R19b: every Decisions row is one line with its buttons; the row click opens detail + inputs; handlers and attnErr honesty survive', () => {
  assert.match(html, /function foldRow\(headHtml, acts, open\)/, 'the one row anatomy');
  const fr = html.split('function foldRow(headHtml, acts, open){')[1].split('\n  }')[0];
  assert.match(fr, /closest\('button, input, select, textarea, a, label'\)\) return;/, 'controls never toggle the row');
  assert.match(fr, /e\.key === 'Enter' \|\| e\.key === ' '/, 'keyboard toggles too');
  assert.match(fr, /aria-expanded/, 'the head says whether it is open');
  // the four renderers build through it
  for (const fnName of ['function renderPending(list){', 'function renderJoinRequests(list, dormant){', 'function row(kind, subj, meta, detail){']) {
    assert.ok(html.split(fnName)[1].split('\n  }')[0].includes('foldRow('), `${fnName} uses foldRow`);
  }
  const ties = html.split("reqs.forEach(function(d){\n      var yes = document.createElement('button'); yes.className = 'act primary'; yes.textContent = 'Approve';")[1];
  assert.ok(ties && ties.split('\n    });')[0].includes('foldRow('), 'tie asks use foldRow');
  // the join row: slug + name inputs live in the fold; a nameless request opens itself
  const join = html.split('function renderJoinRequests(list, dormant){')[1].split('\n  }')[0];
  assert.match(join, /fr\.body\.appendChild\(slugIn\); fr\.body\.appendChild\(nameIn\);/, 'inputs in the fold');
  assert.match(join, /var needsName = !nameIn\.value;/, 'nameless opens itself');
  assert.match(join, /run\('join-approve'/, 'approve handler intact');
  assert.match(join, /run\('join-decline'/, 'decline handler intact');
  assert.match(html, /if \(!r\.ok\) \{ attnErrState\.join = r; updateAttention\(\); return; \}/, 'attnErr honesty intact');
  assert.match(html, /if \(!r\.ok\) \{ attnErrState\.devices = r; updateAttention\(\); return; \}/, 'attnErr honesty intact (devices)');
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
