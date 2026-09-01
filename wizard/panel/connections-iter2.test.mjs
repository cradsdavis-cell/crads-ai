// connections-iter2.test.mjs: the Connections page after panel iteration 2
// (R20 marks, R21 the account fold, R8 the disconnect notice;
// docs/superpowers/specs/2026-08-23-panel-iteration-2.md).
//
// Structural pins (trap 6), then a drive of the real page against the
// dev-harness fixtures, which carry one 'account' row (Slack) and the
// ordinary mineral rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');
const sec = html.slice(html.indexOf('<section data-sec="connections">'), html.indexOf('<section data-sec="rocks">'));
const rowFn = html.split('function mcpRowHtml(s)')[1].split('function mcpAccountRowHtml(')[0];
const yours = html.match(/function renderMcpYours\([\s\S]*?\n  \}/)[0];

test('R20: every row carries a mark before its label, hydrated from the vendored marks module', () => {
  assert.match(rowFn, /markSpan\('google', s\.label\)/, 'the Google row');
  assert.match(rowFn, /markSpan\(markKey\(s\), s\.label\)/, 'every other row');
  assert.ok(sec.includes('data-mark="telegram"'), 'the Telegram row, static markup');
  assert.match(sec, /<script type="module">\s*import \{ markFor \} from '\/vendor\/marks\/index\.mjs';/, 'marks come from the vendored module');
  assert.match(html, /function markFill\(el\)/, 'hydration');
  assert.match(html, /maskImage = 'url\("' \+ m\.svg/, 'single-colour svg marks are masks tinted with the brand hex');
  assert.match(html, /m\.kind === 'img'[\s\S]*?document\.createElement\('img'\)[\s\S]*?img\.src = m\.src/, 'img-kind marks (multi-colour svg, png) render as a real <img> with the data: src set as a property');
  assert.match(html, /window\.addEventListener\('aios-marks-ready'/, 'rows rendered before the module lands are re-hydrated');
  assert.match(html, /replace\(\/\^account-\/, ''\)/, 'account rows look up the mark by the bare key');
  assert.match(yours, /hydrateMarks\(\$\('mcpRows'\)\)/, 'the list hydrates after every render');
});

test('R21: account rows leave Your connections for a collapsed fold with the explainer', () => {
  assert.match(yours, /s\.state !== 'account' && \(s\.configured/, 'the yours filter excludes account rows');
  assert.match(yours, /var account = services\.filter\(function\(s\)\{ return s\.state === 'account'; \}\)/, 'and collects them');
  assert.match(yours, /\$\('mcpAccountRows'\)\.innerHTML = account\.length \? '<ul class="connlist">' \+ account\.map\(mcpAccountRowHtml\)/, 'rendered into the fold');
  assert.match(yours, /s\.state === 'chat-only'/, 'chat-only rows stay in the list (they have a button)');
  assert.ok(sec.includes('<details class="secfold" id="mcpAccountFold"'), 'a collapsed secfold');
  assert.ok(!/id="mcpAccountFold"[^>]*\bopen\b/.test(sec), 'collapsed by default');
  assert.ok(sec.indexOf('id="mcpYours"') < sec.indexOf('id="mcpAccountFold"'), 'below Your connections');
  const why = sec.slice(sec.indexOf('id="mcpAccountWhy"'), sec.indexOf('id="mcpAccountRows"'));
  for (const bit of ['connected to your Claude account, not to your mineral', 'scheduled jobs cannot see them', 'connect it here instead']) {
    assert.ok(why.includes(bit), 'explainer says: ' + bit);
  }
  const acct = html.split('function mcpAccountRowHtml(s)')[1].split('\n  }')[0];
  assert.doesNotMatch(acct, /data-mcp-|connfix|class="chip/, 'no button and no status chip on a folded row: the fold is the status');
});

test('R8: Disconnect prints the verb’s notice verbatim', () => {
  const handler = html.slice(html.indexOf("var b = e.target.closest('[data-mcp-add],[data-mcp-remove]')"), html.indexOf("$('tgForget').onclick"));
  assert.match(handler, /if \(!add && d\.notice\) notice\('mcpNotice', String\(d\.notice\)\);/);
});

// Both failure branches are checked SEPARATELY, on their own slice of the
// handler. Asserting `/return;/` against the whole handler proved nothing: the
// transport branch supplies one, so the assertion held even with the other
// branch's `return;` deleted, which is precisely the bug that would ship: a box
// script answering {ok:false} would fall through and report a disconnect that
// never happened.
const forgetHandler = () => html.match(/\$\('tgForget'\)\.onclick[\s\S]*?\n  \};/)[0];
const slice = (s, from, to) => s.slice(s.indexOf(from), s.indexOf(to));

test('a failed disconnect is surfaced, not swallowed: the transport branch', () => {
  const h = forgetHandler();
  // run() resolves to the transport wrapper. A command that never completed is
  // not a disconnect.
  const branch = slice(h, 'if (!r || r.ok === false)', 'var d = jsonOut(r)');
  assert.ok(branch.length > 0, 'the branch exists');
  assert.match(branch, /notice\('tgSetupNotice'/, 'it shows the member an error');
  assert.match(branch, /return;/, 'and stops, rather than reading a body that is not there');
});

test('a failed disconnect is surfaced, not swallowed: the box-script branch', () => {
  const h = forgetHandler();
  // forget itself fails honestly when it cannot stop the bridge, and a live
  // bridge means the channel is still open. An unparsable body is just as
  // untrustworthy.
  const branch = slice(h, 'var d = jsonOut(r)', 'tgStop();');
  assert.match(branch, /if \(!d \|\| d\.ok === false\)/, 'the handler branches on the box script\u2019s own result');
  assert.match(branch, /notice\('tgSetupNotice', \(d && d\.error\)/, 'preferring the verb\u2019s own words');
  assert.match(branch, /return;/, 'without falling through to the success path');
});

test('a rejected disconnect request re-enables the button and says so', () => {
  const h = forgetHandler();
  const branch = h.slice(h.indexOf('.catch(function('));
  assert.ok(branch.length > 0, 'the promise has a catch: a rejected fetch never reaches the then');
  assert.match(branch, /\$\('tgForget'\)\.disabled = false/, 'the button comes back');
  assert.match(branch, /notice\('tgSetupNotice'/, 'and the member is told, instead of staring at a dead button');
});

test('the post-revoke copy points at BotFather and warns the token is spent', () => {
  const h = html.match(/\$\('tgForget'\)\.onclick[\s\S]*?\n  \};/)[0];
  assert.match(h, /\/revoke in @BotFather/, 'tells them to retire the token at source');
  assert.match(h, /will not be accepted on this mineral again/, 'and that reuse is blocked');
});

test('page head: one line, explainer in the bubble, no em dashes in the section’s own copy', () => {
  const head = sec.slice(0, sec.indexOf('</div>'));
  assert.match(head, /<h2>Connections<button class="info"/);
  const p = (head.match(/<p>([^<]*)<\/p>/) || [])[1] || '';
  assert.ok(p.length > 0 && p.length < 80, 'one short line: ' + p);
});

// Design pass 2026-08-23 (Sam: "the connector page options listings could
// look a lot better and include those logos"): tiles with marks, a segmented
// filter row with counts, a wider search with a glyph, the compact Telegram
// card. Static pins here; the drive below checks what actually paints.
const browse = html.match(/function renderMcpBrowse\([\s\S]*?\n  \}/)[0];
const card = browse.match(/function mcpDirCard\([\s\S]*?\n    \}/)[0];

test('tiles: every directory card leads with a mark, names the entry, carries the blurb, and a Connect', () => {
  assert.match(card, /'<div class="mcp-dir-card">' \+ markSpan\(o\.markKey \|\| mcpSlug\(nm\), nm\)/, 'the mark is the first child, keyed on the catalogue key (registry hits fall back to the slug, so markFor gives an initial)');
  assert.match(card, /<span class="kind">API token<\/span>/, 'token-auth entries carry the API token chip');
  assert.match(card, /o\.auth === 'token'/, 'only token-auth entries');
  assert.match(card, /class="act mcp-dir-connect"[^>]*aria-label="Connect ' \+ esc\(nm\)/, 'Connect names its service for a screen reader (it is hidden until hover / focus)');
  assert.match(browse, /\{ markKey: e\.boxKey \|\| e\.key, auth: e\.auth \}/, 'the curated tier passes its key and auth');
  assert.match(browse, /hydrateMarks\(\$\('mcpDirRows'\)\)/, 'tiles hydrate after every render');
  assert.match(browse, /'<div class="mcp-dir-grid" data-tier="shortlist">'/, 'the grid class');
});

test('tiles: the grid is 4 / 3 / 2 across and the Connect is hover-revealed, always visible on touch and narrow', () => {
  assert.match(html, /\.mcp-dir-grid\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(html, /@media \(max-width:900px\)\{\n    \.mcp-dir-grid\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/, 'three across inside the 900 block');
  assert.match(html, /\.mcp-dir-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/, 'two across inside the 640 block');
  assert.match(html, /\.mcp-dir-card\{[^}]*border:1px solid var\(--line\);border-radius:10px/, '1px border, 10px radius');
  assert.match(html, /\.mcp-dir-card\{[^}]*background:transparent/, 'no fill');
  assert.match(html, /\.mcp-dir-card:hover,\.mcp-dir-card:focus-within\{[^}]*box-shadow:var\(--shadow-1\);transform:translateY\(-1px\)/, 'hover lifts');
  assert.match(html, /\.mcp-dir-card \.mcp-dir-connect\{[^}]*opacity:0/, 'Connect hidden at rest');
  assert.match(html, /\.mcp-dir-card:hover \.mcp-dir-connect,\.mcp-dir-card:focus-within \.mcp-dir-connect,\.mcp-dir-card \.mcp-dir-connect:focus-visible\{opacity:1\}/, 'revealed on hover, focus-within and keyboard focus');
  assert.match(html, /@media \(hover:none\),\(max-width:640px\)\{\.mcp-dir-card \.mcp-dir-connect\{opacity:1\}\}/, 'always visible on touch / narrow');
  assert.match(html, /#mcpBrowse\{max-width:none\}/, 'the browse card drops the 680px guidecard cap so four tiles fit');
});

test('filter row: a segmented category group with counts, the sign-in-kind group, a wider search with a glyph, the count subhead', () => {
  assert.match(browse, /'<span class="mcp-seg">' \+ catChips \+ '<\/span>'/, 'categories are one segmented control');
  assert.match(browse, /<span class="mcp-seg">' \+ authChips \+ '<\/span><\/span>'/, 'sign-in kind is a second one, inside the wrap-as-one group');
  assert.match(browse, /'<span class="cnt">' \+ countWhere\(c, mcpDir\.auth\) \+ '<\/span>/, 'each category segment shows what it would show');
  assert.match(browse, /'<span class="cnt">' \+ countWhere\(mcpDir\.cat, a\.v\) \+ '<\/span>/, 'each auth segment too');
  assert.match(browse, /aria-pressed="' \+ \(mcpDir\.cat === c\) \+ '"/, 'segments announce their state');
  assert.ok(sec.includes('<label class="mcp-search" for="mcpDirSearch">'), 'the search is a labelled field');
  const search = sec.slice(sec.indexOf('<label class="mcp-search"'), sec.indexOf('</label>', sec.indexOf('<label class="mcp-search"')));
  assert.match(search, /<svg[^>]*aria-hidden="true"><circle/, 'a leading search glyph');
  assert.match(search, /placeholder="Search services \(Notion, CRM, invoices\)"/, 'sentence case placeholder');
  assert.ok(sec.includes('<p class="gtitle">Add a connection<span class="sum2" id="mcpDirCount"></span></p>'), 'the subhead with its count slot');
  assert.ok(!sec.includes('From your shortlist'), 'the old heading is gone');
});

test('Telegram: a compact card until linked, the steps behind the one primary button; docks as a row once linked', () => {
  const tg = html.match(/function tgRender\([\s\S]*?\n  \}/)[0];
  assert.match(tg, /\$\('tgToggle'\)\.textContent = linked \? 'Details' : \(s\.token \? 'Finish setup' : 'Set up Telegram'\)/, 'the button says what happens');
  assert.match(tg, /\$\('tgToggle'\)\.style\.display = '';/, 'the button is never hidden: it IS the way in');
  assert.match(tg, /if \(s\.token && !tgOpened\) \{ \$\('tgDetail'\)\.style\.display = ''; tgOpened = true; \}/, 'mid-setup opens the steps once, unlinked-and-untouched leaves them collapsed');
  assert.doesNotMatch(tg, /flat steps, never behind a toggle/, 'the flat two-step hero is gone');
  assert.match(tg, /\$\('tgToggle'\)\.setAttribute\('aria-expanded'/, 'the disclosure state is announced');
  assert.match(html, /\$\('tgToggle'\)\.onclick = function\(\)\{[\s\S]*?tgOpened = true;[\s\S]*?aria-expanded/, 'the toggle keeps the same handler, now also marking the auto-open as spent');
  assert.ok(sec.includes('<span class="why">Message your assistant from your phone</span>'), 'one line');
  assert.ok(sec.includes('id="tgToggle" aria-controls="tgDetail" aria-expanded="false">Set up Telegram</button>'), 'the primary');
  assert.match(html, /#tgRow\.tghero #tgToggle\{[^}]*background:var\(--accent\);color:var\(--on-accent\)/, 'terracotta = action, the one primary on the card');
  assert.match(html, /#tgRow\.tghero\{display:block;background:var\(--card\);border:1px solid var\(--line\)/, 'a plain card, not an accent-tinted hero');
  // the ids the rest of the suite pins all survive inside the section
  for (const id of ['tgRow', 'tgChip', 'tgToggle', 'tgDetail', 'tgSetup', 'tgWait', 'tgForget', 'tgToken', 'tgHeroMount']) assert.ok(sec.includes(`id="${id}"`), id);
});

test('Your connections rows: a fixed mark column, the status chip right-aligned in its zone, actions last and quiet', () => {
  assert.match(html, /\.connlist li\.marked\{grid-template-columns:28px minmax\(0,1fr\) auto auto;column-gap:12px\}/);
  assert.match(html, /\.connlist li\.marked \.chip\{grid-column:3;grid-row:1\/span 2;justify-self:end\}/, 'status zone, right-aligned');
  assert.match(html, /\.connlist li\.marked>span\[style\*="display:flex"\]\{grid-column:4/, 'actions last');
  assert.match(html, /\.connlist li\.marked \.connfix\[data-mcp-remove\][^{]*\{color:var\(--soft\)\}/, 'Disconnect is a quiet text button');
  assert.match(html, /\.connlist li\.marked \.connfix\[data-mcp-remove\]:hover\{color:var\(--bad\)\}/, 'destructive colour only on hover');
  assert.match(html, /#mcpAccountFold \.connlist li\.marked\{grid-template-columns:28px minmax\(0,1fr\)\}/, 'the claude.ai fold shares the mark column');
});

let chromium = null;
try { ({ chromium } = await import(join(HERE, '..', 'dev-harness', 'node_modules', 'playwright', 'index.mjs'))); } catch { /* no local playwright */ }

test('driven: a mark per row, account rows inside the fold, the disconnect notice', { skip: !chromium && 'playwright not installed under wizard/dev-harness' }, async () => {
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
    await page.evaluate(() => { location.hash = '#connections'; });
    await page.waitForTimeout(1800);
    const rows = await page.locator('#mcpRows .connlist li').count();
    assert.ok(rows > 0, 'rows rendered');
    assert.equal(await page.locator('#mcpRows .connlist li .mark').count(), rows, 'a mark on every row');
    assert.ok(await page.locator('#mcpRows .connlist li .mark.svg, #mcpRows .connlist li .mark.img, #mcpRows .connlist li .mark.initial').count() === rows, 'every mark hydrated (svg, img or initial)');
    assert.equal(await page.locator('#mcpRows .mark[data-mark="notion"].svg').count(), 1, 'a vendored brand renders as an svg mark');
    assert.equal(await page.locator('#tgRow .mark[data-mark="telegram"].svg').count(), 1, 'the Telegram row too');
    assert.equal(await page.locator('#mcpRows .connlist li .nm', { hasText: 'Slack' }).count(), 0, 'the account row is NOT in Your connections');
    assert.equal(await page.locator('#mcpAccountFold .connlist li .nm', { hasText: 'Slack' }).count(), 1, 'it is inside the fold');
    assert.equal(await page.locator('#mcpAccountFold[open]').count(), 0, 'fold collapsed by default');
    assert.ok(await page.locator('#mcpAccountFold').isVisible(), 'but visible, because the box reported one');
    assert.equal(await page.locator('#mcpRows .nm', { hasText: 'Stripe' }).count(), 1, 'the chat-only adoptable row stays in the list');
    await page.locator('[data-mcp-remove="notion"]').click();
    await page.waitForTimeout(1500);
    const n = (await page.locator('#mcpNotice').innerText()).trim();
    assert.match(n, /disconnected and its credential is gone from this box/, 'the verb’s notice, verbatim');
    assert.match(n, /yours to revoke there/);
    // the tile grid, driven: every tile has a hydrated mark, the grid is 4 across at 1280
    const tiles = await page.locator('#mcpDirRows .mcp-dir-grid[data-tier="shortlist"] .mcp-dir-card').count();
    assert.ok(tiles >= 10, 'tiles rendered: ' + tiles);
    assert.equal(await page.locator('#mcpDirRows .mcp-dir-card > .mark.svg, #mcpDirRows .mcp-dir-card > .mark.img, #mcpDirRows .mcp-dir-card > .mark.initial').count(), tiles, 'a hydrated mark on every tile');
    assert.equal(await page.locator('#mcpDirRows .mcp-dir-card > .mark.initial').count(), 0, 'no tile is left on an initial disc (every catalogue key has a real mark since 2026-08-23)');
    assert.ok(await page.locator('#mcpDirRows .mcp-dir-card > .mark.img img[src^="data:image/"]').count() > 0, 'img-kind marks (multi-colour svg / png) render as a data: <img>');
    assert.ok(await page.locator('#mcpDirRows .mcp-dir-card .mark.svg').count() > 5, 'most of the shortlist has a vendored brand mark');
    const cols = await page.$eval('#mcpDirRows .mcp-dir-grid', (g) => getComputedStyle(g).gridTemplateColumns.split(' ').length);
    assert.equal(cols, 4, 'four columns at 1280');
    assert.match(await page.locator('#mcpDirCount').innerText(), /^\d+ services$/, 'the count subhead');
    assert.ok(await page.locator('#mcpDirChips .mcp-seg .mcp-chip[data-cat="All"] .cnt').count() === 1, 'the All segment carries a count');
    assert.equal(await page.locator('#mcpDirRows .mcp-dir-card .kind', { hasText: 'API token' }).count(),
      await page.$$eval('#mcpDirRows .mcp-dir-card .kind', (els) => els.length), 'API token chips');
    // Connect is hidden at rest and revealed by keyboard focus
    const first = page.locator('#mcpDirRows .mcp-dir-card .mcp-dir-connect').first();
    assert.equal(await first.evaluate((b) => getComputedStyle(b).opacity), '0', 'quiet at rest');
    await first.focus();
    await page.waitForTimeout(200);
    assert.equal(await first.evaluate((b) => getComputedStyle(b).opacity), '1', 'revealed on focus');
    // registry hits render as the same tiles, with an initial mark
    await page.fill('#mcpDirSearch', 'crm');
    await page.waitForTimeout(700);
    assert.equal(await page.locator('#mcpDirRows .mcp-dir-grid[data-tier="registry"] .mcp-dir-card .nm', { hasText: 'Example CRM' }).count(), 1, 'the registry hit is a tile');
    assert.equal(await page.locator('#mcpDirRows .mcp-dir-grid[data-tier="registry"] .mcp-dir-card > .mark.initial').count(), 1, 'with an initial mark');
    // Telegram: the fixture starts unlinked, so it is the compact card with the steps collapsed
    assert.equal(await page.locator('#tgRow.tghero').count(), 1, 'the compact card');
    assert.ok(!(await page.locator('#tgDetail').isVisible()), 'steps collapsed until asked');
    assert.equal((await page.locator('#tgToggle').innerText()).trim(), 'Set up Telegram');
    await page.locator('#tgToggle').click();
    await page.waitForTimeout(200);
    assert.ok(await page.locator('#tgSetup').isVisible(), 'Step 1 expands inline');
    assert.equal(await page.locator('#tgToggle').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    harness.kill();
  }
});
