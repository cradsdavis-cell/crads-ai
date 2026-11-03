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
  assert.ok(connect.indexOf("run(verb || 'mcp-add-custom'") > -1 && connect.indexOf("run('mcp-check'") > connect.indexOf("run(verb || 'mcp-add-custom'"), 'save first (add-custom, or the wizard\'s own verb), check second');
  assert.match(connect, /run\('mcp-remove', \{ key: def\.name \}\)/, 'a failed check removes the entry it just wrote');
  assert.match(connect, /if \(mcpContract < GUIDED_CONTRACT\[kind\]\) \{ notice\(nid, MCP_TOO_OLD\); return; \}/, 'a box behind the wizard\'s contract is told to update, before anything is written');
  assert.match(guided, /scheme: 'basic'/, 'WordPress saves as HTTP Basic');
  assert.match(guided, /\/wp-json\/mcp\/mcp-adapter-default-server/, 'at the MCP adapter default server, the endpoint WooCommerce documents');
});

test('the Slack template switches MCP on and keeps the token from rotating', () => {
  const m = guided.match(/var SLACK_MANIFEST = (\{[\s\S]*?\n  \});/);
  assert.ok(m, 'the template is present');
  assert.match(m[1], /is_mcp_enabled: true/, 'without it Slack answers "App is not enabled for Slack MCP server access"');
  assert.match(m[1], /token_rotation_enabled: false/, 'a rotating token would die twelve hours after it was pasted');
  assert.match(m[1], /oauth_config: \{ scopes: \{ user: \[/, 'user scopes: the assistant sees what the member sees');
  assert.doesNotMatch(m[1], /scopes: \{ bot:/, 'no bot scopes: the token is a user token');
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
    // what the page actually asked the box to save (def_b64 decoded)
    const saved = [];
    page.on('request', (rq) => {
      const m = String(rq.postData() || '').match(/"def_b64":"([A-Za-z0-9+/=]+)"/);
      if (m) saved.push(JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')));
    });
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

    // Another Slack workspace (contract 6): offered once one works, needs a
    // name, saves as slack-<name> with another:true, and its own row appears
    await page.click('[data-mcp-slack-add]'); await page.waitForTimeout(300);
    assert.ok(await page.isVisible('#skWs'), 'the card asks which workspace this is');
    assert.equal(await page.textContent('#skSave'), 'Connect this workspace');
    assert.equal(await page.inputValue('#skToken'), '');
    await page.check('#skWizard [data-tick="1"]'); await page.check('#skWizard [data-tick="2"]');
    await page.fill('#skToken', 'xoxp-3-4'); await page.click('#skSave');
    assert.match(await page.textContent('#skNotice'), /short name first/);
    await page.fill('#skWs', 'reef'); await page.click('#skSave'); await page.waitForTimeout(2000);
    assert.match(await page.textContent('#skWizard [data-done]'), /Connected\. Slack answered/);
    assert.deepEqual(saved.at(-1), { name: 'slack-reef', url: 'https://mcp.slack.com/mcp', token_b64: Buffer.from('xoxp-3-4').toString('base64'), another: true });
    const names = await yours();
    assert.ok(names.includes('Slack') && names.includes('Slack (reef)'), 'both workspaces, each its own row: ' + names.join(', '));
    await page.click('[data-mcp-slack-add]'); await page.waitForTimeout(300);
    await page.check('#skWizard [data-tick="1"]'); await page.check('#skWizard [data-tick="2"]');
    await page.fill('#skWs', 'reef'); await page.fill('#skToken', 'xoxp-5-6'); await page.click('#skSave');
    assert.match(await page.textContent('#skNotice'), /already have a row called Slack \(reef\)/);
    // the directory's own Set up opens the FIRST-workspace card, not a stale "another" one
    await page.evaluate(() => document.querySelector('[data-guided-close]').click());

    // Connect something else with its own header (contract 6, WooCommerce's built-in MCP)
    await page.fill('#mcpCustName', 'driftwood');
    await page.fill('#mcpCustUrl', 'https://shop.example.com/wp-json/woocommerce/mcp');
    await page.evaluate(() => { document.getElementById('mcpCustHeaderFold').open = true; });
    await page.fill('#mcpCustHeader', 'X-MCP-API-Key');
    await page.click('#mcpCustAdd');
    assert.match(await page.textContent('#mcpCustNotice'), /needs the token/);
    await page.fill('#mcpCustToken', 'ck_1:cs_2'); await page.click('#mcpCustAdd'); await page.waitForTimeout(1500);
    assert.deepEqual(saved.at(-1), { name: 'driftwood', url: 'https://shop.example.com/wp-json/woocommerce/mcp', token_b64: Buffer.from('ck_1:cs_2').toString('base64'), header: 'X-MCP-API-Key' });
    assert.equal(await page.inputValue('#mcpCustHeader'), '', 'the form clears');
    assert.ok((await yours()).includes('Driftwood'), 'the shop is on the Connections page');

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

    // Mailchimp (contract 5): a malformed key is refused on the page, a dead
    // one by the box check (and not kept), a good one names the account and
    // the row carries the expiry hint
    await open('Mailchimp');
    assert.ok(await page.isVisible('#mcWizard'));
    assert.match(await page.innerText('#mcWizard'), /cannot send or schedule a campaign/);
    await page.check('#mcWizard [data-tick="1"]');
    await page.fill('#mcKey', 'not-a-key'); await page.click('#mcSave');
    assert.match(await page.textContent('#mcNotice'), /does not look like a Mailchimp API key/);
    // fake keys built at runtime: a literal in Mailchimp's shape trips push protection
    const fakeKey = (dc) => '0123456789abcdef'.repeat(2) + '-' + dc;
    await page.fill('#mcKey', fakeKey('us0')); await page.click('#mcSave'); await page.waitForTimeout(2000);
    assert.match(await page.textContent('#mcNotice'), /Mailchimp turned that key down[\s\S]*Nothing was kept/);
    assert.ok(!(await yours()).includes('Mailchimp'), 'a dead key leaves no row');
    await page.fill('#mcKey', fakeKey('us21')); await page.click('#mcSave'); await page.waitForTimeout(2000);
    assert.match(await page.textContent('#mcWizard [data-done]'), /Connected to Mel's Shop\./);
    assert.ok((await yours()).includes('Mailchimp'));
    assert.match(await page.innerText('#mcpRows'), /expect to paste a new one around/, 'the row says when the key should run out');

    // Odoo (contract 11): an http address and a malformed key are refused on
    // the page, a dead key by the box check (and not kept), a good one names
    // the user and company, and the row says when to expect a new key
    await open('Odoo');
    assert.ok(await page.isVisible('#odWizard'));
    const odText = await page.innerText('#odWizard');
    assert.match(odText, /cannot delete anything, confirm or post an invoice or order, register a payment, or email anyone/);
    assert.match(odText, /Custom plan/, 'the Odoo Online plan limit is said before anything is pasted');
    await page.check('#odWizard [data-tick="1"]');
    const odKey = (head) => head + 'ab12'.repeat(9);   // fake, built at runtime
    await page.fill('#odUrl', 'http://erp.example.com'); await page.fill('#odKey', odKey('ab12')); await page.click('#odSave');
    assert.match(await page.textContent('#odNotice'), /starts https:\/\//);
    await page.fill('#odUrl', 'driftwood.odoo.com'); await page.fill('#odKey', 'not-a-key'); await page.click('#odSave');
    assert.match(await page.textContent('#odNotice'), /does not look like an Odoo API key/);
    await page.fill('#odKey', odKey('0000')); await page.click('#odSave'); await page.waitForTimeout(2000);
    assert.match(await page.textContent('#odNotice'), /Odoo turned that key down[\s\S]*Nothing was kept/);
    assert.ok(!(await yours()).includes('Odoo'), 'a dead key leaves no row');
    await page.fill('#odKey', odKey('ab12')); await page.click('#odSave'); await page.waitForTimeout(2000);
    assert.match(await page.textContent('#odWizard [data-done]'), /Connected as Mel Driftwood, Driftwood Surf School \(Odoo 19\.0\)\./);
    assert.match(await page.textContent('#odWizard [data-done]'), /Odoo 19 keys last three months at most/, 'a 19 says when to expect a new key');
    assert.ok((await yours()).includes('Odoo'));
    assert.match(await page.innerText('#mcpRows'), /Odoo 19 keys last three months at most: expect to paste a new one around/);

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

test('Mailchimp saves through its own verb and waits for a contract-5 box', () => {
  assert.match(guided, /guidedConnect\('mailchimp', \{ name: 'mailchimp', key_b64: b64utf8\(k\) \}, \$\('mcSave'\), 'mcp-add-mailchimp'\)/);
  assert.match(guided, /var GUIDED_CONTRACT = \{ slack: 4, wordpress: 4, mailchimp: 5, asana: 7, microsoft: 10, odoo: 11 \};/);
  assert.match(html, /id="mcWizard"[\s\S]*?<b>cannot send or schedule a campaign<\/b>/, 'the card says what it will not do, before the member pastes anything');
});

// Odoo (contract 11, 2026-10-22): saved through its own verb with the address
// the member typed, gated on 11, and the card says what it will not do first.
test('Odoo saves through its own verb, https only, and waits for a contract-11 box', () => {
  assert.match(guided, /guidedConnect\('odoo', payload, \$\('odSave'\), 'mcp-add-odoo'\)/);
  assert.match(guided, /var payload = \{ name: 'odoo', url: o, key_b64: b64utf8\(k\) \};/, 'the key rides base64, never in the clear');
  assert.match(guided, /return u\.protocol === 'https:' \? u\.origin : '';/, 'an http address is refused on the page');
  assert.match(guided, /verb && verb !== 'mcp-add-custom' \? payload : def/, 'the on-box verbs get the payload without the name');
  assert.match(html, /id="odWizard"[\s\S]*?<b>cannot delete anything, confirm or post an invoice or order, register a payment, or email anyone<\/b>/, 'says what it will not do, before the member pastes anything');
});

// Microsoft 365 (contract 8, 2026-10-19): saved through its own verb, signed
// in with Microsoft's code on the mineral, gated on contract 8. The card says
// what it reaches and what it does not, before anything is saved.
test('Microsoft 365 saves, signs in on the mineral, checks from it, gated on contract 10', () => {
  assert.match(guided, /run\('mcp-add-microsoft', \{ def_b64: b64utf8\(JSON\.stringify\(def\)\) \}\)/);
  assert.match(guided, /run\('mcp-microsoft-login'\)/, 'the code comes from the mineral');
  assert.match(guided, /run\('mcp-microsoft-login-status'\)/, 'and the page polls the mineral, not Microsoft');
  assert.match(guided, /run\('mcp-check', \{ key: 'microsoft' \}\)/, 'the box proves the sign-in from where jobs run');
  assert.match(guided, /mcpContract < GUIDED_CONTRACT\.microsoft/);
  assert.match(html, /id="msWizard"[\s\S]*?It does not reach your files, SharePoint or Teams\./, 'says what it will not reach');
  assert.match(html, /id="msWizard"[\s\S]*?<b>cannot delete<\/b> mail, contacts or calendars, make inbox rules that forward your mail, or share your calendar/, 'and what it will not do, before anything is saved');
  assert.match(html, /id="msWizard"[\s\S]*?There is no app to make\./, 'and that no app registration is needed');
  assert.match(html, /data-mcp-microsoft>' \+ \(s\.state === 'on' \? 'Change' : 'Sign in'\)/, 'a waiting row reopens the card');
});

// Drafts only unless the member says otherwise (contract 10, 2026-10-20). The
// switch starts off, rides the saved settings to the box, and a reopened card
// shows what the connection does now, so a repeat press never flips it.
test('Microsoft 365 sends email only when the member turns it on', () => {
  assert.match(html, /id="msWizard"[\s\S]*?<input type="checkbox" id="msSend">/, 'a switch on the card');
  assert.doesNotMatch(html, /id="msSend"[^>]*checked/, 'off by default');
  assert.match(html, /id="msWizard"[\s\S]*?Microsoft is never asked for permission to send/, 'the card says what off means');
  assert.match(html, /id="msWizard"[\s\S]*?Outlook tells the people involved/, 'and that calendar changes still reach people');
  assert.match(guided, /var def = \{ account: msAccount\(\), send: \$\('msSend'\)\.checked \};/, 'the switch is sent with the settings');
  assert.match(guided, /\$\('msSend'\)\.checked = !!\(msRow && msRow\.sends\);/, 'a reopened card shows the current setting');
  assert.match(html, /msRow = services\.filter\(function\(s\)\{ return s\.byo === 'microsoft'; \}\)\[0\] \|\| null;/);
  assert.match(html, /data-mcp-microsoft>' \+ \(s\.state === 'on' \? 'Change' : 'Sign in'\) \+ '<\/button>'/, 'a connected row can reopen the card to change it');
});

// Slack refuses a whole manifest over one bad field ("We can't translate a
// manifest with errors"). The first template shipped a bot display_name with a
// capital and a space; the second shipped a bot user with no bot scopes, which
// Slack also refuses (a pebble, 6 Oct). Pin the manifest to the rules in
// Slack's own manifest reference (docs.slack.dev/reference/app-manifest).
test('the Slack template obeys Slack\'s manifest field rules', () => {
  const src = guided.match(/var SLACK_MANIFEST = (\{[\s\S]*?\n  \});/)[1];
  const m = Function('return (' + src.replace(/\/\/[^\n]*/g, '') + ')')();
  assert.equal(m.features?.bot_user, undefined, 'no bot user: Slack refuses one that has no bot scopes, and a user-token app installs without it');
  assert.ok(m.display_information.name.length <= 35, 'app name max 35');
  assert.ok(m.display_information.description.length <= 140, 'description max 140');
  assert.equal(typeof m.settings.is_mcp_enabled, 'boolean');
  const doc = readFileSync(join(HERE, '..', '..', 'docs', 'product', 'pages', 'how-to', 'connect-slack.md'), 'utf8');
  const shown = JSON.parse(doc.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.deepEqual(shown, JSON.parse(JSON.stringify(m)), 'the docs show exactly the template the app uses');
});

// contract 6 (2026-10-06): a second Slack workspace and a key in its own header
test('another Slack workspace saves as slack-<name> with another:true, gated on contract 6', () => {
  assert.match(html, /data-mcp-slack-add>Add another Slack workspace<\/button>/);
  assert.match(html, /mcpContract >= 6 && yours\.some\(function\(s\)\{ return \/\^slack\(-\|\$\)\/\.test\(s\.key\) && s\.configured; \}\)/, 'offered only once one workspace works, and only to a box that will not refuse it');
  assert.match(html, /def\.name = 'slack-' \+ ws; def\.another = true;/);
  assert.match(html, /if \(kind === 'slack'\) skSetAnother\(!!entry\.another\);/, 'the directory card opens the first-workspace card, never a stale "another" one');
});

test('connect something else carries an optional header, refused without a key or on an old box', () => {
  assert.match(html, /id="mcpCustHeader"/);
  assert.match(html, /if \(header && !token\)/);
  assert.match(html, /if \(header && mcpContract < 6\) \{ notice\('mcpCustNotice', MCP_TOO_OLD\); return; \}/);
  assert.match(html, /if \(header\) def\.header = header;/);
});

// Asana (2026-10-17): the member's own app. The card shows the FIXED callback
// the app must list (asked of the app's server, never a second hard-coded
// copy), sends the id + secret + Asana's resource to the ordinary sign-in,
// and waits for a contract-7 box. The old /sse row offers the move.
test('Asana: own-app card, fixed callback from the server, sign-in carries id + secret + resource', () => {
  assert.match(html, /id="asWizard"[\s\S]*?Asana MCP[\s\S]*?Specific workspaces/, 'the card walks the app type and the workspace step');
  assert.match(guided, /fetch\('\/mcp-oauth\/redirect'\)/);
  assert.ok(!/localhost:38427/.test(html), 'the page never hard-codes the callback');
  const save = guided.slice(guided.indexOf("$('asSave').onclick"));
  assert.match(save, /run\('mcp-add-custom'/);
  assert.match(save, /client_id: id, client_secret: secret, resource:/);
  assert.match(save, /mcpContract < GUIDED_CONTRACT\.asana/);
  assert.match(html, /data-mcp-asana>Move to the new Asana/);
});
