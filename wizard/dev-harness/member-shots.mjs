#!/usr/bin/env node
// member-shots.mjs — member-face-only screenshot rig for the UI-overhaul loop.
// Same harness + protocol as shots.mjs, but shoots ONLY /member states so an
// iteration on member.html can self-verify quickly.
//
//   cd wizard/dev-harness && node member-shots.mjs --out <dir> [--port 4620] [--only <name-prefix>]

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
// --only <prefix>: shoot just the states whose name starts with it (both themes),
// so one surface can be photographed without walking every state before it
const argOnly = process.argv.indexOf('--only');
const ONLY = argOnly > -1 ? process.argv[argOnly + 1] : '';

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
// a brain with no wiki/ (notes/ + decisions/, Sam's own shape): the brain verbs
// and the graph run the REAL code on this switch (fixtures.mjs adoptedBrain)
add('member-brain-adopted', '/member?brain=adopted', { waitMs: 2500, after: nav('brain', 3500) });
// the Network page (spec 2026-08-04): solo world and org-owned world
// (?world=org flips the harness fixture). The third state used to be a
// chip-click -> roster-row flash; the 2026-08-10 rebuild took the orbiting
// device chips (.ndev) off the map entirely and moved every computer into the
// plain roster list UNDER the map, so there is no on-map device to click and no
// flash to catch. Deleted rather than repointed: the only clickable node left
// is a rock's fleet card, which exists solely in the org world and navigates
// away to Pebbles, so a shot of it would document the Pebbles page, not this one.
// The Map itself retired 2026-09-09 (simple assistant): the device roster it
// carried is photographed on Your mineral (member-seat).
// The rock-brain reader died with the Organisations page (face collapse,
// 2026-09-01) and the Communities page with the simple-assistant strip
// (2026-09-09): nothing box-to-box is left to photograph.
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
// Scripts on a schedule (spec 2026-10-17 adopt): the second list on the Skills
// page. The fixture has two switched-on scripts (one finished, one failed) and
// a host-only program that cannot run here. The shot opens the failing row and
// its folded output, and fails the run if the page grew a way to type a command.
add('member-scripts', '/member', { waitMs: 2500, after: async (page) => {
  await nav('skills', 1500)(page);
  const box = page.locator('#scriptsBox');
  await box.scrollIntoViewIfNeeded();
  const rows = await page.$$eval('#scriptsList .cadrow', (els) => els.map((e) => ({
    id: e.getAttribute('data-script'), on: !!e.querySelector('.toggle.on'), failed: !!e.querySelector('.info .chip.bad'),
  })));
  if (rows.length !== 3) throw new Error(`expected 3 script rows, got ${JSON.stringify(rows)}`);
  if (rows.filter((r) => r.on).length !== 2) throw new Error(`expected two scripts switched on: ${JSON.stringify(rows)}`);
  const typeable = await page.$$eval('#scriptsBox textarea, #scriptsBox input[type=text], #scriptsBox input:not([type]), #scriptsBox [contenteditable]', (els) => els.length);
  if (typeable) throw new Error(`the Scripts list has ${typeable} place(s) to type a command; rows come only from cockpit/scripts.json`);
  await page.locator('#scriptsList .cadrow[data-script="calendar-guard"] .info').click();
  await page.locator('#scriptsList .cadrow[data-script="calendar-guard"] details.sctail summary').click();
  await page.waitForTimeout(400);
} });
add('member-health-script', '/member', { waitMs: 4500, after: async (page) => {
  const txt = await page.$$eval('.mach li', (els) => els.map((e) => e.textContent));
  if (!txt.some((t) => /Script: Calendar guard/.test(t) && /failed/.test(t))) throw new Error(`the Health card does not show the failing script: ${JSON.stringify(txt)}`);
  const fold = page.locator('details.machfold').first();
  await fold.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
} });
// Move in (spec 2026-10-17 adopt § App surfaces): ?movein=1 is an adopted server
// mid move-in with five steps, one in each state, and three things still on the
// server. The shot checks every state rendered, nothing can be typed into, Move
// out asks on the page (no confirm(): the viewer blocks dialogs), and the
// confirmation is VISIBLE, not just in the DOM (trap 29).
add('member-movein', '/member?movein=1', { waitMs: 3000, after: async (page) => {
  let dialog = '';
  page.on('dialog', (d) => { dialog = d.type(); d.dismiss().catch(() => {}); });
  await navTo(page, 'movein', 1200);
  const states = await page.$$eval('section[data-sec="movein"] .mistep', (els) => els.map((e) => e.getAttribute('data-state')));
  for (const st of ['pending', 'approved', 'done', 'skipped', 'undone']) if (!states.includes(st)) throw new Error(`no ${st} step on the page: ${JSON.stringify(states)}`);
  if (states.length !== 8) throw new Error(`expected 8 steps, got ${states.length}`);
  // rehearsal T4 finding 5: the Telegram switch-over sits in its own group and cannot be pressed while moving in
  const tg = await page.$$eval('.mistep[data-step="telegram-cutover"] .mibtns button', (els) => els.map((e) => [e.textContent, e.disabled]));
  if (!tg.some(([t, d]) => t === 'Switch over' && d)) throw new Error(`the Telegram switch-over can be pressed while moving in: ${JSON.stringify(tg)}`);
  const tgWhy = await page.$eval('.mistep[data-step="telegram-cutover"] .miwait', (e) => e.textContent).catch(() => '');
  if (!/after you finish moving in/.test(tgWhy)) throw new Error(`the Telegram step does not say why it waits: ${tgWhy}`);
  const groups = await page.$$eval('#miGroups .migroup h3', (els) => els.map((e) => e.textContent));
  if (!groups.includes('After you move in')) throw new Error(`no "After you move in" group: ${JSON.stringify(groups)}`);
  // rehearsal T4 finding 8: the backup switch-over waits for GitHub, and says so
  const bk = await page.$$eval('.mistep[data-step="cutover-script-backup"] .mibtns button', (els) => els.map((e) => [e.textContent, e.disabled]));
  if (!bk.some(([t, d]) => t === 'Switch over' && d)) throw new Error(`the backup switch-over is offered before GitHub is connected: ${JSON.stringify(bk)}`);
  // the Telegram line says who reads the bot right now
  const sum = await page.$eval('#miSummary', (e) => e.textContent);
  if (!/your own program on the server answers your bot\. Crads-AI holds its details and sends nothing while you are moving in/.test(sum)) throw new Error(`the Telegram line: ${sum}`);
  const still = await page.$$eval('#miStill li', (els) => els.length);
  if (still !== 3) throw new Error(`expected 3 things still on the server, got ${still}`);
  const typeable = await page.$$eval('section[data-sec="movein"] textarea, section[data-sec="movein"] input, section[data-sec="movein"] [contenteditable]', (els) => els.length);
  if (typeable) throw new Error(`the Move in page has ${typeable} place(s) to type into`);
  // a switch-over waiting for its yes offers Approve, never Switch over
  const labels = await page.$$eval('.mistep[data-step="cutover-script-money-state"] .mibtns button', (els) => els.map((e) => e.textContent));
  if (!labels.includes('Approve') || labels.includes('Switch over')) throw new Error(`a pending switch-over shows ${JSON.stringify(labels)}`);
  await page.click('#miMoveOutAsk');
  const shown = await page.$eval('#miMoveOutConfirm', (e) => !!e.offsetParent && getComputedStyle(e).display !== 'none');
  if (!shown) throw new Error('the Move out confirmation is not visible');
  if (dialog) throw new Error(`the Move in page opened a ${dialog} dialog`);
  await page.locator('#miMoveOut').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
} });
// ?movein=half: the app stopped part way through two server steps. The checked
// one offers exactly its two ways out plus Check again; the unchecked one offers
// only Check the server; neither offers Apply, Undo or Switch over, and Finish
// moving in stays hidden while anything is part-way through.
add('member-movein-half', '/member?movein=half', { waitMs: 3000, after: async (page) => {
  await navTo(page, 'movein', 1200);
  const btns = async (id) => page.$$eval(`.mistep[data-step="${id}"] .mibtns button`, (els) => els.map((e) => e.textContent));
  const checked = await btns('cutover-script-money-state');
  if (JSON.stringify(checked) !== JSON.stringify(['Finish the step', 'Put it back as it was', 'Check again'])) throw new Error(`checked half-done step shows ${JSON.stringify(checked)}`);
  const fresh = await btns('telegram-cutover');
  if (JSON.stringify(fresh) !== JSON.stringify(['Check the server'])) throw new Error(`unchecked half-done step shows ${JSON.stringify(fresh)}`);
  const halves = await page.$$eval('.mistep[data-half]', (els) => els.length);
  if (halves !== 2) throw new Error(`expected 2 half-done steps, got ${halves}`);
  const chip = await page.$eval('.mistep[data-step="cutover-script-money-state"] .chip', (e) => e.textContent);
  if (chip !== 'part-way through') throw new Error(`the chip says ${chip}`);
  if (await page.$eval('#miFinishBox', (e) => !!e.offsetParent)) throw new Error('Finish moving in shows while a step is part-way through');
  await page.click('.mistep[data-step="telegram-cutover"] .mibtns button');
  await page.waitForTimeout(700);
  const note = await page.$eval('.mistep[data-step="telegram-cutover"] .minote', (e) => !!e.offsetParent && e.textContent).catch(() => '');
  if (!/switched on and running/.test(String(note))) throw new Error(`the check's answer is not visible on the step: ${note}`);
  await page.locator('.mistep[data-step="cutover-script-money-state"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
} });
add('member-movein-top', '/member?movein=1', { waitMs: 3000, after: async (page) => { await navTo(page, 'movein', 1200); } });
// Run it once on a job that asks Claude (rehearsal T4 finding 7): the call comes back
// "still running" and the page follows the run to its end, never saying it failed.
add('member-movein-runonce', '/member?movein=1', { waitMs: 3000, after: async (page) => {
  await navTo(page, 'movein', 1200);
  const btn = page.locator('.mistep[data-step="cutover-script-weekly"] .mibtns button', { hasText: 'Run it once' });
  await btn.click();
  await page.waitForTimeout(800);
  const mid = await page.$eval('.mistep[data-step="cutover-script-weekly"] .minote', (e) => [e.textContent, e.classList.contains('bad')]).catch(() => ['', false]);
  if (!/still running/.test(mid[0]) || mid[1]) throw new Error(`while it runs the step says ${JSON.stringify(mid)}`);
  await page.locator('.mistep[data-step="cutover-script-weekly"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
} });
// Move out says what stays behind: the folder's files and Crads-AI's commits (finding 1)
add('member-movein-moveout', '/member?movein=1', { waitMs: 3000, after: async (page) => {
  await navTo(page, 'movein', 1200);
  await page.click('#miMoveOutAsk');
  await page.click('#miMoveOutYes');
  await page.waitForTimeout(900);
  const t = await page.$eval('#miNotice', (e) => e.textContent);
  if (!/stay in your folder/.test(t) || !/stay in your git history; nothing was rewritten/.test(t) || !/3f2a9c1 kernel: session/.test(t)) throw new Error(`Move out's answer: ${t}`);
  await page.locator('#miNotice').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
} });
add('member-movein-hidden', '/member', { waitMs: 3000, after: async (page) => {
  const vis = await page.$eval('#moveInNav', (e) => !!e.offsetParent);
  if (vis) throw new Error('the Move in tab shows on a mineral that is not moving in');
} });
add('member-health-still', '/member?movein=done', { waitMs: 4500, after: async (page) => {
  const fold = page.locator('details.stillfold').first();
  if (!(await fold.count())) throw new Error('the Health card has no "Still on the server" fold after the move-in');
  await fold.locator('summary').click();
  await fold.scrollIntoViewIfNeeded();
  // after Finish the Move in tab stays: the Telegram switch-over opens there, and Move out stays reachable
  const vis = await page.$eval('#moveInNav', (e) => !!e.offsetParent);
  if (!vis) throw new Error('the Move in tab went away after Finish, taking the Telegram step and Move out with it');
  await page.waitForTimeout(300);
} });
add('member-movein-done', '/member?movein=done', { waitMs: 3000, after: async (page) => {
  await navTo(page, 'movein', 1200);
  const sum = await page.$eval('#miSummary', (e) => e.textContent);
  if (!/^You have moved in\./.test(sum) || !/sends you the results of jobs set to "Send me the result"/.test(sum)) throw new Error(`after Finish the summary says ${sum}`);
  const tg = await page.$$eval('.mistep[data-step="telegram-cutover"] .mibtns button', (els) => els.map((e) => [e.textContent, e.disabled]));
  if (!tg.some(([t, d]) => t === 'Switch over' && !d)) throw new Error(`after Finish the Telegram switch-over is not offered: ${JSON.stringify(tg)}`);
  if (await page.$eval('#miFinishBox', (e) => !!e.offsetParent)) throw new Error('Finish moving in shows after the move-in finished');
  await page.locator('.mistep[data-step="telegram-cutover"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
} });
add('member-skills-rocks', '/member', { waitMs: 2500, after: async (page) => {
  await nav('skills', 1500)(page);
  await page.locator('#skillsGroups .skgroup[data-group="rocks"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
} });
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
// Remote Control (2026-10-14): the Phone card, on by default, driven through its
// off switch and back. Asserts what the member reads, from the real DOM.
add('connections-phone', '/member', { waitMs: 2500, after: async (page) => {
  await nav('connections', 1500)(page);
  await page.waitForFunction(() => document.getElementById('rcChip').textContent === 'on', null, { timeout: 5000 });
  await page.click('#rcToggle');
  if (await page.$eval('#rcName', (e) => e.textContent) !== 'Aster') throw new Error('the card does not name the assistant');
  await page.click('#rcSwitch');
  await page.waitForFunction(() => document.getElementById('rcChip').textContent === 'off', null, { timeout: 5000 });
  if (await page.$eval('#rcSwitch', (e) => e.textContent) !== 'Switch on') throw new Error('switched off, but the button does not offer to switch back on');
  await page.click('#rcSwitch');
  await page.waitForFunction(() => document.getElementById('rcChip').textContent === 'on', null, { timeout: 5000 });
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

for (const shot of SHOTS.filter((x) => !ONLY || x.name.startsWith(ONLY))) {
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
