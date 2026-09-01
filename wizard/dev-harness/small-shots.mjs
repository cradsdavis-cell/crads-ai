#!/usr/bin/env node
// small-shots.mjs — screenshot rig for the four SMALL surfaces of the UI overhaul:
// door, member-connect, wizard, join. Same harness + protocol as shots.mjs /
// member-shots.mjs, scoped so an iteration on these files can self-verify quickly.
//
//   cd wizard/dev-harness && node small-shots.mjs --out <dir> [--port 4630]
//
// Evidence set per surface × theme: default composition, keyboard-focus evidence
// (the final movement is always a Tab press, forcing :focus-visible on camera),
// plus the key interaction states: door hover + empty + loading skeleton, connect
// collapsed / expanded / redeemed / approved, wizard step 1 + collapsed-intro step 2
// + accounts step + provision mid-stream + done + fail, join default (download
// fallback) + bad-link + app-probe spinner.
//
// A shot may carry `init(page)` — it runs BEFORE page.goto (addInitScript /
// page.route holds), which is how the loading and fail states are rigged without
// touching the harness.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { joinFragment, ROCK_HOST } from './fixtures.mjs';

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

// drive the wizard form to the provision stream: fill via sessionStorage-backed
// inputs, then walk Continue through validation to the build step
async function wizardToBuild(page) {
  await page.fill('#org_name', 'acme-collab');
  await page.fill('#operators', 'ops@acme-collab.com');
  await page.fill('#domain', 'acme-collab.com');
  for (let i = 0; i < 3; i++) { await page.click('#next'); await page.waitForTimeout(120); }
  await page.fill('#hcloud_token', 'tok-hetzner-demo');
  await page.fill('#cf_api_token', 'tok-cf-demo');
  await page.fill('#github_token', 'tok-gh-demo');
  await page.click('#next'); await page.waitForTimeout(120);          // -> rules
  await page.selectOption('#region', 'hel1');
  await page.click('#next'); await page.waitForTimeout(120);          // -> review
  await page.click('#next');                                          // Build my hub -> stream
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

// ---- member-connect ----------------------------------------------------------
add('connect', '/connect', { waitMs: 2500 });                          // triaged default: folds closed
// One fold left. `5b75c69` ("the invite page is the invite claim, and nothing
// else") deleted the manual typed-IP setup (#manualFold) and the your-rocks
// picker (#orgsFold) on 2026-08-09; ask-to-join (#joinFold) is what survived.
// Six TESTS were rewritten in that commit and this rig was not, because it is
// not a test file, so five of its shots spent every run waiting 30s on a
// summary that no longer exists: 10 failures, permanently, on a clean tip.
add('connect-expanded', '/connect', { waitMs: 2500, after: async (page) => {
  await page.click('#joinFold summary');
  await page.waitForTimeout(300);
} });
add('connect-redeemed', '/connect', { waitMs: 2000, after: async (page) => {
  await page.fill('#inviteLink', 'https://crads-ai.com/join#v1.demo.mel.x');
  await page.click('#redeemBtn');
  await page.waitForTimeout(1200);    // fingerprint + tier + staged note; before the 4s auto-approve poll
} });
add('connect-approved', '/connect', { waitMs: 2000, after: async (page) => {
  await page.fill('#inviteLink', 'https://crads-ai.com/join#v1.demo.mel.x');
  await page.click('#redeemBtn');
  await page.waitForTimeout(5200);    // poll tick fired: the approved UI (the Claude Code fold went out with 5b75c69)
} });
add('connect-focus', '/connect', { waitMs: 2500, after: async (page) => {
  await page.focus('#inviteLink');
  await page.waitForTimeout(100);
  await page.keyboard.press('Shift+Tab');   // back onto the Home link…
  await page.keyboard.press('Tab');         // …and forward: input carries the ring
  await page.waitForTimeout(250);
} });
// connect-manual-keyed retired with the surface it shot: the manual setup's
// slug/host/generate flow went out in 5b75c69, so there is nothing to key.
// error state: an invite the server rejects -> .msg.err on camera (certification gap)
add('connect-error', '/connect', { waitMs: 2000, after: async (page) => {
  await page.route('**/redeem', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ error: 'That invite has expired. Ask your rock to send a fresh one; they take a minute to make.' }),
  }));
  await page.fill('#inviteLink', 'https://crads-ai.com/join#v1.eyJleHBpcmVkIjp0cnVlfQ');
  await page.click('#redeemBtn');
  await page.waitForTimeout(400);
} });
// in-flight state: route-hold the redeem so the disabled busy button is on camera
add('connect-inflight', '/connect', { waitMs: 2000, after: async (page) => {
  await page.route('**/redeem', () => { /* hold forever: button stays busy */ });
  await page.fill('#inviteLink', 'https://crads-ai.com/join#v1.eyJwZW5kaW5nIjp0cnVlfQ');
  await page.click('#redeemBtn');
  await page.waitForTimeout(400);
} });
// hover state: fold-row hover treatment on camera (certification gap)
add('connect-hover', '/connect', { waitMs: 2000, after: async (page) => {
  await page.hover('#joinFold summary');
  await page.waitForTimeout(250);
} });
// focus evidence beyond the input: a fold-row summary carrying the double ring
add('connect-focus-fold', '/connect', { waitMs: 2000, after: async (page) => {
  await page.focus('#joinFold summary');
  await page.waitForTimeout(250);
} });

