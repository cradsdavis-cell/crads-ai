// P1.2: the /redeem staging envelope carries an optional OAuth id_token so the
// rock can verify the member's identity end-to-end (spec 2026-07-24 § 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createMemberConnectServer, stageWithDirectory } from './member-connect.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const tmp = () => tmpDir('mc-stage-');

// A well-formed invite link: v1.<org>.<slug>.<b64url("host|sip|user|token")>
const payload = Buffer.from('jane01.example.com|203.0.113.9|member|tok-abc123').toString('base64url');
const LINK = `https://crads-ai.com/join#v1.acme.jane01.${payload}`;

const inv = { org: 'acme', slug: 'jane01', host: 'jane01.example.com', sip: '203.0.113.9', user: 'member', token: 'tok-abc123' };

test('stageWithDirectory includes id_token when given and omits it when absent', async () => {
  const bodies = [];
  const fetcher = async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true }; };
  await stageWithDirectory(inv, 'ssh-ed25519 AAAA key', 'ABC123', { idToken: 'header.payload.sig', fetcher, directoryUrl: 'https://dir.example' });
  await stageWithDirectory(inv, 'ssh-ed25519 AAAA key', 'ABC123', { fetcher, directoryUrl: 'https://dir.example' });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].id_token, 'header.payload.sig');
  assert.equal(bodies[0].org, 'acme');
  assert.ok(!('id_token' in bodies[1]), 'no-token envelope must not carry the field');
});

test('oversized id_token is dropped from the envelope, not sent', async () => {
  const bodies = [];
  const fetcher = async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true }; };
  await stageWithDirectory(inv, 'ssh-ed25519 AAAA key', 'ABC123', { idToken: 'x'.repeat(20000), fetcher, directoryUrl: 'https://dir.example' });
  assert.ok(!('id_token' in bodies[0]));
});

const listen = (opts) => new Promise((resolve) => {
  const s = createMemberConnectServer({ port: 0, host: '127.0.0.1', htmlText: '<html>connect</html>',
    claudeSettingsPath: join(tmp(), 'settings.json'), ...opts });
  s.on('listening', () => resolve(s));
});
const post = (s, path, body) => fetch(`http://127.0.0.1:${s.address().port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('server /redeem: idTokenProvider token reaches the staging envelope', async () => {
  const staged = [];
  const s = await listen({
    sshDir: tmp(),
    stageWithDirectory: async (i, pub, fp, extra) => { staged.push({ i, extra }); return true; },
    idTokenProvider: async (i, dev) => (i.slug === 'jane01' && /^ssh-ed25519 /.test(dev.publicKey) && /^[A-Z2-7]{6}$/.test(dev.fingerprint) ? 'provided.id.token' : null),
  });
  try {
    const r = await post(s, '/redeem', { link: LINK });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.staged, true);
    assert.equal(j.id_token_sent, true);
    assert.equal(staged.length, 1);
    assert.equal(staged[0].extra.idToken, 'provided.id.token');
  } finally { s.close(); }
});

// REVERSED by Harriet's audit 2026-08-21, point 5. This used to assert that a standalone
// pebble never runs the handshake, on the grounds that it has no rock to verify a device
// against. POST /redeem became that verifier itself (it checks the token, binds it to the
// device key by nonce and records the address, none of which needs a rock), and until it
// did, possession of a standalone invite link was the entire proof of a claim. The second
// half of the old test is the half that survives, because the 180s freeze it names is a
// real incident and the new bound is what keeps it fixed: asking must not be able to hang.
//
// The twin of this lives in redeem-signin-required.test.mjs. Both are kept: that one owns
// the predicate, this one owns the server envelope, and letting them drift is how the
// 135 -> 136 -> 139 -> 141 chain kept reopening.
test('server /redeem: a SOLO invite now runs the sign-in, and still cannot hang', async () => {
  let providerCalls = 0;
  const soloPayload = Buffer.from('solo01.crads-ai.com|203.0.113.9|member|tok-abc123').toString('base64url');
  const s = await listen({
    sshDir: tmp(),
    stageWithDirectory: async () => true,
    // a provider that models the real failure: it never settles on its own
    idTokenProvider: () => { providerCalls += 1; return new Promise(() => {}); },
    signInTimeoutMs: 50,   // operator-side bound, never a caller field
  });
  try {
    const started = Date.now();
    const r = await post(s, '/redeem', { link: `https://crads-ai.com/join#v1.crads-solo.solo01.${soloPayload}` });
    assert.equal(providerCalls, 1, 'the standalone lane is account-bound now, so it asks');
    assert.equal(r.status, 401, 'a sign-in that never completes refuses, it does not downgrade');
    const j = await r.json();
    assert.match(String(j.error || ''), /locked to the email address/);
    assert.ok(Date.now() - started < 5000, 'and it must not block on a handshake');
  } finally { s.close(); }
});

test('server /redeem: an ORG invite still runs the verified handshake', async () => {
  let providerCalls = 0;
  const s = await listen({
    sshDir: tmp(),
    stageWithDirectory: async () => true,
    idTokenProvider: async () => { providerCalls += 1; return 'org.id.token'; },
  });
  try {
    const j = await (await post(s, '/redeem', { link: LINK })).json();
    assert.equal(providerCalls, 1, 'org redeem must still verify the device');
    assert.equal(j.id_token_sent, true);
  } finally { s.close(); }
});

test('server /redeem: form id_token passthrough wins; absent means manual path (no token, still staged)', async () => {
  const staged = [];
  const s = await listen({
    sshDir: tmp(),
    stageWithDirectory: async (i, pub, fp, extra) => { staged.push(extra); return true; },
  });
  try {
    const r1 = await post(s, '/redeem', { link: LINK, id_token: 'from.the.form' });
    assert.equal((await r1.json()).id_token_sent, true);
    const r2 = await post(s, '/redeem', { link: LINK });
    const j2 = await r2.json();
    assert.equal(j2.staged, true);
    assert.equal(j2.id_token_sent, false);
    assert.equal(staged[0].idToken, 'from.the.form');
    assert.equal(staged[1].idToken, '');
  } finally { s.close(); }
});
