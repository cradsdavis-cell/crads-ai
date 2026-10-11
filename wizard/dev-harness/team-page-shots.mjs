// team-page-shots.mjs: the panel's Team page (Crads for teams, stage 2) in a real
// browser against the harness fixtures: the company agent's view (approvals +
// Slack), a staff member's view, and a box not in a team (nav entry hidden).
//   cd wizard/dev-harness && npm i && node team-page-shots.mjs [out-dir] [port]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || join(tmpdir(), 'team-page-shots');
const PORT = parseInt(process.argv[3] || '4671', 10);
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });
const harness = spawn(process.execPath, [join(HERE, 'harness.mjs'), '--port', String(PORT)], { stdio: 'pipe' });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('harness did not start')), 8000);
  harness.stdout.on('data', (d) => { if (String(d).includes('dev-harness up')) { clearTimeout(t); res(); } });
});
const browser = await chromium.launch();
const errors = [];
const result = {};
async function view(name, url, fn) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  await page.goto(BASE + url, { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  await fn(page);
  await page.close();
}
await view('hub', '/member?team=hub', async (page) => {
  result.hubNavVisible = await page.isVisible('#teamNav');
  result.hubNavCount = await page.getAttribute('#teamNav', 'data-count');
  await page.click('#teamNav');
  await page.waitForSelector('.proposal', { timeout: 8000 });
  await page.screenshot({ path: join(OUT, 'team-hub.png'), fullPage: true });
  result.hubProposals = await page.locator('.proposal').count();
  result.hubWarnings = await page.locator('.proposal').nth(1).innerText();
  await page.locator('.proposal').first().locator('[data-verdict="approve"]').click();
  await page.waitForSelector('#teamDecideNotice', { state: 'visible', timeout: 8000 });
  result.approveNotice = await page.textContent('#teamDecideNotice');
  await page.screenshot({ path: join(OUT, 'team-hub-approved.png'), fullPage: true });
});
await view('member', '/member?team=member', async (page) => {
  await page.click('#teamNav');
  await page.waitForSelector('#teamMember', { state: 'visible', timeout: 8000 });
  result.memberLine = await page.textContent('#teamLine');
  await page.screenshot({ path: join(OUT, 'team-member.png'), fullPage: true });
});
await view('none', '/member', async (page) => {
  result.noTeamNavVisible = await page.isVisible('#teamNav');
});
writeFileSync(join(OUT, 'result.json'), JSON.stringify({ ...result, errors }, null, 2));
console.log(JSON.stringify({ ...result, errors }, null, 1));
await browser.close();
harness.kill();
