#!/usr/bin/env node
// shots.mjs — baseline screenshot rig for the UI overhaul.
//
// Boots harness.mjs on a scratch port, drives every surface × theme × state
// with Playwright, saves full-page PNGs to
//   docs/superpowers/ui-overhaul/shots/baseline/
// and writes a per-shot console-error summary to console-report.json there.
//
//   cd wizard/dev-harness && npm i && node shots.mjs [--out <dir>] [--port 4611]

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
  : join(REPO, 'docs', 'superpowers', 'ui-overhaul', 'shots', 'baseline');
const argPort = process.argv.indexOf('--port');
const PORT = argPort > -1 ? parseInt(process.argv[argPort + 1], 10) : 4611;
const BASE = `http://localhost:${PORT}`;

mkdirSync(OUT, { recursive: true });

// ---- boot the harness -------------------------------------------------------
const harness = spawn(process.execPath, [join(HERE, 'harness.mjs'), '--port', String(PORT)], { stdio: 'pipe' });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('harness did not start')), 8000);
  harness.stdout.on('data', (d) => { if (String(d).includes('dev-harness up')) { clearTimeout(t); res(); } });
  harness.on('exit', (c) => rej(new Error(`harness exited early (${c})`)));
});

// ---- shot plan ---------------------------------------------------------------
// waitMs is tuned to each page's own polling timers (panel fills its pending /
// join-request / activity / invite lists on 3–5s timeouts after load).
const SHOTS = [];
const THEMES = ['light', 'dark'];
function add(name, path, opts = {}) {
  for (const theme of THEMES) SHOTS.push({ name: `${name}-${theme}`, path, theme, ...opts });
}

add('panel', '/panel', { waitMs: 6500 });
add('panel', '/panel?state=empty', { waitMs: 6500, suffix: 'empty' });
add('panel', '/panel?state=error', { waitMs: 4000, suffix: 'error' });
add('panel-terminal', '/panel', { waitMs: 2500, after: async (page) => {
  await navTo(page, 'terminal', 0);   // top-level today; navTo survives it being grouped
  await page.click('#termBtn');
  await page.waitForTimeout(2500);
} });
add('member', '/member', { waitMs: 3500 });
add('member', '/member?state=empty', { waitMs: 3500, suffix: 'empty' });
add('member', '/member?state=error', { waitMs: 3500, suffix: 'error' });
// Brain sits inside the collapsed "Your assistant" group (2026-08-04), so the
// group has to be opened before the tab can be clicked: nav() does both.
add('member-brain', '/member', { waitMs: 2500, after: nav('brain', 3500) });
// The door's states, captured 2026-08-13. Until then only the default was
// shot, and its fixtures were three fields behind production, so the connect
// row had never appeared in a screenshot and findings 8 and 9 survived a UI
// certification pass (finding 10). `rich` now carries an off-device mineral,
// an org-held one and a key-only one, so every row shape is drawn.
add('door', '/door', { waitMs: 2500 });
add('door', '/door?state=empty', { waitMs: 2500, suffix: 'empty' });   // fresh install: the takeover owns the screen
add('door', '/door?state=error', { waitMs: 2500, suffix: 'error' });   // boxes not answering: the machine list must still stand
// (the connect / wizard / join surfaces were deleted 2026-09-01; their shots
// went with them)

// suffix goes before the theme in the filename: panel-light-empty.png
for (const s of SHOTS) if (s.suffix) s.name = s.name.replace(/-(light|dark)$/, (m, t) => `-${t}-${s.suffix}`);

// ---- run ----------------------------------------------------------------------
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
    await page.goto(BASE + shot.path, { waitUntil: shot.waitUntil || 'load', timeout: 20000 });
    await page.waitForTimeout(shot.waitMs || 2500);
    if (shot.after) await shot.after(page);
    const file = join(OUT, `${shot.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const bytes = statSync(file).size;
    const { w, h } = pngDims(file);
    report[shot.name] = { path: shot.path, theme: shot.theme, bytes, width: w, height: h, consoleErrors: errors };
    console.log(`✓ ${shot.name}.png ${w}x${h} ${(bytes / 1024).toFixed(0)}kB${errors.length ? ` · ${errors.length} console error(s)` : ''}`);
  } catch (e) {
    failures++;
    report[shot.name] = { path: shot.path, theme: shot.theme, error: String(e.message || e), consoleErrors: errors };
    console.error(`✗ ${shot.name}: ${e.message || e}`);
  }
  await ctx.close();
}

await browser.close();
harness.kill();

function pngDims(file) {
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

writeFileSync(join(OUT, 'console-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\nreport → ${join(OUT, 'console-report.json')}`);
if (failures) { console.error(`${failures} shot(s) failed`); process.exit(1); }
