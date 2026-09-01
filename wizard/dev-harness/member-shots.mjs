#!/usr/bin/env node
// member-shots.mjs — member-face-only screenshot rig for the UI-overhaul loop.
// Same harness + protocol as shots.mjs, but shoots ONLY /member states so an
// iteration on member.html can self-verify quickly.
//
//   cd wizard/dev-harness && node member-shots.mjs --out <dir> [--port 4620]

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { nav, navTo } from './nav.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

const argOut = process.argv.indexOf('--out');
const OUT = argOut > -1 ? resolve(process.argv[argOut + 1])
  : join(REPO, 'docs', 'superpowers', 'ui-overhaul', 'shots', 'member-iter');
const argPort = process.argv.indexOf('--port');
const PORT = argPort > -1 ? parseInt(process.argv[argPort + 1], 10) : 4620;
const BASE = `http://localhost:${PORT}`;

mkdirSync(OUT, { recursive: true });

const harness = spawn(process.execPath, [join(HERE, 'harness.mjs'), '--port', String(PORT)], { stdio: 'pipe' });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('harness did not start')), 8000);
  harness.stdout.on('data', (d) => { if (String(d).includes('dev-harness up')) { clearTimeout(t); res(); } });
  harness.on('exit', (c) => rej(new Error(`harness exited early (${c})`)));
});

const SHOTS = [];
const THEMES = ['light', 'dark'];
function add(name, path, opts = {}) {
  for (const theme of THEMES) SHOTS.push({ name: `${name}-${theme}`, path, theme, ...opts });
}
// grouped tabs (Skills/Connections/Brain, Secrets/Sharing, Map/Rocks) sit
// behind a collapsed header since 2026-08-04, so the group is opened via its
// header before the tab is clicked. This rig grew that helper first; it lives
// in nav.mjs now so every rig has it (shots.mjs did not, and shot two failures
// on the tip for it).

