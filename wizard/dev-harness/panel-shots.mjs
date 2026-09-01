#!/usr/bin/env node
// panel-shots.mjs — org-panel-only screenshot rig for the UI-overhaul loop.
// Same harness + protocol as shots.mjs / member-shots.mjs, but shoots ONLY
// /panel states so an iteration on panel.html can self-verify quickly.
// Includes keyboard-focused variants so static shots can SHOW focus rings.
//
//   cd wizard/dev-harness && node panel-shots.mjs --out <dir> [--port 4634]

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { nav } from './nav.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

const argOut = process.argv.indexOf('--out');
const OUT = argOut > -1 ? resolve(process.argv[argOut + 1])
  : join(REPO, 'docs', 'superpowers', 'ui-overhaul', 'shots', 'panel-iter');
const argPort = process.argv.indexOf('--port');
const PORT = argPort > -1 ? parseInt(process.argv[argPort + 1], 10) : 4634;
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
// Tab until a specific element holds keyboard focus, so :focus-visible is
// genuinely earned (never synthesized) and the ring is IN the shot.
async function tabTo(page, id, max = 40) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => document.activeElement && document.activeElement.id) === id) return true;
  }
  throw new Error(`tabTo: never reached #${id}`);
}

// Freeze the skeleton shimmer at a KNOWN sweep offset so the loading/mid pair
// captures provably distinct highlight positions (negative animation-delay +
// paused = deterministic frame; the live app still animates normally).
const freezeShimmer = (offsetSec) => async (page) => {
  await page.addStyleTag({ content: `.skel .ln::after{animation-play-state:paused!important;animation-delay:${offsetSec}s!important}` });
  await page.waitForTimeout(120);
};
add('panel', '/panel', { waitMs: 3500 });
add('panel-loading', '/panel', { waitMs: 300, after: freezeShimmer(-0.35) });   // highlight near the line END
add('panel-skeleton-mid', '/panel', { waitMs: 900, after: freezeShimmer(-1.15) });  // highlight around line CENTER
add('panel-empty', '/panel?state=empty', { waitMs: 3500 });
add('panel-error', '/panel?state=error', { waitMs: 3500 });
add('panel-error-gated', '/panel?state=error', { waitMs: 3500, full: false });
add('panel-error-late', '/panel?state=error', { waitMs: 2500, after: async (page) => {
  for (let i = 0; i < 4; i++) { await page.click('#connRetry'); await page.waitForTimeout(600); }
  await page.click('#connError summary');
  await page.waitForTimeout(300);
} });
// group-aware nav lives in nav.mjs now, shared by every rig. This file used to
// carry a hand-kept sec -> group map, and its own comment recorded that map
// going stale once already ('automations' was renamed 'assistant' on
// 2026-08-10). The shared helper asks the page which group owns a tab, so a
// regrouping cannot rot it. `navTo(sec, ms)` here keeps this file's curried
// shape: the shots below pass it straight in as an `after` hook.
const navTo = nav;
add('panel-focus', '/panel', { waitMs: 3000, after: async (page) => {
  for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
  await page.waitForTimeout(250);
} });
add('panel-focus-primary', '/panel', { waitMs: 3000, after: async (page) => {
  // ring on the Pebbles page's PRIMARY button (+ New pebble)
  await navTo('pebbles', 1500)(page);
  await tabTo(page, 'addMemberBtn');
  await page.waitForTimeout(250);
} });
add('panel-focus-input', '/panel', { waitMs: 2500, after: async (page) => {
  await navTo('pebbles', 800)(page);
  await page.evaluate(() => { document.getElementById('stampFold').open = true; });
  await page.click('#stOwnMember');
  await page.focus('#st_name');
  await page.waitForTimeout(250);
} });
// R17 (2026-08-23): Help is a page, not a modal; the keyboard path lands on
// the section and the footer link lights.
add('panel-focus-help', '/panel', { waitMs: 3000, after: async (page) => {
  await tabTo(page, 'helpLink');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(450);
} });
add('panel-pebbles', '/panel', { waitMs: 2500, after: navTo('pebbles', 2000) });
add('panel-pebbles-empty', '/panel?state=empty', { waitMs: 2500, after: navTo('pebbles', 2000) });
// Catalogue (was Publishing). The shot names keep the -publish suffix so the
// ledger's before/after pairs still line up across the rename.
add('panel-publish', '/panel', { waitMs: 2500, after: navTo('publish', 1500) });
add('panel-publish-empty', '/panel?state=empty', { waitMs: 2500, after: navTo('publish', 1500) });
add('panel-publish-focus', '/panel', { waitMs: 2500, after: async (page) => {
  await navTo('publish', 1200)(page);
  await page.focus('#catRows .catrow .seg button');
  await page.waitForTimeout(250);
} });
// The state the old page could not show at all: pending edits, named, with the
// save bar up and the edited rows outlined.
add('panel-publish-dirty', '/panel', { waitMs: 2500, after: async (page) => {
  await navTo('publish', 1500)(page);
  await page.click('[data-cat-id="weekly-review"] [data-seg="mem"] button[data-v="custom"]');
  await page.waitForTimeout(300);
  await page.click('[data-cat-id="daily-brief"] [data-seg="comm"] button[data-v="off"]');
  await page.waitForTimeout(400);
} });
add('panel-decisions', '/panel', { waitMs: 2500, after: navTo('decisions', 3200) });
add('panel-decisions-empty', '/panel?state=empty', { waitMs: 2500, after: navTo('decisions', 3200) });
add('panel-invite-midstep', '/panel', { waitMs: 2500, after: async (page) => {
  await navTo('pebbles', 800)(page);
  await page.evaluate(() => { document.getElementById('stampFold').open = true; });
  await page.click('#stOwnMember');
  await page.fill('#st_name', 'Jane Doe');
  await page.fill('#st_email', 'jane@example.com');
  await page.route('**/run', async (route) => {
    if ((route.request().postData() || '').includes('invite-member')) {
      await new Promise((r) => setTimeout(r, 5000));
    }
    await route.continue().catch(() => {});
  });
  await page.click('#stampBtn');
  await page.waitForTimeout(900);
} });
add('panel-invite', '/panel', { waitMs: 2500, after: async (page) => {
  await navTo('pebbles', 800)(page);
  await page.evaluate(() => { document.getElementById('stampFold').open = true; });
  await page.click('#stOwnMember');
  await page.fill('#st_name', 'Jane Doe');
  await page.fill('#st_email', 'jane@example.com');
  await page.click('#stampBtn');
  await page.waitForTimeout(2600);
} });
add('panel-yourrock', '/panel', { waitMs: 2500, after: navTo('yourrock', 1800) });
add('panel-yourrock-danger', '/panel', { waitMs: 2500, full: false, after: async (page) => {
  // the danger cards fold under Your rock now; scroll them on camera
  await navTo('yourrock', 1800)(page);
  await page.evaluate(() => { const el = document.getElementById('dzBtn'); if (el) el.scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(400);
} });
// S5: the org brain rides the shared graph viewer (data-sec="brain"); the
// shot walks the same surface a member sees — graph, tree, in-panel reader
add('panel-orgbrain', '/panel', { waitMs: 2500, after: async (page) => {
  await navTo('brain', 2200)(page);
  await page.locator('#treeRows button').first().click();
  await page.waitForTimeout(900);
} });
add('panel-terminal', '/panel', { waitMs: 2500, after: async (page) => {
  await navTo('terminal', 300)(page);
  await page.click('#termBtn');
  await page.waitForTimeout(2500);
} });
// P3: the rehomed console surfaces + the rock Map + the org sharing floor
add('panel-rocks', '/panel', { waitMs: 2500, after: navTo('rocks', 2200) });
add('panel-map', '/panel', { waitMs: 2500, after: navTo('network', 2600) });
add('panel-map-empty', '/panel?state=empty', { waitMs: 2500, after: navTo('network', 2600) });
add('panel-sharing', '/panel', { waitMs: 2500, after: navTo('sharing', 1800) });
add('panel-help', '/panel', { waitMs: 2500, after: async (page) => {
  await page.click('#helpLink');
  await page.waitForTimeout(400);
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
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 400)); });
  page.on('pageerror', (err) => errors.push(`pageerror: ${String(err).slice(0, 400)}`));
  try {
    await page.goto(BASE + shot.path, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(shot.waitMs || 2500);
    if (shot.after) await shot.after(page);
    const file = join(OUT, `${shot.name}.png`);
    await page.screenshot({ path: file, fullPage: shot.full !== false });
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
