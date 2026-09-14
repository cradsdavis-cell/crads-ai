#!/usr/bin/env node
// local-shots.mjs: the LOCAL face (a brain folder on this computer, 2026-09-11)
// driven and photographed. Same harness + protocol as member-shots.mjs; the
// surfaces open with ?face=local, which fixtures.mjs answers with one local
// target and no server behind it.
//
//   cd wizard/dev-harness && node local-shots.mjs [--out <dir>] [--port 4665]
//
// Shots: the door with its three cards, the local flow (form + finish
// checklist), then the member face on the folder: Overview, Brain, Skills
// (the schedule strip hidden, the honest note in its place), Help (the folder
// copy where the connection name used to be). Full-page PNGs + a per-shot
// console-error report, so a broken page cannot photograph as a good one.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { nav } from './nav.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const argOut = process.argv.indexOf('--out');
const OUT = argOut > -1 ? resolve(process.argv[argOut + 1]) : join(REPO, 'docs', 'superpowers', 'ui-overhaul', 'shots', 'local-face');
const argPort = process.argv.indexOf('--port');
const PORT = argPort > -1 ? parseInt(process.argv[argPort + 1], 10) : 4665;
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });

const harness = spawn(process.execPath, [join(HERE, 'harness.mjs'), '--port', String(PORT)], { stdio: 'pipe' });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('harness did not start')), 8000);
  harness.stdout.on('data', (d) => { if (String(d).includes('dev-harness up')) { clearTimeout(t); res(); } });
  harness.on('exit', (c) => rej(new Error(`harness exited early (${c})`)));
});

const SHOTS = [
  // a fresh install: the takeover with THREE cards, "On this computer" third
  { name: 'door-three-cards', path: '/door?state=empty', waitMs: 2000 },
  // the local flow's one form
  { name: 'door-local-flow', path: '/door?state=empty', waitMs: 1500, after: async (page) => {
    await page.click('[data-make="local"]');
    await page.fill('#loName', 'Idris');
    await page.waitForTimeout(400);
  } },
  // the finish checklist after Make it
  { name: 'door-local-done', path: '/door?state=empty', waitMs: 1500, after: async (page) => {
    await page.click('[data-make="local"]');
    await page.fill('#loName', 'Idris');
    await page.click('#loMakeBtn');
    await page.waitForSelector('#loDone', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(800);
  } },
  // the door listing a folder beside nothing else
  { name: 'door-local-row', path: '/door?face=local', waitMs: 2500 },
  // the member face on the folder
  { name: 'member-local-overview', path: '/member?face=local', waitMs: 4000 },
  { name: 'member-local-brain', path: '/member?face=local', waitMs: 2500, after: nav('brain', 3000) },
  { name: 'member-local-skills', path: '/member?face=local', waitMs: 2500, after: nav('skills', 2500) },
  { name: 'member-local-seat', path: '/member?face=local', waitMs: 2500, after: nav('seat', 2500) },
  { name: 'member-local-help', path: '/member?face=local', waitMs: 2500, after: async (page) => { await page.click('#helpLink'); await page.waitForTimeout(1500); } },
];

const report = {};
const browser = await chromium.launch();
let failures = 0;
for (const shot of SHOTS) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 400)); });
  page.on('pageerror', (err) => errors.push(`pageerror: ${String(err).slice(0, 400)}`));
  try {
    await page.goto(BASE + shot.path, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(shot.waitMs || 2500);
    if (shot.after) await shot.after(page);
    // the facts a screenshot alone cannot prove: what the page HID and SAID
    const facts = await page.evaluate(() => {
      const vis = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return !!(r.width && r.height) && getComputedStyle(el).display !== 'none'; };
      return {
        face: document.body.dataset.face || null,
        navConnections: vis('#nav button[data-sec="connections"]'),
        navTerminal: vis('#nav button[data-sec="terminal"]'),
        navPrivacy: vis('#nav .navgroup[data-group="privacy"]'),
        cadGate: vis('#cadGate'), cadenceSave: vis('#cadenceSave'),
        firstToggle: vis('section[data-sec="skills"] .cadrow .toggle'),
        devicesCard: vis('#seatDevicesCard'), waitsCard: vis('#seatWaitsCard'),
        sshCard: vis('#ohHost'), folderCard: vis('#ohLocalCard'),
        notes: [...document.querySelectorAll('[data-needs-box-note]')].filter((n) => n.getBoundingClientRect().height).length,
        localCards: document.querySelectorAll('[data-make]').length,
        connStat: (document.getElementById('connStat') || {}).textContent || null,
        ohPath: (document.getElementById('ohPath') || {}).textContent || null,
      };
    });
    const file = join(OUT, `${shot.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const b = readFileSync(file);
    report[shot.name] = { path: shot.path, bytes: statSync(file).size, width: b.readUInt32BE(16), height: b.readUInt32BE(20), consoleErrors: errors, facts };
    console.log(`ok ${shot.name}.png ${report[shot.name].width}x${report[shot.name].height}${errors.length ? ` · ${errors.length} console error(s)` : ''} · ${JSON.stringify(facts)}`);
  } catch (e) {
    failures++;
    report[shot.name] = { path: shot.path, error: String(e.message || e), consoleErrors: errors };
    console.error(`FAIL ${shot.name}: ${e.message || e}`);
  }
  await ctx.close();
}
await browser.close();
harness.kill();
writeFileSync(join(OUT, 'console-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`report: ${join(OUT, 'console-report.json')}`);
if (failures) { console.error(`${failures} shot(s) failed`); process.exit(1); }
