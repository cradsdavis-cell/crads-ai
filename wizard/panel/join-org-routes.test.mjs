// P4.6: the member-driven join flow — look up an org handle, sign in, ask to
// join, poll for the outcome; the invite feeds the existing redeem flow. The
// member's poll secret + tokens live server-side in memory (+ a resumable
// dotfile) and never appear in any HTTP response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createMemberConnectServer } from './member-connect.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const tmp = () => tmpDir('jo-routes-');

const listen = (opts) => new Promise((resolve) => {
  const s = createMemberConnectServer({ port: 0, host: '127.0.0.1', htmlText: '<html>connect</html>',
    claudeSettingsPath: join(tmp(), 'settings.json'), ...opts });
  s.on('listening', () => resolve(s));
});
const post = (s, path, body) => fetch(`http://127.0.0.1:${s.address().port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (s, path) => fetch(`http://127.0.0.1:${s.address().port}${path}`);

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.' + Buffer.from(JSON.stringify({ email: 'jane@example.com' })).toString('base64url') + '.sig';

function workerStub({ statusScript = [] } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url.includes('/route')) return { ok: true, status: 200, json: async () => ({ rock_ssh_host: '203.0.113.5', org_display: 'Pillars' }) };
    if (url.includes('/join-request')) return { ok: true, status: 200, json: async () => ({ ok: true, id: 'cafe1234cafe1234cafe' }) };
    if (url.includes('/join-status')) { const next = statusScript.length > 1 ? statusScript.shift() : statusScript[0]; return { ok: true, status: 200, json: async () => next }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  f.calls = calls;
  return f;
}

test('lookup -> submit -> approved: invite surfaces, secrets never do', async () => {
  const fetcher = workerStub({ statusScript: [{ status: 'pending' }, { status: 'approved', invite: 'https://crads-ai.com/join#v1.pillars.jane01.cGF5bG9hZA' }] });
  const s = await listen({ sshDir: tmp(), joinFetcher: fetcher, joinStatePath: join(tmp(), 'join.json'), joinPollMs: 20,
    joinSignIn: async ({ nonce }) => ({ ok: true, idToken: TOKEN, nonceSeen: nonce }) });
  try {
    const lu = await (await post(s, '/join-org/lookup', { handle: 'pillars' })).json();
    assert.equal(lu.orgDisplay, 'Pillars');
    const sub = await (await post(s, '/join-org/submit', { handle: 'pillars', name: 'Cert Jane' })).json();
    assert.equal(sub.ok, true);
    let body;
    for (let i = 0; i < 60; i++) {
      body = await (await get(s, '/join-org/status')).json();
      if (body.stage === 'approved' || body.stage === 'failed') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(body.stage, 'approved');
    assert.match(body.invite, /join#v1\.pillars/);
    assert.ok(!JSON.stringify(body).includes('sig'), 'id_token never in responses');
    const req = fetcher.calls.find((c) => c.url.includes('/join-request'));
    assert.equal(req.body.org, 'pillars');
    assert.equal(req.body.email, 'jane@example.com', 'email extracted from the signed token');
    assert.match(req.body.secret_hash, /^[0-9a-f]{64}$/);
    const statusCall = fetcher.calls.find((c) => c.url.includes('/join-status'));
    assert.ok(!statusCall.url.includes(req.body.secret_hash), 'poll carries the SECRET, not its hash');
  } finally { s.close(); }
});

test('declined: the note reaches the member', async () => {
  const fetcher = workerStub({ statusScript: [{ status: 'declined', note: 'Not right now.' }] });
  const s = await listen({ sshDir: tmp(), joinFetcher: fetcher, joinStatePath: join(tmp(), 'join.json'), joinPollMs: 20,
    joinSignIn: async () => ({ ok: true, idToken: TOKEN }) });
  try {
    await post(s, '/join-org/submit', { handle: 'pillars', name: 'Cert Jane' });
    let body;
    for (let i = 0; i < 60; i++) {
      body = await (await get(s, '/join-org/status')).json();
      if (body.stage === 'declined' || body.stage === 'failed') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(body.stage, 'declined');
    assert.match(body.note, /Not right now/);
  } finally { s.close(); }
});

test('unknown handle is a clean 404 at lookup; sign-in refusal surfaces as failed', async () => {
  const fetcher = async (url) => ({ ok: false, status: 404, json: async () => ({ error: 'unknown org' }) });
  const s = await listen({ sshDir: tmp(), joinFetcher: fetcher, joinStatePath: join(tmp(), 'join.json'),
    joinSignIn: async () => ({ ok: false, reason: 'sign-in was denied' }) });
  try {
    assert.equal((await post(s, '/join-org/lookup', { handle: 'ghost' })).status, 404);
  } finally { s.close(); }
});

test('pending request survives a restart via the state file', async () => {
  const statePath = join(tmp(), 'join.json');
  const fetcher1 = workerStub({ statusScript: [{ status: 'pending' }] });
  const s1 = await listen({ sshDir: tmp(), joinFetcher: fetcher1, joinStatePath: statePath, joinPollMs: 20,
    joinSignIn: async () => ({ ok: true, idToken: TOKEN }) });
  await post(s1, '/join-org/submit', { handle: 'pillars', name: 'Cert Jane' });
  await new Promise((r) => setTimeout(r, 80));
  s1.close();
  assert.ok(existsSync(statePath), 'pending state persisted');
  assert.ok(!readFileSync(statePath, 'utf8').includes(TOKEN), 'the id_token is not persisted');
  const fetcher2 = workerStub({ statusScript: [{ status: 'approved', invite: 'https://crads-ai.com/join#v1.pillars.jane01.cGF5bG9hZA' }] });
  const s2 = await listen({ sshDir: tmp(), joinFetcher: fetcher2, joinStatePath: statePath, joinPollMs: 20 });
  try {
    let body;
    for (let i = 0; i < 60; i++) {
      body = await (await get(s2, '/join-org/status')).json();
      if (body.stage === 'approved') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(body.stage, 'approved', 'a restarted app resumes polling and gets the invite');
  } finally { s2.close(); }
});

import { joinNonce } from './member-connect.mjs';
import { createHash } from 'node:crypto';

test('submit binds the sign-in nonce to the org handle (anti cross-org replay)', async () => {
  let nonceSeen = '';
  const fetcher = workerStub({ statusScript: [{ status: 'pending' }] });
  const s = await listen({ sshDir: tmp(), joinFetcher: fetcher, joinStatePath: join(tmp(), 'join.json'), joinPollMs: 9999,
    joinSignIn: async ({ nonce }) => { nonceSeen = nonce; return { ok: true, idToken: TOKEN }; } });
  try {
    await post(s, '/join-org/submit', { handle: 'pillars', name: 'Cert Jane' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(nonceSeen, createHash('sha256').update('crads-join:pillars').digest('hex'));
    assert.equal(joinNonce('Pillars'), nonceSeen, 'joinNonce is case-insensitive on the handle');
  } finally { s.close(); }
});
