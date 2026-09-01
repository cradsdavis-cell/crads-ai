// P5.5: "Your rocks" picker. GET /my-orgs shows the member's edges (org, role,
// status) after they confirm their email, merged with locally-connected boxes. The
// verified email and token never appear in any response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
import { createMemberConnectServer } from './member-connect.mjs';

const tmp = () => tmpDir('myorgs-');
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.' + Buffer.from(JSON.stringify({ email: 'jane@example.com' })).toString('base64url') + '.sig';

const listen = (opts) => new Promise((resolve) => {
  const s = createMemberConnectServer({ port: 0, host: '127.0.0.1', htmlText: '<html>connect</html>',
    claudeSettingsPath: join(tmp(), 'settings.json'), ...opts });
  s.on('listening', () => resolve(s));
});
const post = (s, path, body) => fetch(`http://127.0.0.1:${s.address().port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const get = (s, path) => fetch(`http://127.0.0.1:${s.address().port}${path}`);

test('refresh -> my-orgs merges central edges with local boxes; secrets never leak', async () => {
  const fetcher = async (url) => {
    if (url.includes('/edges')) return { ok: true, status: 200, json: async () => ({ edges: [
      { org: 'pillars', box: 'jane01.crads-ai.com', role: 'member', status: 'active', slug: 'jane01', owner: 'org', updated: 9 },
      { org: 'streams', box: 'rock.crads-ai.com', role: 'admin', status: 'active', slug: 'jane-adm', updated: 9 },
    ] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const s = await listen({
    myOrgsFetcher: fetcher,
    myOrgsSignIn: async () => ({ ok: true, idToken: TOKEN }),
    listTargets: () => [{ host: 'jane01-box', org: 'jane01', kind: 'member' }],
  });
  try {
    const r0 = await (await get(s, '/my-orgs')).json();
    assert.equal(r0.signedIn, false);
    const rf = await post(s, '/my-orgs/refresh');
    assert.equal((await rf.json()).ok, true);
    let body;
    for (let i = 0; i < 40; i++) { body = await (await get(s, '/my-orgs')).json(); if (body.signedIn) break; await new Promise((r) => setTimeout(r, 25)); }
    assert.equal(body.signedIn, true);
    assert.equal(body.orgs.length, 2);
    const pillars = body.orgs.find((o) => o.org === 'pillars');
    assert.equal(pillars.role, 'member');
    assert.equal(pillars.connected, true, 'jane01 edge matches the local jane01-box');
    assert.equal(pillars.owner, 'org', 'O3: owner passes through to the picker');
    const streams = body.orgs.find((o) => o.org === 'streams');
    assert.equal(streams.role, 'admin');
    assert.equal(streams.connected, false, 'admin edge, no local box for it');
    assert.ok(!('owner' in streams), 'O3: absent owner stays absent');
    assert.ok(!JSON.stringify(body).includes(TOKEN) && !JSON.stringify(body).includes('.sig'), 'id_token never in the response');
    assert.ok(!JSON.stringify(body).includes('jane@example.com'), 'email never in the response');
  } finally { s.close(); }
});

test('hybrid: member of one org + admin of another both render (from edges)', async () => {
  const fetcher = async () => ({ ok: true, status: 200, json: async () => ({ edges: [
    { org: 'a', role: 'member', status: 'active', slug: 'm', box: 'm.x', updated: 1 },
    { org: 'b', role: 'admin', status: 'active', slug: 'adm', box: 'p.x', updated: 1 },
  ] }) });
  const s = await listen({ myOrgsFetcher: fetcher, myOrgsSignIn: async () => ({ ok: true, idToken: TOKEN }), listTargets: () => [] });
  try {
    await post(s, '/my-orgs/refresh');
    let body; for (let i = 0; i < 40; i++) { body = await (await get(s, '/my-orgs')).json(); if (body.signedIn) break; await new Promise((r) => setTimeout(r, 25)); }
    assert.deepEqual(body.orgs.map((o) => o.role).sort(), ['admin', 'member']);
  } finally { s.close(); }
});

test('sign-in refusal leaves it not-signed-in with a reason, local boxes still listed', async () => {
  const s = await listen({ myOrgsSignIn: async () => ({ ok: false, reason: 'denied' }),
    listTargets: () => [{ host: 'jane01-box', org: 'jane01', kind: 'member' }] });
  try {
    await post(s, '/my-orgs/refresh');
    let body; for (let i = 0; i < 30; i++) { body = await (await get(s, '/my-orgs')).json(); if (body.reason) break; await new Promise((r) => setTimeout(r, 25)); }
    assert.equal(body.signedIn, false);
    assert.match(body.reason, /denied/);
    assert.equal(body.orgs.length, 1, 'the locally-connected box still shows even without sign-in');
    assert.equal(body.orgs[0].connected, true);
  } finally { s.close(); }
});

import { readFileSync as _rf } from 'node:fs';
import { fileURLToPath as _fu } from 'node:url';
import { dirname as _dn, join as _jn } from 'node:path';




test('pause honesty: a paused edge\'s reason + date ride through /my-orgs to the screen', async () => {
  const fetcher = async (url) => {
    if (url.includes('/edges')) return { ok: true, status: 200, json: async () => ({ edges: [
      { org: 'pillars', box: 'jane01.crads-ai.com', role: 'member', status: 'paused', slug: 'jane01',
        paused_reason: 'unpaid three months, talk to us', paused: '2026-08-03', updated: 9 },
    ] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const s = await listen({
    myOrgsFetcher: fetcher,
    myOrgsSignIn: async () => ({ ok: true, idToken: TOKEN }),
    listTargets: () => [],
  });
  try {
    await post(s, '/my-orgs/refresh');
    let body;
    for (let i = 0; i < 40; i++) { body = await (await get(s, '/my-orgs')).json(); if (body.signedIn) break; await new Promise((r) => setTimeout(r, 25)); }
    const o = body.orgs.find((x) => x.org === 'pillars');
    assert.equal(o.status, 'paused');
    assert.equal(o.paused_reason, 'unpaid three months, talk to us');
    assert.equal(o.paused, '2026-08-03');
  } finally { s.close(); }
});

// The three static assertions that used to sit here checked the member-connect
// PAGE: renderMyOrgs's helpers, the org-owned label, and the own-brain card's
// precheck gate. All three surfaces were deleted on 2026-08-09, when Sam ruled
// the invite page is the invite claim and nothing else (your-rocks and GitHub
// backup both already live in the box's own app). The ROUTES they shared this
// file with are untouched and still covered above; what follows replaces the
// page assertions with the one thing that must stay true of that page now.
test('the invite page hosts neither the your-rocks picker nor the own-brain card', () => {
  const html = readFileSync(join(HERE, 'member-connect.html'), 'utf8');
  for (const gone of ['renderMyOrgs', 'myOrgsBtn', 'orgsFold', 'obFold', 'obStart', 'ownBrainCard']) {
    assert.ok(!html.includes(gone), `member-connect still carries ${gone}: the page is the invite claim only`);
  }
});
