// wizard/panel/guided-connect.test.mjs: run node --test wizard/panel/guided-connect.test.mjs
//
// The guided connections (2026-10-02, Sam's ruling after a pebble asked for
// Slack, WordPress, WooCommerce, Shopify and Xero). Slack and WordPress are
// wizards like Telegram's and Google's: they save a credential, then ask the
// box to call the server (mcp-check, contract 4), and a failed check removes
// what was saved. Shopify and Xero only connect through Claude's own
// connector, so their card is a guide that says what that costs.
//
// Static pins first (they run everywhere), then one driven walk through all
// four against the dev harness when playwright is installed locally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');
const guided = html.slice(html.indexOf('// ---- Guided connections (2026-10-02)'), html.indexOf('// The sign-in-kind pills'));

test('guided entries open their card before any probe or box write', () => {
  const fn = html.split('function mcpDirConnect(entry, btn){')[1].split('\n  }\n')[0];
  assert.ok(fn.indexOf('if (entry.guided) { guidedOpen(entry); return; }') > -1, 'the guided branch exists');
  assert.ok(fn.indexOf('guidedOpen(entry)') < fn.indexOf('/mcp-dir/probe'), 'and runs before the probe');
  assert.ok(fn.indexOf('guidedOpen(entry)') < fn.indexOf('mcpBoxOk'), 'an account guide needs no box, so it opens even when the box is quiet');
});

test('the wizards save, then check from the box, and take a failed save back off', () => {
  const connect = guided.split('function guidedConnect(')[1].split('\n  }\n')[0];
  assert.ok(connect.indexOf("run('mcp-add-custom'") > -1 && connect.indexOf("run('mcp-check'") > connect.indexOf("run('mcp-add-custom'"), 'save first, check second');
  assert.match(connect, /run\('mcp-remove', \{ key: def\.name \}\)/, 'a failed check removes the entry it just wrote');
  assert.match(connect, /if \(mcpContract < 4\) \{ notice\(nid, MCP_TOO_OLD\); return; \}/, 'a box without scheme basic + check is told to update, before anything is written');
  assert.match(guided, /scheme: 'basic'/, 'WordPress saves as HTTP Basic');
  assert.match(guided, /\/wp-json\/mcp\/mcp-adapter-default-server/, 'at the MCP adapter default server, the endpoint WooCommerce documents');
});

