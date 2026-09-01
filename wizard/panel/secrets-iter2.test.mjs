// secrets-iter2.test.mjs: the Secrets page after panel iteration 2 (R7 the
// read-only ledger, R8 revoke lives at the connection;
// docs/superpowers/specs/2026-08-23-panel-iteration-2.md).
//
// Structural pins (trap 6), then a drive of the real page against the
// dev-harness fixtures' secrets-discover rows (one of every kind and every
// revoke route).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');
const sec = html.slice(html.indexOf('<section data-sec="secrets">'), html.indexOf('<section data-sec="seat">'));
const js = html.split('// ---- Secrets (R7, panel iteration 2)')[1].split('// ---- network: point the frame')[0];

test('one read-only ledger: no Add form, no Reveal, no Delete, no writer verbs on the page', () => {
  for (const gone of ['id="secSave"', 'id="secName"', 'id="secValue"', 'Add a secret', 'id="secretsRows"', 'id="secDiscovered"', 'data-secdel', 'data-secshow']) {
    assert.ok(!sec.includes(gone) && !js.includes(gone), `gone from the page: ${gone}`);
  }
  for (const verb of ["run('secrets-put'", "run('secrets-remove'", "vaultCall('seal'", "vaultCall('open'", "run('secrets-list'"]) {
    assert.ok(!html.includes(verb), `no client call left: ${verb}`);
  }
  assert.ok(sec.includes('id="secLedger"'), 'the ledger container');
  assert.match(js, /run\('secrets-discover', \{\}\)/, 'the one source');
  assert.doesNotMatch(html, /function loadDiscovered\(/, 'the second list is folded into the one ledger');
  // device enrolment still re-seals cold secrets through the loopback routes
  assert.match(js, /function syncVaultKey\(\)/, 'syncVaultKey survives (Devices re-seals through it)');
  assert.match(js, /vaultCall\('rewrap'\)/);
});

test('rows are grouped by kind, label bold, what on the line, where only on hover, a state chip', () => {
  for (const k of ['sign-in', 'connection', 'channel', 'backup', 'platform', 'vault']) assert.match(js, new RegExp(`key: '${k}'`), `kind ${k}`);
  const row = js.split('function secRowHtml(f)')[1].split('function loadSecrets()')[0];
  assert.match(row, /title="' \+ esc\(f\.where \|\| ''\)/, 'where rides the hover only');
  assert.match(row, /<b>' \+ esc\(f\.label \|\| f\.name\)/, 'the human label leads');
  assert.doesNotMatch(row, /<b>[^<]*esc\(f\.name\)/, 'the machine name is never the visible label');
  assert.match(row, /\(f\.set \? 'set' : 'not set'\)/, 'the state chip');
  assert.match(row, /if \(f\.what\) parts\.push\(esc\(f\.what\)\)/, 'what, one line, and only when there is one (old-image rows have none)');
});

test('revoke links deep-link to the surface that owns the credential; none renders nothing', () => {
  const rv = js.split('function secRevoke(f)')[1].split('function secRowHtml(')[0];
  assert.match(rv, /r\.via === 'connections'\) return \{ sec: 'connections', label: 'Connections', key: r\.key \|\| ''/);
  assert.match(rv, /r\.via === 'seat'\) return \{ sec: IS_ORG \? 'yourrock' : 'seat'/, 'the seat page per face');
  assert.match(rv, /r\.via === 'telegram'\) return \{ sec: 'connections', label: 'Telegram'/, 'Telegram lives on Connections');
  assert.match(rv, /return null;\s*\}$/m, 'none = no link');
  assert.match(js, /activateSec\(sec\);/, 'the click navigates');
  assert.match(js, /#mcpRows \[data-mcp-remove="' \+ key \+ '"\]/, 'and lands on the row that disconnects it');
});

test('page head: the ruled sentence, the explainer in a bubble, no em dashes', () => {
  assert.ok(sec.includes('<p>Every password, token and key this mineral holds, and what each one is for.</p>'));
  assert.match(sec, /<h2>Secrets<button class="info"/);
  const tip = (sec.match(/data-tip="([^"]*)"/) || [])[1] || '';
  assert.ok(/never leave the mineral/.test(tip) && /revoke/i.test(tip), 'bubble: values never leave; revoke from the connection');
  assert.ok(!/—/.test(sec) && !/—/.test(js), 'zero em dashes');
});

let chromium = null;
try { ({ chromium } = await import(join(HERE, '..', 'dev-harness', 'node_modules', 'playwright', 'index.mjs'))); } catch { /* no local playwright */ }

test('driven: grouped ledger, no form, revoke link lands on the Connections row', { skip: !chromium && 'playwright not installed under wizard/dev-harness' }, async () => {
  const PORT = 4000 + Math.floor(Math.random() * 2000);
  const harness = spawn(process.execPath, [join(HERE, '..', 'dev-harness', 'harness.mjs'), '--port', String(PORT)], { stdio: 'pipe' });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('harness did not start')), 8000);
    harness.stdout.on('data', (d) => { if (String(d).includes('dev-harness up')) { clearTimeout(t); res(); } });
    harness.on('exit', (c) => rej(new Error('harness exited early ' + c)));
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://localhost:${PORT}/member`, { waitUntil: 'load' });
    await page.waitForTimeout(2000);
    await page.evaluate(() => { location.hash = '#secrets'; });
    await page.waitForTimeout(1800);
    assert.deepEqual(await page.locator('#secLedger .seckind').allTextContents(), ['Sign-in', 'Connections', 'Channels', 'Backups', 'Platform', 'Vault']);
    assert.equal(await page.locator('#secLedger .secrow').count(), 10, 'every discovered row renders (incl. the escrow marker, audit round three)');
    // textarea scoped to #secLedger (2026-08-25, Phase 5 task 3): the page
    // gained a real <textarea> elsewhere (the Catalogue pack-content editor),
    // so an unscoped `textarea` selector now also counts a field that has
    // nothing to do with Secrets. Scoping to the ledger keeps this assertion
    // meaning what it always meant: no writable field on THIS page.
    assert.equal(await page.locator('#secSave, [data-secdel], [data-secshow], #secLedger textarea').count(), 0, 'nothing writable');
    const text = await page.locator('#secLedger').innerText();
    assert.ok(!text.includes('telegram_bot_token') && !text.includes('.kernel/'), 'machine names and paths are not visible text');
    assert.equal(await page.locator('.secrow[data-secret="telegram_bot_token"]').getAttribute('title'), 'secrets/telegram_bot_token', 'where rides the hover');
    assert.equal(await page.locator('.secrow[data-secret="backup_passphrase"] .secrevoke').count(), 0, 'revoke none: no link');
    assert.equal(await page.locator('.secrow[data-secret="mcp-linear"] .chip').innerText(), 'not set');
    await page.locator('.secrevoke[data-revoke-key="notion"]').click();
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('section.active').getAttribute('data-sec'), 'connections', 'lands on Connections');
    assert.equal(await page.locator('#mcpRows li.justlanded:has([data-mcp-remove="notion"])').count(), 1, 'on the Notion row');
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    harness.kill();
  }
});
