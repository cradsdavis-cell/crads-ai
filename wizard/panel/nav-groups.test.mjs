// nav-groups.test.mjs — the member sidebar's dropdown groups (Sam, 2026-08-04).
//   node --test wizard/panel/nav-groups.test.mjs
//
// The sidebar had grown to 12 flat tabs. Sam's call: fold Skills/Cadence/Library
// and Secrets/Devices/Sharing under two collapsible headers ("sort of sub pages")
// so the list stays one screen. What this file guards:
//   1. the six grouped tabs sit INSIDE their group containers — a regression
//      cannot flatten the list back out while the button-presence tests
//      (skills-page, library-page, qa-network) still pass
//   2. grouped buttons keep the exact <button data-sec="…"> form that hash
//      routing, the console's deep links and the shots rig all address
//   3. deep links never land on a hidden tab: activateSec opens the owning group
//   4. groups start collapsed (hidden) and the headers speak aria-expanded
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

// a .gitems container holds only buttons, so non-greedy to the first </div> is exact
function items(groupId) {
  const m = html.match(new RegExp('<div class="gitems" id="grp-' + groupId + '" hidden>([\\s\\S]*?)</div>'));
  assert.ok(m, `group container grp-${groupId} exists and starts hidden`);
  return m[1];
}

// Telegram's tab died 2026-08-09 (audit R4, a Connections row now); Cadence and
// Library died the same day (audit R6, folded into Skills).
//
// Renamed "automations" -> "assistant" on 2026-08-10 (Sam). "Automations" named
// the mechanism; these pages are the assistant's own substance, and their page
// copy already reads as a set: Brain = "everything your assistant knows", Skills
// = "everything your assistant knows how to do", Connections = "what your
// assistant can reach", Catalogue = what it gives out. Brain moved in from top
// level and Publishing moved in as Catalogue.
//
// Library rejoined the group 2026-08-26 (step 7a): Pages, Prompts and Files
// moved out of Skills onto their own page, reclaiming the name a 2026-08-09
// merge (R6) had retired. Since the face collapse (2026-09-01) nothing in the
// group carries a face class: Catalogue is every mineral's publishing surface,
// because acting as a community hub is a role, not an edition.
test('Your assistant folds Brain, Skills, Library, Connections and Catalogue', () => {
  const g = items('assistant');
  // ONE Brain button since S5 retired orgbrain: the shared graph viewer is the
  // only brain surface there is.
  assert.match(g, /<button data-sec="brain">/, 'the shared brain viewer');
  assert.ok(!g.includes('data-sec="orgbrain"'), 'and no retired orgbrain twin');
  assert.match(g, /<button data-sec="skills">/, 'Skills');
  assert.match(g, /<button data-sec="library">/, 'Library, after Skills');
  assert.ok(g.indexOf('data-sec="skills"') < g.indexOf('data-sec="library"'), 'Library sits after Skills');
  assert.match(g, /<button data-sec="connections">/, 'Connections');
  assert.match(g, /<button data-sec="publish">/, 'Catalogue, no face class');
  assert.ok(!g.includes('class="orgonly"'), 'no org-only chrome survives in the group');
  assert.equal((g.match(/data-sec="/g) || []).length, 5, 'nothing else in the group');
  assert.match(g, />Catalogue</, 'the publish tab is labelled Catalogue now');
  assert.ok(!/>Publishing</.test(g), 'and no longer Publishing');
});

test('the old group id is gone, so no stale selector can still resolve', () => {
  assert.ok(!html.includes('data-group="automations"'), 'no automations group');
  assert.ok(!html.includes('grp-automations'), 'no automations container');
  assert.ok(!html.includes('>Automations<'), 'no Automations label');
});

test('old Cadence deep links land on Skills (merged 2026-08-09, R6); Library deep links no longer do (reclaimed 2026-08-26, step 7a)', () => {
  assert.match(html, /if \(name === 'cadence'\) name = 'skills';/, 'activateSec maps cadence');
  assert.match(html, /if \(h === 'cadence'\) h = 'skills';/, 'hashchange maps cadence');
  assert.doesNotMatch(html, /'cadence' \|\| name === 'library'/, 'activateSec no longer maps library to skills');
  assert.doesNotMatch(html, /'cadence' \|\| h === 'library'/, 'hashchange no longer maps library to skills');
  assert.ok(!html.includes('data-sec="cadence">'), 'no Cadence tab or section remains');
  assert.ok(html.includes('<section data-sec="library">'), 'Library is a real section again');
  assert.ok(html.includes('<button data-sec="library">'), 'and a real nav button');
});

test('Telegram is a Connections row, not a page (merged 2026-08-09, R4)', () => {
  assert.ok(!html.includes('<button data-sec="telegram">'), 'no Telegram nav tab');
  assert.ok(!html.includes('<section data-sec="telegram">'), 'no Telegram section');
  // The end anchor is the next section in source order (Brain); it used to be
  // the Rocks section, which left with the face collapse (2026-09-01).
  const conn = html.slice(html.indexOf('<section data-sec="connections">'), html.indexOf('<section data-sec="brain">'));
  for (const id of ['tgRow', 'tgChip', 'tgToggle', 'tgDetail', 'tgSetup', 'tgWait', 'tgForget']) {
    assert.ok(conn.includes(`id="${id}"`), `${id} lives inside the Connections section`);
  }
  assert.match(conn, /id="tgDetail" style="display:none"/, 'the setup detail starts collapsed');
  // old deep links still land: #telegram arrives on Connections by every route
  assert.match(html, /if \(name === 'telegram'\) name = 'connections';/, 'activateSec maps #telegram');
  assert.match(html, /if \(h === 'telegram'\) h = 'connections';/, 'hashchange maps #telegram');
  // and the poll starts with the page that shows it, stops with it. Since the
  // 2026-08-09 lag audit the open is warmth-guarded (60s) with a mid-setup
  // re-arm; the leave still unconditionally stops the poll.
  assert.match(html, /if \(Date\.now\(\) - connWarmAt > 60000\) \{ connWarmAt = Date\.now\(\); loadMcp\(\); tgStatus\(\); \}/,
    'opening Connections loads Telegram state (warmth-guarded)');
  assert.match(html, /else if \(!tgTimer && tgLastS && tgLastS\.token && !tgLastS\.chat\) tgStatus\(\);/,
    'warm re-entry re-arms a dark mid-setup poll');
  assert.match(html, /\} else tgStop\(\);/, 'leaving Connections stops the poll');
});

// Sharing retired with the face collapse (2026-09-01): support access moved to
// Help, and the rest of the page had already dispersed (Secrets and Devices
// became their own surfaces long before). The group holds one tab now; the
// header earns its keep as the place an access page would return to.
test('Privacy & access folds exactly Secrets (Sharing retired 2026-09-01)', () => {
  const g = items('privacy');
  assert.match(g, /<button data-sec="secrets">/, 'Secrets inside the group');
  assert.ok(!g.includes('data-sec="sharing"'), 'no Sharing tab');
  assert.equal((g.match(/data-sec="/g) || []).length, 1, 'nothing else in the group');
});

// The Network umbrella (Sam, 2026-08-09 rock-dashboard ruling): Map is the page
// previously called Network. The face collapse (2026-09-01) took Rocks and the
// org-only Pebbles with the org face; Communities (the commons-repo model) is
// the box-to-box surface that remains, and it carries no face class because
// there is only one face.
test('Network folds exactly Map and Communities', () => {
  const g = items('network');
  assert.match(g, /<button data-sec="network">/, 'Map inside the group');
  assert.match(g, /<button data-sec="commons">/, 'Communities inside the group, no face class');
  assert.ok(!g.includes('data-sec="rocks"'), 'no Rocks tab: the Organisations page retired');
  assert.ok(!g.includes('data-sec="pebbles"'), 'no Pebbles tab: there are no hosted pebbles');
  assert.ok(!g.includes('data-sec="rockbrain"'), 'and no Rock brain tab');
  assert.equal((g.match(/data-sec="/g) || []).length, 2, 'nothing else in the group');
  assert.match(g, />Map</, 'the network tab is labelled Map now');
});

test('old deep links land on the regrouped tabs: #map, #communities, #devices, #rocks, #rockbrain', () => {
  assert.match(html, /if \(h === 'map'\) h = 'network';/, 'secFromHash maps #map');
  assert.match(html, /if \(h === 'communities'\) h = 'commons';/, 'secFromHash maps #communities to the Communities page');
  assert.match(html, /if \(h === 'devices'\) h = 'network';/, 'secFromHash maps #devices');
  assert.match(html, /if \(name === 'map'\) name = 'network';/, 'activateSec maps map too');
  // the org pages died 2026-09-01; their hashes land on Communities rather
  // than nowhere, by both routes, or a hashchange arrival strands
  assert.match(html, /if \(h === 'rocks' \|\| h\.indexOf\('rocks\/'\) === 0 \|\| h === 'rockbrain'\) h = 'commons';/,
    'secFromHash maps the retired org hashes');
  assert.match(html, /if \(name === 'rocks' \|\| name\.indexOf\('rocks\/'\) === 0 \|\| name === 'rockbrain'\) name = 'commons';/,
    'activateSec maps them too, per-rock deep links included');
  assert.ok(!html.includes('<section data-sec="rockbrain"'), 'and the section itself is gone');
  assert.ok(!html.includes('<section data-sec="rocks"'), 'so is the Rocks section');
});

test('each grouped tab exists once — inside its group, never also at top level', () => {
  for (const sec of ['skills', 'library', 'connections', 'brain', 'publish', 'secrets', 'network', 'commons']) {
    const hits = html.match(new RegExp('<button[^>]* data-sec="' + sec + '">', 'g')) || [];
    assert.equal(hits.length, 1, `${sec} appears exactly once in the nav`);
  }
});

// Brain left this list on 2026-08-10: it is inside "Your assistant" now, which
// costs it one click. Sam's call, taken knowingly.
test('the ungrouped tabs stay flat', () => {
  const nav = html.slice(html.indexOf('<nav id="nav">'), html.indexOf('</nav>'));
  // claudecode left 2026-08-23 (R17): its guide is the Help page off the footer.
  for (const sec of ['dashboard', 'seat', 'terminal']) {
    assert.match(nav, new RegExp('<button[^>]*data-sec="' + sec + '"'), `${sec} still a top-level tab`);
  }
});

test('group headers are disclosure buttons: toggle hook + aria wiring + chevron', () => {
  for (const gid of ['assistant', 'privacy', 'network']) {
    assert.match(html, new RegExp(
      '<button class="ghead" data-group-toggle="' + gid + '" aria-expanded="false" aria-controls="grp-' + gid + '">'),
      `${gid} header carries the toggle + aria contract`);
  }
  assert.match(html, /hasAttribute\('data-group-toggle'\)/, 'the nav click handler routes header clicks to the toggle');
  assert.match(html, /class="chev"/, 'headers carry the open/closed chevron');
});

test('the active page always opens its own group (deep links included)', () => {
  // activateSec is the single entry point for clicks, #hash deep links, the
  // console's crads-app-nav messages and boot — one hook covers all four
  assert.match(html, /groupReveal\(document\.querySelector\('#nav button\.on'\)\);/,
    'activateSec reveals the owning group of the newly active tab');
  const reveal = html.match(/function groupReveal\(btn\)\{[\s\S]*?\n  \}/);
  assert.ok(reveal, 'groupReveal exists');
  assert.match(reveal[0], /closest\('\.navgroup'\)/, 'it walks up to the owning group');
});

test('open/closed persists per browser and paints at boot', () => {
  assert.match(html, /var GROUPS_KEY = 'crads-nav-groups';/, 'one storage key');
  assert.match(html, /groupsApply\(\);\s+\/\/ paint persisted open\/closed state before first interaction/,
    'boot applies the persisted state');
});
