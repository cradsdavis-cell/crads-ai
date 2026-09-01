// The /topology route: the model's reference diagram served in every box's app.
// One file, both editions; the console faces link it with ?open=/&seat= instead
// of hand-forking per person. These tests pin the serving contract (both
// editions serve it, the baked-asset override wins, a build without the page
// 404s honestly) and the boot contract inside the page itself (query-string
// preset/seat with safe fallbacks), which is the one intended divergence from
// the mockup this file is copied from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPanelServer } from './panel-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const listen = (opts) => new Promise((resolve) => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html>x</html>', ...opts });
  s.on('listening', () => resolve(s));
});
const get = (s, path) => fetch(`http://127.0.0.1:${s.address().port}${path}`);

test('org edition serves /topology from disk with an html content-type', async () => {
  const s = await listen({});
  try {
    const r = await get(s, '/topology');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    const body = await r.text();
    assert.match(body, /CRADS AI TOPOLOGY/, 'the sandbox page, not some other html');
    assert.match(body, /BOOT_Q/, 'carries the query-string boot block');
  } finally { s.close(); }
});

test('member edition serves the same page', async () => {
  const s = await listen({ edition: 'member' });
  try {
    const r = await get(s, '/topology');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /CRADS AI TOPOLOGY/);
  } finally { s.close(); }
});

test('the baked SEA asset wins over the disk file (the exe has no disk files)', async () => {
  const s = await listen({ topologyHtml: '<html>baked topology</html>' });
  try {
    assert.equal(await (await get(s, '/topology')).text(), '<html>baked topology</html>');
  } finally { s.close(); }
});

// ---- the boot block itself: static assertions on the shipped file ----------
// (No browser here; the QA suites drive real Chromium. These pin the contract
// the page must keep for the console links to keep meaning something.)
const page = readFileSync(join(HERE, 'topology.html'), 'utf8');

test('boot block: unknown presets fall back to the reference default (ic)', () => {
  assert.match(page, /PRESETS\[BOOT_Q\.get\('open'\)\]\s*\?\s*BOOT_Q\.get\('open'\)\s*:\s*'ic'/);
});

test('boot block: a seat is honoured only if it is CRADS or a box in the opened preset', () => {
  assert.match(page, /s === 'CRADS' \|\| \(s && nodes\.some\(n => n\.id === s\)\)/);
});

test('boot block: the selected node is the first node of the opened preset', () => {
  assert.match(page, /let sel = nodes\[0\] \? nodes\[0\]\.id : 'CRADS'/);
});

test('the presets the console links rely on exist in the page', () => {
  for (const key of ['ic:', 'fresh:', 'hostmix:', 'enterprise:']) {
    assert.ok(page.includes(key), `preset ${key} present`);
  }
});

// ---- the app-link layer: edition stamp + drift-guards -----------------------

test('the server stamps its edition into the page, per edition', async () => {
  for (const [opts, want] of [[{}, '"org"'], [{ edition: 'member' }, '"member"']]) {
    const s = await listen(opts);
    try {
      const body = await (await get(s, '/topology')).text();
      assert.ok(body.includes(`const EDITION = ${want}`), `stamped ${want}`);
      assert.ok(!body.includes('__AIOS_EDITION__'), 'placeholder gone');
    } finally { s.close(); }
  }
});

// Every target in the LINKS map must exist in the face it points at. This is
// the drift-guard: if a section is renamed or a real surface is removed, the
// map (and this test) must move with it, or the link would lie.
test('org-face link targets exist: People carries the transfer verbs + stamp, Danger the teardown', () => {
  const org = readFileSync(join(HERE, 'member.html'), 'utf8');
  // renamed 2026-08-09 (upgraded-pebble): People -> Operators, the fleet ->
  // Pebbles, Actions -> Decisions, and the Danger zone folded under Your rock
  assert.ok(!/data-sec="operators"/.test(org), 'the Operators page died with the one-admin ruling (2026-08-09)');
  assert.match(org, /data-sec="yourrock"/);
  assert.match(org, /data-sec="pebbles"/);
  assert.match(org, /data-sec="decisions"/);
  assert.match(org, /'transfer-to-member'/, 'the six-verb transfer UI lives in the org panel');
  assert.match(org, /id="stampBtn"/);
  assert.ok(!/id="dzBtn"/.test(org), 'the global teardown died: it lives on the member card now');
  assert.match(org, /Tear down this mineral/, 'the per-card teardown copy exists');
  assert.match(org, /secFromHash/, 'org panel deep-links #sections (the links depend on it)');
  assert.match(org, /hashchange/, 'org panel reacts to hash navigation');
});

