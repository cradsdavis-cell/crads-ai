#!/usr/bin/env node
// small-shots.mjs — screenshot rig for the one SMALL surface left: the door.
// (member-connect, wizard and join were deleted 2026-09-01 with the invitation
// system and the hosted create flow; their shot sections went with them.)
// Same harness + protocol as shots.mjs / member-shots.mjs, scoped so an
// iteration on the door can self-verify quickly.
//
//   cd wizard/dev-harness && node small-shots.mjs --out <dir> [--port 4630]
//
// Evidence set per theme: default composition, keyboard-focus evidence (the
// final movement is always a Tab press, forcing :focus-visible on camera),
// plus the key interaction states: hover + empty + loading skeleton.
//
// A shot may carry `init(page)` — it runs BEFORE page.goto (addInitScript /
// page.route holds), which is how the loading and fail states are rigged without
// touching the harness.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ROCK_HOST } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

const argOut = process.argv.indexOf('--out');
const OUT = argOut > -1 ? resolve(process.argv[argOut + 1])
  : join(REPO, 'docs', 'superpowers', 'ui-overhaul', 'shots', 'small-iter');
const argPort = process.argv.indexOf('--port');
const PORT = argPort > -1 ? parseInt(process.argv[argPort + 1], 10) : 4630;
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

// ---- door ------------------------------------------------------------------
// the door remembers the identity opened last (localStorage); prime it so the
// default shot carries the anchor rail + LAST USED chip a returning user sees
const primeLastUsed = async (page) => {
  await page.addInitScript((host) => { try { localStorage.setItem('aios_door_last', host); } catch (e) { /* ignore */ } }, ROCK_HOST);
};
add('door', '/door', { waitMs: 2500, init: primeLastUsed });
add('door-empty', '/door?state=empty', { waitMs: 2000 });
add('door-pending', '/door?state=error', { waitMs: 2500 });   // boxes not answering: red dots + warn subs + forget links
add('door-loading', '/door', { waitMs: 900, init: async (page) => {
  await page.route('**/identities', () => { /* hold the request: skeleton stays on camera */ });
} });
add('door-hover', '/door', { waitMs: 2500, init: primeLastUsed, after: async (page) => {
  await page.hover('.id');            // first identity card: accent border + tint + lift + chevron slide
  await page.waitForTimeout(300);
} });
add('door-focus', '/door', { waitMs: 2500, init: primeLastUsed, after: async (page) => {
  await page.keyboard.press('Tab');   // first identity card takes the double-ring
  await page.waitForTimeout(250);
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
    if (shot.init) await shot.init(page);
    await page.goto(BASE + shot.path, { waitUntil: shot.waitUntil || 'load', timeout: 20000 });
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