test('the Slack template switches MCP on and keeps the token from rotating', () => {
  const m = guided.match(/var SLACK_MANIFEST = (\{[\s\S]*?\n  \});/);
  assert.ok(m, 'the template is present');
  assert.match(m[1], /is_mcp_enabled: true/, 'without it Slack answers "App is not enabled for Slack MCP server access"');
  assert.match(m[1], /token_rotation_enabled: false/, 'a rotating token would die twelve hours after it was pasted');
  assert.match(m[1], /oauth_config: \{ scopes: \{ user: \[/, 'user scopes: the assistant sees what the member sees');
  assert.doesNotMatch(m[1], /scopes: \{ bot:/, 'no bot scopes: the bot user exists only because Slack sign-in needs one');
});

test('the account guide states its limit for each service', () => {
  for (const k of ['shopify', 'xero']) {
    const block = guided.split(`${k}: {`)[1].split('\n    }')[0];
    assert.match(block, /scheduled jobs/, `${k}: says scheduled jobs cannot see it`);
  }
  assert.match(guided.split('xero: {')[1].split('\n    }')[0], /read-only/, 'Xero says it is read-only');
});

let chromium = null;
try { ({ chromium } = await import(join(HERE, '..', 'dev-harness', 'node_modules', 'playwright', 'index.mjs'))); } catch { /* no local playwright */ }

test('driven: all four guided cards, a wrong credential refused and nothing kept, then a working one', { skip: !chromium && 'playwright not installed under wizard/dev-harness' }, async () => {
  const PORT = 4000 + Math.floor(Math.random() * 2000);
  const harness = spawn(process.execPath, [join(HERE, '..', 'dev-harness', 'harness.mjs'), '--port', String(PORT)], { stdio: 'pipe' });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('harness did not start')), 8000);
    harness.stdout.on('data', (d) => { if (String(d).includes('dev-harness up')) { clearTimeout(t); res(); } });
    harness.on('exit', (c) => rej(new Error('harness exited early ' + c)));
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://localhost:${PORT}/member`, { waitUntil: 'load' });
    await page.waitForTimeout(2000);
    await page.evaluate(() => { location.hash = '#connections'; });
    await page.waitForSelector('#mcpDirRows .mcp-dir-card', { timeout: 8000 });
    const card = (n) => page.locator('#mcpDirRows .mcp-dir-card', { hasText: n }).first();
    const open = async (n) => { await card(n).hover(); await card(n).locator('.mcp-dir-connect').click(); await page.waitForTimeout(300); };
    const yours = () => page.$$eval('#mcpRows .nm', (e) => e.map((x) => x.textContent));

    // Slack: a bot token is refused before anything is written, a user token connects
    assert.equal(await card('Slack').locator('.mcp-dir-connect').innerText(), 'Set up');
    await open('Slack');
    assert.ok(await page.isVisible('#skWizard'));
    const man = JSON.parse(decodeURIComponent((await page.getAttribute('#skCreate', 'href')).split('manifest_json=')[1]));
    assert.equal(man.settings.is_mcp_enabled, true, 'the create link carries the template');
    await page.check('#skWizard [data-tick="1"]'); await page.check('#skWizard [data-tick="2"]');
    assert.ok(await page.evaluate(() => document.querySelector('#skWizard [data-fold="3"]').open), 'ticking Done moves the steps on');
    await page.fill('#skToken', 'xoxb-1-2'); await page.click('#skSave');
    assert.match(await page.textContent('#skNotice'), /Bot token/);
    await page.fill('#skToken', 'xoxp-1-2'); await page.click('#skSave'); await page.waitForTimeout(2000);
    assert.match(await page.textContent('#skWizard [data-done]'), /Connected\. Slack answered with 12 tools/);
    assert.equal(await page.inputValue('#skToken'), '', 'the token leaves the page once saved');
    assert.ok((await yours()).includes('Slack'), 'Slack is in Your connections');

    // WordPress: links follow the address; a wrong password is refused and NOT kept
    await open('WordPress');
    assert.ok(!(await page.isVisible('#skWizard')), 'one guided card at a time');
    await page.fill('#wpSite', 'shop.example.com');
    assert.equal(await page.getAttribute('#wpWizard [data-wp-link="/wp-admin/user-new.php"]', 'href'), 'https://shop.example.com/wp-admin/user-new.php');
    for (const t of ['1', '2', '3']) await page.check(`#wpWizard [data-tick="${t}"]`);
    await page.fill('#wpUser', 'assistant'); await page.fill('#wpPass', 'wrong'); await page.click('#wpSave'); await page.waitForTimeout(2000);
    assert.match(await page.textContent('#wpNotice'), /turned down that username and password[\s\S]*Nothing was kept/);
    assert.ok(!(await yours()).includes('WordPress'), 'a failed check leaves no row behind');
    const rungs = await page.$$eval('#wpWizard .fstep', (e) => e.map((x) => x.className));
    assert.match(rungs[3], /now/, 'the Connect rung is current, not falsely done');
    await page.fill('#wpPass', 'abcd efgh ijkl mnop'); await page.click('#wpSave'); await page.waitForTimeout(2000);
    assert.match(await page.textContent('#wpWizard [data-done]'), /Connected\. Your site answered with 7 things your assistant can do there/);
    assert.ok((await yours()).includes('WordPress'));

    // Shopify and Xero: a guide, no box write, and the limit said plainly
    for (const n of ['Shopify', 'Xero']) {
      assert.equal(await card(n).locator('.mcp-dir-connect').innerText(), 'How to');
      await open(n);
      const text = await page.innerText('#acWizard');
      assert.match(text, new RegExp(n + ', through your Claude account'));
      assert.match(text, /scheduled jobs/);
    }
    await page.click('#mcpDirChips [data-auth="account"]'); await page.waitForTimeout(200);
    assert.deepEqual(await page.$$eval('#mcpDirRows .mcp-dir-card .nm', (e) => e.map((x) => x.textContent).sort()), ['Shopify', 'Xero'], 'the Claude account pill');
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    harness.kill();
  }
});
