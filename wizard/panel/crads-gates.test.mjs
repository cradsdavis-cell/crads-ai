// crads-gates.test.mjs — T5: the app signs in as the Crads account and the
// Google gates fall. What is under test is the WIRING, with stubs that record
// what they received (the handover lesson: a stub that swallows its arguments
// hides a dead path):
//   1. startup seeding — a disk session populates /rock-mine with NO sign-in
//      button and NO pop-up (the amnesia is structurally gone)
//   2. communityToken — an aged retained token silently re-mints instead of
//      dead-ending at the old 50-minute wall
//   3. the door account row — /account, /inventory/full, signin/signout
//   4. anti-drift source pins — every switched gate defaults to crads-account,
//      and the ONE deliberate holdout (the D58 enrolment handshake) stays
//      Google until T9 puts crads-token-verify on the boxes
// Run: node --test wizard/panel/crads-gates.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPanelServer } from './panel-server.mjs';
import { createDoorServer } from './door-server.mjs';

const jwt = (email) => 'h.' + Buffer.from(JSON.stringify({ email })).toString('base64url') + '.s';
const listen = (make, opts) => new Promise((resolve) => {
  const s = make({ port: 0, host: '127.0.0.1', htmlText: '<html>x</html>', ...opts });
  s.on('listening', () => resolve(s));
});
const get = (s, path) => fetch(`http://127.0.0.1:${s.address().port}${path}`);
const post = (s, path, body = {}) => fetch(`http://127.0.0.1:${s.address().port}${path}`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const EDGES = [
  { org: 'acme', role: 'member', status: 'active', slug: 'jane01', rel: 'joined', org_display: 'Acme' },
  { org: 'home', role: 'member', status: 'active', slug: 'jane01', rel: 'anchored', owner: 'org', org_display: 'Home' },
];
// The door's minerals list moved off the edge graph on 2026-08-12: /edges cannot
// say whether a mineral is YOURS (its `owner` field means org-owned, a different
// question), and the door was captioning everything "Your minerals". /my-minerals
// carries held_by, so both surfaces now read one source.
const MY_MINERALS = [
  { host: 'jane01.crads-ai.com', label: 'Acme', tier: 'pebble', tie: 'joined',
    status: 'active', role: 'owner', held_by: 'you' },
  { host: 'home01.crads-ai.com', label: 'Home', tier: 'rock', tie: 'anchored',
    status: 'active', role: 'user', held_by: 'someone else' },
];
function dirFetcher(calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), auth: (init.headers || {}).authorization || '' });
    if (String(url).includes('/my-minerals')) return { ok: true, status: 200, json: async () => ({ minerals: MY_MINERALS }) };
    if (String(url).includes('/edges')) return { ok: true, status: 200, json: async () => ({ edges: EDGES }) };
    if (String(url).includes('/rock-tie-notices')) return { ok: true, status: 200, json: async () => ({ notices: [] }) };
    if (String(url).includes('/rock-brain-page')) return { ok: true, status: 200, json: async () => ({ ok: true, page: { id: 'x', title: 'X' } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('startup seeding: a disk session populates /rock-mine with no sign-in and no pop-up', async () => {
  const minted = [];
  const calls = [];
  const s = await listen(createPanelServer, {
    edition: 'member',
    bridge: { targets: () => [], stream: () => {}, tty: () => {} },
    directoryUrl: 'https://dir.example',
    communityFetcher: dirFetcher(calls),
    accountToken: async (o) => { minted.push(o); return { ok: true, idToken: jwt('sam@x.com'), email: 'sam@x.com' }; },
    // NO communitySignIn: an interactive path reached here would be the bug
    communitySignIn: async () => { throw new Error('interactive sign-in must never fire at startup'); },
  });
  try {
    await new Promise((r) => setTimeout(r, 120));
    const mine = await (await get(s, '/rock-mine')).json();
    assert.equal(mine.signedIn, true, 'the app knows who it is before any button');
    assert.equal(mine.mine.length, 2, 'both ties are there on first paint');
    assert.ok(minted.length >= 1, 'the silent mint was consulted');
    assert.ok(calls.some((c) => c.url.includes('/edges') && c.auth === `Bearer ${jwt('sam@x.com')}`),
      'the edges read RECEIVED the minted token as the bearer');
    assert.ok(!JSON.stringify(mine).includes('sam@x.com'), 'the email never reaches the page');
  } finally { s.close(); }
});

test('communityToken: an aged retained token re-mints silently past the old 50-minute wall', async () => {
  const minted = [];
  const calls = [];
  let probes = 0;
  const s = await listen(createPanelServer, {
    edition: 'member',
    bridge: { targets: () => [], stream: () => {}, tty: () => {} },
    directoryUrl: 'https://dir.example',
    communityFetcher: dirFetcher(calls),
    // startup probe says sign-in-needed; every later mint succeeds
    accountToken: async (o) => {
      probes += 1;
      if (probes === 1) return { ok: false, reason: 'sign-in-needed' };
      minted.push(o); return { ok: true, idToken: jwt('sam@x.com'), email: 'sam@x.com' };
    },
  });
  try {
    await new Promise((r) => setTimeout(r, 60));
    // an hour-old retained token: the old code answered sign-in-needed here
    s._communityMine = { idToken: 'aged-token', tokenAt: Date.now() - 51 * 60 * 1000 };
    // Re-pointed 2026-08-17 (one-inbox): this drove /community-item, the
    // tie-gated content fetch behind a community install, which is retired with
    // that whole delivery path. communityToken itself is unchanged and still
    // gates the rock-brain reads, so the re-mint contract is pinned against one
    // of those instead. The property under test was never about installing.
    const r = await get(s, '/rock-brain-page?org=acme&id=x');
    assert.equal(r.status, 200, 'the fetch survives the aged token');
    assert.ok(minted.length >= 1, 'a fresh token was minted from the disk session');
    const item = calls.find((c) => c.url.includes('/rock-brain-page'));
    assert.equal(item.auth, `Bearer ${jwt('sam@x.com')}`, 'the directory RECEIVED the re-minted token, not the aged one');
    assert.equal(s._communityMine.idToken, jwt('sam@x.com'), 'the retained state moved to the fresh token');
  } finally { s.close(); }
});

test('the door account row is RETIRED (2026-09-01): the account routes answer 404', async () => {
  // The row, T5 and the whole crads-account layer left with the self-host
  // pivot; door.test.mjs pins every /account route as a 404. This file keeps
  // only the module-level truths above it.
  const { createDoorServer } = await import('./door-server.mjs');
  const s = createDoorServer({ port: 0, bridge: { targets: () => [] } });
  await new Promise((r) => s.on('listening', r));
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    for (const p of ['/account', '/account/devices']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 404, `${p} must stay gone`);
    }
  } finally { s.closeAllConnections?.(); s.close(); }
});

test('anti-drift RETIRED (2026-09-01): no gate defaults to crads-account any more', () => {
  // The switched gates all pointed sign-in at the crads account. The account
  // system is deleted; the door and panel no longer import crads-account at
  // all, which is the stronger version of what this test used to hold.
  const door = readFileSync(new URL('./door-server.mjs', import.meta.url), 'utf8');
  assert.ok(!door.includes("import('./crads-account.mjs')"), 'the door never reaches for the account module');
});
