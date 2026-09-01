// verify-fixes-2026-08-23.test.mjs: pins for the seven defects a verifier found
// driving the integrated panel-iteration-2 build on the harness and on a live
// rock running an OLD image (docs/superpowers/specs/2026-08-23-panel-iteration-2.md).
//   1 em dashes reached the screen        5 the Map still drew "paused"
//   2 old-shape Secrets rows showed raw keys  6 pebble copy on the rock's Skills page
//   3 Help copy contradicted itself        7 Reject vs Decline, shouted PRIVATE, torn-down tint
//   4 the version chip floated over controls
// Run: node --test wizard/panel/verify-fixes-2026-08-23.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');
const door = readFileSync(join(HERE, 'door.html'), 'utf8');
const mcpConnect = readFileSync(join(HERE, '..', '..', 'engine', 'comms', 'mcp-connect.mjs'), 'utf8');

// Everything that is NOT a comment: HTML comments, /* */ blocks and // lines
// are blanked (line structure kept so a failure names a line). A `//` that sits
// inside a string (https://...) is not a comment and is left alone.
function uncommented(src) {
  const lines = src.split('\n');
  let inHtml = false, inBlock = false;
  return lines.map((raw) => {
    let line = raw;
    if (inHtml) { const e = line.indexOf('-->'); if (e < 0) return ''; inHtml = false; line = ' '.repeat(e + 3) + line.slice(e + 3); }
    if (inBlock) { const e = line.indexOf('*/'); if (e < 0) return ''; inBlock = false; line = ' '.repeat(e + 2) + line.slice(e + 2); }
    let out = '';
    for (let i = 0; i < line.length;) {
      if (line.startsWith('<!--', i)) { const e = line.indexOf('-->', i + 4); if (e < 0) { inHtml = true; break; } i = e + 3; continue; }
      if (line.startsWith('/*', i)) { const e = line.indexOf('*/', i + 2); if (e < 0) { inBlock = true; break; } i = e + 2; continue; }
      if (line.startsWith('//', i) && !/[:'"`\\]/.test(line[i - 1] || ' ')) break;
      out += line[i]; i++;
    }
    return out;
  });
}
const dashLines = (src) => uncommented(src).map((l, i) => [i + 1, l]).filter(([, l]) => /—|&mdash;|&#8212;/.test(l));

test('1: no em dash, &mdash; or &#8212; in any rendered text of member.html or door.html', () => {
  for (const [name, src] of [['member.html', html], ['door.html', door]]) {
    assert.ok(!/&mdash;|&#8212;/.test(src), `${name}: no entity-encoded em dash anywhere, comments included`);
    const hits = dashLines(src);
    assert.deepEqual(hits, [], `${name}: em dashes outside comments at lines ${hits.map(([n]) => n).join(', ')}`);
  }
  // the three the verifier saw, by shape rather than by copied prose
  assert.match(html, /<p class="gtitle">Step 1: make your own bot/);
  assert.match(html, /<p class="gtitle">Step 2: send your bot this code/);
});

test('1: mcp-connect status strings (rendered as the connection chip) carry no em dash', () => {
  const hits = dashLines(mcpConnect);
  assert.deepEqual(hits, [], `engine/comms/mcp-connect.mjs: em dashes outside comments at lines ${hits.map(([n]) => n).join(', ')}`);
  for (const m of mcpConnect.matchAll(/status: '([^']*)'|\.status = '([^']*)'/g)) assert.ok(!/—/.test(m[1] || m[2]), 'status string: ' + (m[1] || m[2]));
});

// ---- 2: the Secrets renderer, evaluated out of the page ----------------------
function secretsLib(isOrg) {
  const from = html.indexOf('  var SEC_KINDS = [');
  const to = html.indexOf('  function loadSecrets(){');
  assert.ok(from > 0 && to > from, 'secrets block found');
  // eslint-disable-next-line no-new-func
  return new Function('IS_ORG', 'return (function(){'
    + 'function esc(s){ return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;"); }'
    + 'var state = { host: "h" }; function fetch(){ return Promise.resolve({ json: function(){ return Promise.resolve({}); } }); }'
    + html.slice(from, to)
    + 'return { secNormalise: secNormalise, secRowHtml: secRowHtml, secHumanName: secHumanName, SEC_LEGACY: SEC_LEGACY, SEC_KINDS: SEC_KINDS };})()')(isOrg);
}
// the OLD image's row shape: name/what/where/set/updated, nothing else
const OLD_ROWS = [
  { name: 'box_directory_token', what: '', where: 'secrets/box_directory_token', set: true, updated: '2026-08-17T03:12:00Z' },
  { name: 'box_reg_host', what: '', where: 'secrets/box_reg_host', set: true, updated: '2026-08-17' },
  { name: 'machine_salt', what: '', where: 'secrets/machine_salt', set: true, updated: '2026-08-17' },
  { name: 'owner_e', what: '', where: 'secrets/owner_e', set: true, updated: '2026-08-17' },
  { name: 'some_future-thing.pub', where: 'secrets/some_future-thing.pub', set: false },
];

test('2: an old-image row shape renders a human label, a gloss, and never a dangling separator', () => {
  const lib = secretsLib(false);
  const n = Object.fromEntries(OLD_ROWS.map((r) => [r.name, lib.secNormalise(r)]));
  assert.equal(n.owner_e.label, 'Owner email');
  assert.match(n.owner_e.what, /^Owner email \(for directory registration\)/);
  assert.equal(n.machine_salt.label, 'Machine salt');
  assert.match(n.machine_salt.what, /^Machine salt, seeds this mineral's device fingerprints/);
  assert.equal(n.box_reg_host.label, 'Registered host name');
  assert.match(n.box_reg_host.what, /^Registered host name/);
  assert.equal(n.box_directory_token.label, 'Directory token');
  assert.match(n.box_directory_token.what, /^Directory token, how this mineral proves itself to the directory/);
  // every old-shape row files under Platform
  for (const r of OLD_ROWS) assert.equal(n[r.name].kind, 'platform', r.name + ' under Platform');
  // an unknown legacy name is sentence-cased, hyphens and underscores to spaces
  assert.equal(n['some_future-thing.pub'].label, 'Some future thing, pub');
  assert.equal(lib.secHumanName('box_reg_host'), 'Box reg host');
  // the rendered row: label bold, no raw key in visible text, no " · " before an empty gloss
  for (const r of OLD_ROWS) {
    const h = lib.secRowHtml(r);
    const visible = h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.ok(!visible.includes(r.name), r.name + ': raw key not visible (' + visible + ')');
    assert.ok(!/>\s*·|·\s*</.test(h), r.name + ': no separator beside an empty field (' + h + ')');
    assert.match(h, new RegExp('<b>' + n[r.name].label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</b>'));
  }
  assert.match(lib.secRowHtml(OLD_ROWS[0]), /Directory token, how this mineral proves itself to the directory[^<]*· 2026-08-17</, 'gloss · date when both exist');
  assert.doesNotMatch(lib.secRowHtml(OLD_ROWS[4]), /class="hint"/, 'no gloss and no date: no hint line at all');
  // a NEW row (label + kind present) passes through untouched
  const fresh = { name: 'mcp-notion', label: 'Notion', kind: 'connection', what: 'x', set: true, revoke: { via: 'connections', key: 'notion' } };
  assert.equal(lib.secNormalise(fresh), fresh);
  assert.match(lib.secRowHtml(fresh), /Revoke via Connections/);
});

test('2: the page-side legacy glosses mirror the engine names, and loadSecrets normalises before grouping', () => {
  const lib = secretsLib(false);
  const engine = readFileSync(join(HERE, '..', '..', 'engine', 'vault', 'discover.mjs'), 'utf8');
  const known = engine.slice(engine.indexOf('const KNOWN = {'), engine.indexOf('};', engine.indexOf('const KNOWN = {')));
  for (const m of known.matchAll(/^\s+'([^']+)':\s*\{/gm)) assert.ok(lib.SEC_LEGACY[m[1]], 'page glosses engine name ' + m[1]);
  assert.ok(lib.SEC_LEGACY.machine_salt, 'and machine_salt, which old images emit');
  const load = html.slice(html.indexOf('  function loadSecrets(){'), html.indexOf('  function secLandOn('));
  assert.match(load, /\(data\.found \|\| \[\]\)\.map\(secNormalise\)/, 'rows are normalised before the kind grouping');
});

// ---- 3: Help copy ------------------------------------------------------------
function helpLib(anchor, isOrg) {
  const from = html.indexOf('  var openFolderAt = \'\';');
  const to = html.indexOf('  function checkOnboard(){');
  assert.ok(from > 0 && to > from, 'help block found');
  // eslint-disable-next-line no-new-func
  return new Function('rockLocalAnchor', 'IS_ORG', 'return (function(){'
    + 'var els = {}; function $(id){ if (!els[id]) els[id] = { id: id, innerHTML: "", textContent: "" }; return els[id]; }'
    + 'function esc(s){ return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;"); }'
    + 'var state = { host: "h" }; function run(){ return Promise.resolve({ ok: false }); } function outLines(){ return []; }'
    + html.slice(from, to)
    + 'return { els: els, renderOpenFolderStep: renderOpenFolderStep, loadOpenFolder: loadOpenFolder, renderRestartPublisher: renderRestartPublisher };})()')(anchor, isOrg);
}

test('3: the folder sentence has two honest shapes: named after the mineral, or "called state" with the why', () => {
  const a = helpLib(null, false);
  a.renderOpenFolderStep('priyas-pebble');
  const named = a.els.openFolderStep.innerHTML.replace(/<[^>]+>/g, '');
  assert.match(named, /pick the one named after your mineral: priyas-pebble\./);
  assert.doesNotMatch(named, /has not named its folder/);
  for (const v of ['state', '', undefined]) {
    a.renderOpenFolderStep(v);
    const fallback = a.els.openFolderStep.innerHTML.replace(/<[^>]+>/g, '');
    assert.match(fallback, /pick the folder called state \(this mineral has not named its folder yet; it will after its next update\)/, 'verb answered ' + JSON.stringify(v));
    assert.doesNotMatch(fallback, /named after your mineral/, 'never the contradiction "named after your mineral: state"');
    assert.match(a.els.openFolderStep.innerHTML, /id="openFolderName">state</, 'the mono name element survives for the verb to fill');
  }
  // the static HTML starts in the fallback shape too (a box without the verb never reaches the renderer)
  const li = html.match(/<li id="openFolderStep">[^\n]*<\/li>/)[0];
  assert.match(li, /pick the folder called <b[^>]*id="openFolderName">state<\/b> \(this mineral has not named its folder yet/);
  // loadOpenFolder renders through the two-shape function, never by textContent alone
  const load = html.slice(html.indexOf('  function loadOpenFolder(){'), html.indexOf('  function renderRestartPublisher(){'));
  assert.match(load, /renderOpenFolderStep\(name\)/);
  assert.doesNotMatch(load, /openFolderName'\)\.textContent = name/);
});

test('3: the member restart card names the publisher: the anchor rock, else Crads AI', () => {
  const none = helpLib(null, false); none.renderRestartPublisher();
  assert.equal(none.els.boxRefreshPublisher.textContent, 'Crads AI', 'a Mountain-anchored pebble has no rock');
  const rock = helpLib({ org: 'harriets-rock', name: "Harriet's rock", owner: 'org' }, false); rock.renderRestartPublisher();
  assert.equal(rock.els.boxRefreshPublisher.textContent, "Harriet's rock");
  const unnamed = helpLib({ org: 'harriets-rock', name: '', owner: 'org' }, false); unnamed.renderRestartPublisher();
  assert.equal(unnamed.els.boxRefreshPublisher.textContent, 'harriets-rock', 'the slug when the rock has no name');
  // the card's static copy defaults to Crads AI and no longer says "your rock"
  const card = html.match(/<p class="hint"[^>]*id="boxRefreshHint">[^\n]*<\/p>/)[0];
  assert.match(card, /software <span id="boxRefreshPublisher">Crads AI<\/span> has published for it/);
  assert.doesNotMatch(card, /your rock has published/);
  // re-rendered on every Help open and after every anchor read
  assert.match(html, /if \(name === 'help'\) \{ loadOpenFolder\(\); renderRestartPublisher\(\); \}/);
  assert.match(html, /function rockNoteAnchor\(st\)\{\s*rockNoteAnchorRead\(st\);\s*renderRestartPublisher\(\);/);
});

// ---- 4: the version chip lives in the header flow ----------------------------
test('4: member.html mounts the version chip in the header, and the shared fragment honours the mount', () => {
  const header = html.slice(html.indexOf('<header class="top">'), html.indexOf('</header>'));
  assert.match(header, /<span id="verChipMount"/, 'the mount sits in the header row');
  assert.ok(header.indexOf('verChipMount') < header.indexOf('id="refreshBtn"'), 'before Refresh, inside .push');
  for (const [name, src] of [['member.html', html], ['door.html', door]]) {
    const frag = src.slice(src.indexOf('(function(){\n  // Version chip (2026-08-09'), src.indexOf('\n})();', src.indexOf('// Version chip (2026-08-09')));
    assert.match(frag, /var mount = document\.getElementById\('verChipMount'\)/, name + ': looks for the mount');
    assert.match(frag, /\(mount \|\| document\.body\)\.appendChild\(chip\)/, name + ': mounts in flow when it can');
    assert.match(frag, /chip\.style\.cssText = mount\s*\?\s*'[^']*'\s*:\s*'position:fixed/, name + ': fixed only without a mount');
    const inflow = frag.match(/chip\.style\.cssText = mount\s*\?\s*'([^']*)'/)[1];
    assert.ok(!/position:fixed|z-index/.test(inflow), name + ': the in-flow chip is not positioned');
    assert.match(frag, /place\(tip\); tip\.style\.display = 'block'/, name + ': the hover summary hangs off the chip');
    assert.match(frag, /place\(log\); log\.style\.display = 'block'/, name + ': the fold hangs off the chip');
  }
  assert.ok(!/id="verChipMount"/.test(door), 'the door keeps the corner chip (no mount element)');
});

// ---- 5: the Map no longer renders paused -------------------------------------
test('5: a legacy paused member is drawn by presence, like an active one (R5)', () => {
  const src = html.slice(html.indexOf('function netModel(w)'), html.indexOf('function netLayout(nodes)'));
  // eslint-disable-next-line no-new-func
  const model = new Function('netPresence', 'cap', src + '; return netModel;')(
    (ls) => ({ cls: ls ? 'ok' : '', txt: ls ? 'connected now' : 'no record yet' }), (s) => s);
  const nodes = model({ ok: true, rock: true, box: { label: 'acme', tier: 'rock', mountain: true }, org: { label: 'Crads AI', anchor: true }, orgs: [],
    fleet: [{ slug: 'p1', label: 'Pat Legacy', tie: 'anchored', status: 'paused', last_seen: new Date().toISOString() },
      { slug: 'a1', label: 'Active Al', tie: 'anchored', status: 'active', last_seen: new Date().toISOString() }] });
  const pat = nodes.find((n) => n.slug === 'p1'), al = nodes.find((n) => n.slug === 'a1');
  assert.ok(pat && al, 'both drawn');
  assert.equal(pat.status, '', 'no paused node state');
  assert.deepEqual(pat.pres, al.pres, 'judged by presence exactly as the active member');
  assert.ok(!/paused/i.test(JSON.stringify(pat)), 'the word never reaches the node');
  assert.doesNotMatch(src, /'paused'/, 'netModel carries no paused branch');
  assert.doesNotMatch(html, /data-status="paused"/, 'and no paused node style is left to match');
  const counts = html.slice(html.indexOf('function lifecycleCounts(){'), html.indexOf('return c;', html.indexOf('function lifecycleCounts(){')));
  assert.doesNotMatch(counts, /'paused'/, 'the Overview counts a paused row as active too');
});

// ---- 6: "From your rocks" is face-aware --------------------------------------
test('6: a rock with no ties shows no "From your rocks" group; a pebble keeps the join hint', () => {
  const render = html.slice(html.indexOf('function renderSkills()'), html.indexOf('function skillRow('));
  const guard = render.indexOf('if (IS_ORG && !order.length && !attached) return;');
  const head = render.indexOf("skGroupHead(box, 'From your rocks')");
  assert.ok(guard > 0 && head > guard, 'the face guard runs before the group heading is drawn');
  assert.ok(render.indexOf('var attached =') < guard, 'and after the tie read it depends on');
  assert.match(render, /Join one on the Organisations page/, 'the pebble copy survives for pebbles');
});

// ---- 7: vocabulary, case, colour ---------------------------------------------
test('7: Decline is the one word for saying no; nothing on the page says Reject', () => {
  assert.doesNotMatch(uncommented(html).join('\n'), /\bReject\b/);
  assert.ok((html.match(/textContent = 'Decline'/g) || []).length >= 3, 'join rows, tie rows and pending rows all say Decline');
});

test('7: the door banner words are sentence case, never shouted', () => {
  for (const m of html.matchAll(/class="word">([^<]*)</g)) {
    assert.doesNotMatch(m[1], /[A-Z]{2,}/, 'banner word: ' + m[1]);
    assert.match(m[1], /^[A-Z][^A-Z]*$/, 'sentence case: ' + m[1]);
  }
  assert.doesNotMatch(html, /#commBanner \.word\{[^}]*text-transform/, 'no CSS uppercase on the banner word');
});

test('7: the "Torn down" chip on an Ended row keeps the soft ended colour', () => {
  assert.doesNotMatch(html, /\.fleet-erow \.ehow\.torn\{/, 'no torn-specific tint rule');
  const base = html.match(/\.fleet-erow \.ehow\{[^}]*\}/)[0];
  assert.ok(!/--accent|--bad|--warn/.test(base), 'the chip rule uses no action or alarm colour: ' + base);
  assert.match(html, /class="ehow' \+ \(m\.decommissioned \? ' torn' : ''\) \+ '">' \+ esc\(cap\(how\)\)/, 'the chip still names how it ended');
});

// ---- driven: the chip overlaps nothing at 1280 (Decisions) and 640 ----------
let chromium = null;
try { ({ chromium } = await import(join(HERE, '..', 'dev-harness', 'node_modules', 'playwright', 'index.mjs'))); } catch { /* no local playwright */ }

test('driven: the version chip sits in the header and overlaps no control at 1280 or 640', { skip: !chromium && 'playwright not installed under wizard/dev-harness' }, async () => {
  const PORT = 4000 + Math.floor(Math.random() * 2000);
  const harness = spawn(process.execPath, [join(HERE, '..', 'dev-harness', 'harness.mjs'), '--port', String(PORT)], { stdio: 'pipe' });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('harness did not start')), 8000);
    harness.stdout.on('data', (d) => { if (String(d).includes('dev-harness up')) { clearTimeout(t); res(); } });
    harness.on('exit', (c) => rej(new Error('harness exited early ' + c)));
  });
  const browser = await chromium.launch();
  const overlaps = async (page) => page.evaluate(() => {
    const chip = document.getElementById('verChip');
    const r = chip.getBoundingClientRect();
    const hits = [];
    for (const el of document.querySelectorAll('button, input, select, a, textarea, .toggle')) {
      if (el === chip || el.offsetParent === null) continue;
      const b = el.getBoundingClientRect();
      if (b.width && b.height && r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top) hits.push((el.id || el.className || el.tagName) + ':' + (el.textContent || '').trim().slice(0, 20));
    }
    return { inHeader: !!chip.closest('header.top'), fixed: getComputedStyle(chip).position, text: chip.textContent, hits };
  });
  try {
    for (const [width, path, hash] of [[1280, '/panel', '#decisions'], [640, '/member', '#dashboard'], [640, '/panel', '#decisions']]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://localhost:${PORT}${path}`, { waitUntil: 'load' });
      await page.waitForTimeout(2000);
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForTimeout(1800);
      const o = await overlaps(page);
      assert.equal(o.inHeader, true, `${width} ${path}: chip is in the header row`);
      assert.notEqual(o.fixed, 'fixed', `${width} ${path}: chip is in flow`);
      assert.ok(o.text.length > 0, 'the chip says something');
      assert.deepEqual(o.hits, [], `${width} ${path}: the chip overlaps ${o.hits.join(', ')}`);
      if (hash === '#decisions') {
        const words = await page.locator('section[data-sec="decisions"] .pendrow button').allTextContents();
        assert.ok(words.length > 0 && !words.some((w) => /reject/i.test(w)), 'Decisions rows say Decline, not Reject: ' + JSON.stringify(words));
      }
      // the fold opens below the chip, inside the viewport
      await page.locator('#verChip').click();
      await page.waitForTimeout(300);
      const fold = await page.evaluate(() => { const r = document.getElementById('verLog').getBoundingClientRect(); const c = document.getElementById('verChip').getBoundingClientRect(); return { top: r.top, chipBottom: c.bottom, right: r.right, vw: innerWidth, shown: getComputedStyle(document.getElementById('verLog')).display }; });
      assert.equal(fold.shown, 'block');
      assert.ok(fold.top >= fold.chipBottom && fold.right <= fold.vw, `${width}: the fold hangs below the chip inside the viewport ${JSON.stringify(fold)}`);
      assert.deepEqual(errors, [], 'no page errors');
      await page.close();
    }
  } finally {
    await browser.close();
    harness.kill();
  }
});