// ---- wizard --------------------------------------------------------------------
add('wizard', '/wizard', { waitMs: 1500 });
add('wizard-focus', '/wizard', { waitMs: 1500, after: async (page) => {
  await page.focus('#org_name');
  await page.waitForTimeout(250);     // accent border + double ring on the first input
} });
add('wizard-step2', '/wizard', { waitMs: 1500, after: async (page) => {
  await page.fill('#org_name', 'acme-collab');
  await page.fill('#operators', 'ops@acme-collab.com');
  await page.fill('#domain', 'acme-collab.com');
  await page.click('#next');
  await page.waitForTimeout(250);     // adaptive intro: one quiet line, full block behind the chevron
} });
add('wizard-accounts', '/wizard', { waitMs: 1500, after: async (page) => {
  await page.fill('#org_name', 'acme-collab');
  await page.fill('#operators', 'ops@acme-collab.com');
  await page.fill('#domain', 'acme-collab.com');
  for (let i = 0; i < 3; i++) { await page.click('#next'); await page.waitForTimeout(120); }
  await page.click('.acct details.guide-steps summary');   // one guide open for the shot
  await page.waitForTimeout(250);
} });
add('wizard-provision-mid', '/wizard', { waitMs: 1200, after: async (page) => {
  await wizardToBuild(page);
  await page.waitForTimeout(900);     // mid-stream: steps board part-done, log scrolling
} });
add('wizard-provision-done', '/wizard', { waitMs: 1200, after: async (page) => {
  await wizardToBuild(page);
  await page.waitForTimeout(3500);    // __DONE__: all steps ticked + success card + panel CTA
} });
add('wizard-provision-fail', '/wizard', { waitMs: 1200, init: async (page) => {
  await page.route('**/provision*', (route) => {
    const lines = [
      '▸ checking your three access codes…',
      'Hetzner token OK (project: driftwood)',
      'ERROR: Cloudflare said this token is not authorised for zone acme-collab.com',
      '__FAIL__ exit 1',
    ];
    route.fulfill({ status: 200, contentType: 'text/event-stream',
      body: lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join('') });
  });
}, after: async (page) => {
  await wizardToBuild(page);
  await page.waitForTimeout(800);     // errbox + Try again + failed step row
} });

// ---- join ----------------------------------------------------------------------
// The join page immediately tries the crads-ai:// app scheme, which aborts the
// browser 'load' event in headless Chromium — wait on 'commit' instead. After
// the 2s app-probe times out, the download-fallback card is showing.
add('join', `/join${joinFragment()}`, { waitMs: 3500, waitUntil: 'commit' });
add('join-opening', `/join${joinFragment()}`, { waitMs: 700, waitUntil: 'commit' });   // inside the 2s app-probe window: spinner card
add('join-badlink', '/join#v1.broken', { waitMs: 1200, waitUntil: 'commit' });
add('join-focus', `/join${joinFragment()}`, { waitMs: 3500, waitUntil: 'commit', after: async (page) => {
  await page.keyboard.press('Tab');   // download button takes the double ring
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