test('member-face link targets exist: Sharing carries support access, the dashboard the transfer accept', () => {
  const member = readFileSync(join(HERE, 'member.html'), 'utf8');
  assert.match(member, /data-sec="sharing"/);
  assert.match(member, /id="supportGrant"/, 'support grant lives under Sharing');
  assert.match(member, /id="taBtn"/, 'accept-transfer lives on the member app');
  assert.match(member, /secFromHash/, 'member panel deep-links #sections');
});

test('the layer maps only real surfaces: every href in LINKS is one of the known set', () => {
  const layer = page.slice(page.indexOf('APP-LINK LAYER'));
  const hrefs = [...layer.matchAll(/\['(\/[^']*)'/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 6, `found the map (${hrefs.length} targets)`);
  const known = ['/panel.html#pebbles', '/panel.html#dashboard', '/panel.html#sharing',
    '/panel.html#yourrock', '/panel.html#decisions', '/panel.html#rocks', '/panel.html#pebbles', '/door', '/console'];   // /console = the member seat page, which survives
  for (const h of hrefs) assert.ok(known.includes(h), `${h} is a verified surface`);
});

test('the org face links the sandbox; the member face links its own real network', () => {
  // Changed 2026-08-03 (Sam). The member face used to open /topology with no
  // query, which falls back to the Acme CoLab worked example: a member asking
  // to see THEIR network got a fictional world of two communities and a company,
  // on a standalone page with no way back into the app. The personal map is now
  // a section inside the app, drawn from real box state (qa-network.test.mjs).
  // The sandbox keeps its example worlds for the org/reference face, which is
  // what they are for.
  // The org console retired with P3 (2026-08-09); nothing links the sandbox
  // from either face any more. The reference route survives for its example
  // worlds, but a person on a real face always gets their real surfaces.
  const member = readFileSync(join(HERE, 'member-console.html'), 'utf8');
  assert.doesNotMatch(member, /href="\/topology/, 'the member face must not hand a person to the example worlds');
  assert.match(member, /href="\/panel\.html#network"/, 'it opens the real map inside the app instead');
  const shell = readFileSync(join(HERE, 'member.html'), 'utf8');
  assert.doesNotMatch(shell, /href="\/topology/, 'the shell never links the sandbox either');
});

test('vocabulary (Mountain model 2026-08-04): the fee a pebble pays its anchor is the ANCHOR FEE', () => {
  const html = readFileSync(new URL('./topology.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /home membership/i, '"home membership" is dead vocabulary (28 Jul reconciliation + 4 Aug ruling)');
  assert.match(html, /anchor fee/, 'the ruled word is on the surface');
  assert.match(html, /'homeMember'/, 'the RATE KEY stays, so saved rates survive the rename');
});

test('value view mirrors the simplified money model (2026-08-04): bands align, nothing per-head', () => {
  const html = readFileSync(new URL('./topology.html', import.meta.url), 'utf8');
  assert.match(html, /home: 10,\s+comm: 50,/, 'tier-1 band mirrors crads-bands.json');
  assert.match(html, /home: 60,\s+comm: 400,/, 'tier-3 band mirrors crads-bands.json');
  assert.match(html, /NOTHING is charged per head/, 'the simplification is stated where the fee is defined');
  assert.match(html, /crads-rock-tier-1\.\.3/, 'the live Stripe lookup keys are named at the rates');
});
