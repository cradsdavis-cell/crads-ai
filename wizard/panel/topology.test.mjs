// topology.test.mjs — the topology sandbox page is RETIRED (2026-09-01).
//
// The page was the hosted pricing model's reference diagram (example worlds,
// anchor fees, Stripe tier bands). The one-face wave deleted the file and the
// GET /topology route with it; what SURVIVES is the Map section inside the one
// shell (member.html), which draws the member's real world from POST
// /topology/world. These tests pin the retirement (the route stays gone, the
// file stays gone, the shell never links the dead page) and the surviving
// contract (the world route still answers; the dead org deep links still land
// on the seat).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPanelServer } from './panel-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const listen = (opts) => new Promise((resolve) => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html>x</html>', ...opts });
  s.on('listening', () => resolve(s));
});
const get = (s, path) => fetch(`http://127.0.0.1:${s.address().port}${path}`);

test('GET /topology is GONE: the one server answers 404, even for an old caller passing topologyHtml', async () => {
  for (const opts of [{}, { topologyHtml: '<html>baked topology</html>' }]) {
    const s = await listen(opts);
    try {
      const r = await get(s, '/topology');
      assert.equal(r.status, 404, 'the sandbox route must stay retired, not resurrect from an option');
    } finally { s.close(); }
  }
});

test('the file is gone from the tree, and no server code path can read it back', () => {
  assert.ok(!existsSync(join(HERE, 'topology.html')), 'topology.html must not return to wizard/panel/');
  const src = readFileSync(join(HERE, 'panel-server.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.doesNotMatch(src, /topologyHtml/, 'no live code consumes a baked topology page');
  assert.doesNotMatch(src, /topology\.html/, 'no live code reads the deleted file');
});

test('POST /topology/world SURVIVES: the Map section inside the shell depends on it', () => {
  // The route is exercised end-to-end by map-iter2 / qa-network; here we pin
  // that the dispatcher still carries it so a future sweep cannot take the
  // live half of the map down with the dead sandbox.
  const src = readFileSync(join(HERE, 'panel-server.mjs'), 'utf8');
  assert.match(src, /path === '\/topology\/world'/, 'the world route is still mounted');
  const member = readFileSync(join(HERE, 'member.html'), 'utf8');
  assert.match(member, /fetch\('\/topology\/world'/, 'and the shell still asks it for the real world');
});

// ---- surviving alias contracts, moved here from the app-link drift-guard ----
// The sandbox used to deep-link org sections; old bookmarks and old pages may
// still carry those hashes, so the shell's alias tables must keep landing them
// on living surfaces.
test('the org sections stay RETIRED, and their deep links land on the seat', () => {
  const shell = readFileSync(join(HERE, 'member.html'), 'utf8');
  const live = shell.replace(/<!--[\s\S]*?-->/g, '');
  for (const sec of ['yourrock', 'pebbles', 'decisions', 'rocks']) {
    assert.ok(!live.includes(`data-sec="${sec}"`), `the ${sec} section stays gone`);
  }
  assert.ok(!live.includes("'transfer-to-member'"), 'the six-verb transfer UI stays gone');
  assert.ok(!live.includes('id="stampBtn"'), 'the stamp button stays gone');
  assert.match(shell, /if \(name === 'pebbles' \|\| name === 'decisions' \|\| name === 'yourrock'\) name = 'seat';/,
    'activateSec carries the dead org names to the seat');
  assert.match(shell, /if \(h === 'pebbles' \|\| h === 'decisions' \|\| h === 'yourrock'\) h = 'seat';/,
    'and secFromHash mirrors it, so a deep link lands there too');
  assert.match(shell, /secFromHash/, 'the shell deep-links #sections');
  assert.match(shell, /hashchange/, 'and reacts to hash navigation');
});

test('the member link targets moved with their cards: support access on Help, transfer accept retired', () => {
  const member = readFileSync(join(HERE, 'member.html'), 'utf8');
  assert.ok(!member.includes('<section data-sec="sharing">'), 'the Sharing section stays gone');
  assert.match(member, /if \(h === 'sharing'\) h = 'help';/, 'a #sharing deep link lands on Help');
  assert.match(member, /id="supportGrant"/, 'where the support grant now lives');
  assert.ok(!member.includes('id="taBtn"'), 'the transfer-accept button retired with the custody machinery');
});

test('the shell links no example worlds: /topology never appears as an href', () => {
  const shell = readFileSync(join(HERE, 'member.html'), 'utf8');
  assert.doesNotMatch(shell, /href="\/topology/, 'the shell never links the dead sandbox');
});