// identity stability (iteration 4): the error shots visit the rich state first
// so the assistant's name lands in the per-target localStorage cache, exactly
// like a real box that was connected before it started failing. The sidebar h1
// must then show the cached name ("Aster") in the error state, never a generic.
const seedName = async (page) => {
  await page.goto(`${BASE}/member`, { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(2500);   // long enough for dashboard-data → name cached
};

add('member', '/member', { waitMs: 3500 });
add('member-empty', '/member?state=empty', { waitMs: 3500 });
add('member-error', '/member?state=error', { waitMs: 3500, pre: seedName });
add('member-error-late', '/member?state=error', { waitMs: 2500, pre: seedName, after: async (page) => {
  // press Retry a few times to reach the "several tries" error copy, then open the detail
  for (let i = 0; i < 4; i++) { await page.click('#connRetry'); await page.waitForTimeout(700); }
  await page.click('#connError summary');
  await page.waitForTimeout(300);
} });
add('member-loading', '/member', { waitMs: 350 });   // catch the skeleton frame
// mid-transition evidence (pairs with member-flow-notes.md): the same shimmer
// ~half a cycle later — two stills of one animation demonstrate the movement
add('member-skeleton-mid', '/member', { waitMs: 1150 });
// terminal OPENING state: delay /term/open so the pending "Opening…" button is
// on camera (real feedback state, normally too fast to see against the harness)
add('member-terminal-opening', '/member', { waitMs: 2500, after: async (page) => {
  await navTo(page, 'terminal', 0);
  await page.route('**/term/open', async (route) => { await new Promise(r => setTimeout(r, 1200)); route.continue(); });
  page.click('#termBtn').catch(() => {});
  await page.waitForTimeout(350);   // inside the delay window
} });
// health-not-OK evidence (iteration 5): the fixtures always report health OK,
// so the rig rewrites the dashboard-data stream in flight (harness-driven;
// fixtures.mjs stays untouched). Exercises the .st-warn card treatment.
add('member-health-degraded', '/member', { waitMs: 3500, pre: async (page) => {
  await page.route('**/run', async (route) => {
    const post = route.request().postData() || '';
    if (!post.includes('"verb":"dashboard-data"')) return route.continue();
    const resp = await route.fetch();
    const body = (await resp.text())
      .replace('\\"health\\": \\"OK\\"', '\\"health\\": \\"degraded: email check failing\\"');
    await route.fulfill({ response: resp, body });
  });
} });
// failed-machinery evidence (2026-08-09): the fixtures always report the
// nightly jobs green, and the ONE row that carried a reason line was the one
// row that rendered nameless — .nm is flex:1 (basis 0) and the reason div is a
// sibling flex item, so it ate the whole row. Same in-flight rewrite trick as
// the health shot above; fixtures.mjs stays untouched. The shot must show
// "backup" labelled, with its reason wrapped underneath.
add('member-machinery-failed', '/member', { waitMs: 3500, pre: async (page) => {
  // machinery_runs rides the cadence-list verb, not dashboard-data, and the
  // SKILLS_STATE payload is a JSON string INSIDE the response JSON, so the
  // quotes are escaped. Rewrite every /run response rather than guessing the
  // verb: the swap only matches the backup entry.
  await page.route('**/run', async (route) => {
    const resp = await route.fetch();
    const body = (await resp.text())
      .replace(/(\\?"backup\\?":\s*\{[^}]*?\\?"status\\?":\s*\\?")ok(\\?")/, '$1fail$2');
    await route.fulfill({ response: resp, body });
  });
} });
add('member-brain', '/member', { waitMs: 2500, after: nav('brain', 3500) });
// the Network page (spec 2026-08-04): solo world and org-owned world
// (?world=org flips the harness fixture). The third state used to be a
// chip-click -> roster-row flash; the 2026-08-10 rebuild took the orbiting
// device chips (.ndev) off the map entirely and moved every computer into the
// plain roster list UNDER the map, so there is no on-map device to click and no
// flash to catch. Deleted rather than repointed: the only clickable node left
// is a rock's fleet card, which exists solely in the org world and navigates
// away to Pebbles, so a shot of it would document the Pebbles page, not this one.
add('member-network', '/member', { waitMs: 2500, after: nav('network', 2000) });
add('member-network-org', '/member?world=org', { waitMs: 2500, after: nav('network', 2000) });
// S9: the public brain a tied rock chose to share, read live + tie-gated. The
// Rock brain nav tab was retired 2026-08-10 (rockreader is a sibling section
// with no nav button, deliberately: "no route can reach it except through a
// rock"), so the shot now walks the only path a member has — open the anchor
// rock's row on Rocks, then a page in its "Their brain" block.
add('member-rockbrain', '/member', { waitMs: 2500, after: async (page) => {
  await nav('rocks', 2000)(page);
  await page.locator('#rockMine .cadrow .info').first().click();
  await page.waitForTimeout(500);
  await page.locator('#rockMine .rockpages button.pg').first().click();
  await page.waitForTimeout(900);
} });
// Cadence + Library folded into Skills (2026-08-09 audit R6): one page carries
// the rows, the inline editors and the rock catalogue sections.
add('member-skills', '/member', { waitMs: 2500, after: nav('skills', 1500) });
// S7b: the per-skill drawer (open on the row). Panel iteration 2 (R11/R12):
// the rocks TAB is gone; "From your rocks" is the second group on the same
// page, so the scroll-to shot replaces the click-the-tab one.
add('member-skill-drawer', '/member', { waitMs: 2500, after: async (page) => {
  await nav('skills', 1500)(page);
  await page.locator('#skillsGroups .cadrow .info').first().click();
  await page.waitForTimeout(400);
} });
add('member-skills-rocks', '/member', { waitMs: 2500, after: async (page) => {
  await nav('skills', 1500)(page);
  await page.locator('#skillsGroups .skgroup[data-group="rocks"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
} });
add('member-sharing', '/member', { waitMs: 2500, after: nav('sharing', 1500) });
// R17 (2026-08-23): the Claude Code tab is the Help page now, off the footer link.
add('member-help', '/member', { waitMs: 2500, after: async (page) => { await page.click('#helpLink'); await page.waitForTimeout(600); } });
add('member-terminal', '/member', { waitMs: 2500, after: async (page) => {
  await navTo(page, 'terminal', 0);
  await page.click('#termBtn');
  await page.waitForTimeout(2500);
} });
// focus-state evidence: real keyboard focus so the :focus-visible rings are ON
// CAMERA (the final movement is always a Tab press, which forces focus-visible)
add('member-focus-nav', '/member', { waitMs: 2800, after: async (page) => {
  await page.keyboard.press('Tab');           // first nav button (Overview)
  await page.keyboard.press('Tab');           // second nav button (Brain)
  await page.waitForTimeout(250);
} });
add('member-focus-hero', '/member', { waitMs: 2800, after: async (page) => {
  // park focus on the header button just before the hero, then Tab onto it
  // (Refresh since S4: Customise died with the one-designed-grid ruling)
  await page.evaluate(() => document.getElementById('refreshBtn').focus());
  await page.keyboard.press('Tab');
  await page.waitForTimeout(250);
} });
add('member-focus-toggle', '/member', { waitMs: 2500, after: async (page) => {
  await nav('skills', 1200)(page);
  // the schedule toggles live on the merged Skills rows now (R6): park focus
  // on the SECOND row's toggle (role=switch, tabbable since 2026-08-04), then
  // Shift+Tab back onto the previous control so a real keyboard press paints
  // the ring
  await page.evaluate(() => document.querySelectorAll('#skillsGroups .toggle')[1].focus());
  await page.keyboard.press('Shift+Tab');
  await page.waitForTimeout(250);
} });

// Connections directory (spec 2026-08-09): the three browse states, driven and
// asserted against the real DOM, not just eyeballed. Rendered-and-driven,
// because a file grep cannot see what a debounced fetch actually paints.
add('connections-directory', '/member', { waitMs: 2500, after: async (page) => {
  await nav('connections', 1500)(page);
  await page.waitForSelector('#mcpDirRows .mcp-dir-card', { timeout: 5000 });
  const rowCount = await page.$$eval('#mcpDirRows .mcp-dir-card', (els) => els.length);
  if (rowCount < 10) throw new Error(`expected >=10 curated rows in the default browse, got ${rowCount}`);
  const browseNames = await page.$$eval('#mcpDirRows .mcp-dir-card .nm', (els) => els.map((e) => e.textContent));
  if (browseNames.includes('Canva')) throw new Error('Canva is connected (fixture) but still leaked into the browse tier');
  const yoursNames = await page.$$eval('#mcpRows .nm', (els) => els.map((e) => e.textContent));
  if (!yoursNames.includes('Canva')) throw new Error('Canva (connected in the fixture) is missing from Your connections');
} });
add('connections-search', '/member', { waitMs: 2500, after: async (page) => {
  await nav('connections', 1500)(page);
  await page.fill('#mcpDirSearch', 'crm');
  await page.waitForTimeout(650);   // past the page's own 350ms debounce
  const headings = await page.$$eval('#mcpDirRows .gtitle', (els) => els.map((e) => e.textContent.trim()));
  if (!headings.includes('From the wider registry')) throw new Error('the registry heading did not render after the search settled');
  const hitNames = await page.$$eval('#mcpDirRows .mcp-dir-card .nm', (els) => els.map((e) => e.textContent));
  if (!hitNames.includes('Example CRM')) throw new Error('the fixture registry hit (Example CRM) is missing');
} });
add('connections-registry-down', '/member', { waitMs: 2500, pre: async (page) => {
  // The harness's own /mcp-dir/search stub degrades on a "regdown" substring
  // in the query, but the page reuses that SAME typed string to filter the
  // curated tier locally, so a query built to trip the stub can never also
  // match a curated label/blurb. Routing the fetch directly isolates the
  // failure to the registry leg (the way a real outage would), so a realistic
  // search term can prove the curated tier survives the outage instead.
  await page.route('**/mcp-dir/search**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, registry_ok: false, hits: [] }),
  }));
}, after: async (page) => {
  await nav('connections', 1500)(page);
  await page.fill('#mcpDirSearch', 'pay');   // matches PayPal + Square in the curated tier
  await page.waitForTimeout(650);
  const note = await page.$eval('#mcpDirNote', (e) => ({ visible: e.style.display !== 'none', text: e.textContent }));
  if (!note.visible || !note.text.includes('did not answer')) {
    throw new Error(`#mcpDirNote did not show the degrade text: ${JSON.stringify(note)}`);
  }
  const rowCount = await page.$$eval('#mcpDirRows .mcp-dir-card', (els) => els.length);
  if (rowCount < 1) throw new Error('the registry outage emptied the curated browse tier');
} });

const report = {};
const browser = await chromium.launch();
let failures = 0;

for (const shot of SHOTS) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: shot.theme,
  });
  const page = await ctx.newPage();
  // /vendor/inter/* and /vendor/tokens.css are served for real since 90f7805;
  // no route interception needed — the shots exercise the true asset path.
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 400)); });
  page.on('pageerror', (err) => errors.push(`pageerror: ${String(err).slice(0, 400)}`));
  try {
    if (shot.pre) await shot.pre(page);
    await page.goto(BASE + shot.path, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(shot.waitMs || 2500);
    if (shot.after) await shot.after(page);
    const file = join(OUT, `${shot.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const bytes = statSync(file).size;
    const b = readFileSync(file);
    report[shot.name] = { path: shot.path, theme: shot.theme, bytes, width: b.readUInt32BE(16), height: b.readUInt32BE(20), consoleErrors: errors };
    console.log(`✓ ${shot.name}.png ${report[shot.name].width}x${report[shot.name].height} ${(bytes / 1024).toFixed(0)}kB${errors.length ? ` · ${errors.length} console error(s)` : ''}`);
  } catch (e) {
    failures++;
    report[shot.name] = { path: shot.path, theme: shot.theme, error: String(e.message || e), consoleErrors: errors };
    console.error(`✗ ${shot.name}: ${e.message || e}`);
  }
  await ctx.close();
}

await browser.close();
harness.kill();

writeFileSync(join(OUT, 'console-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\nreport → ${join(OUT, 'console-report.json')}`);
if (failures) { console.error(`${failures} shot(s) failed`); process.exit(1); }
