import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeKeypair, mintIdToken, fixtureJwksSource } from './test-fixtures/idtoken-fixtures.mjs';
import { verifyIdToken, ReplayGuard } from './idtoken-verify.mjs';

const kp = makeKeypair();
const jwks = fixtureJwksSource(kp.jwk);
const base = { email: 'jane@example.com', audience: 'test-client-id', jwksSource: jwks };

test('valid token verifies and returns the email', async () => {
  const tok = mintIdToken(kp.privateKey);
  const r = await verifyIdToken(tok, base);
  assert.equal(r.ok, true);
  assert.equal(r.email, 'jane@example.com');
});

test('email comparison is case-insensitive', async () => {
  const tok = mintIdToken(kp.privateKey, { email: 'Jane@Example.com' });
  const r = await verifyIdToken(tok, base);
  assert.equal(r.ok, true);
});

test('wrong email is refused', async () => {
  const tok = mintIdToken(kp.privateKey, { email: 'mallory@evil.com' });
  const r = await verifyIdToken(tok, base);
  assert.equal(r.ok, false);
  assert.match(r.reason, /email/i);
});

test('unverified email is refused', async () => {
  const tok = mintIdToken(kp.privateKey, { email_verified: false });
  const r = await verifyIdToken(tok, base);
  assert.equal(r.ok, false);
  assert.match(r.reason, /verified/i);
});

test('wrong audience is refused', async () => {
  const tok = mintIdToken(kp.privateKey, { aud: 'someone-elses-app' });
  const r = await verifyIdToken(tok, base);
  assert.equal(r.ok, false);
  assert.match(r.reason, /audience/i);
});

test('unknown issuer is refused', async () => {
  const tok = mintIdToken(kp.privateKey, { iss: 'https://idp.evil.com' });
  const r = await verifyIdToken(tok, base);
  assert.equal(r.ok, false);
  assert.match(r.reason, /issuer/i);
});

test('Microsoft v2 issuer needs a pinned tenant: accepted only with the matching msTenants pin', async () => {
  const tok = mintIdToken(kp.privateKey, { iss: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0' });
  assert.equal((await verifyIdToken(tok, base)).ok, false, 'unpinned Microsoft is refused (nOAuth)');
  assert.equal((await verifyIdToken(tok, { ...base, msTenants: ['9188040d-6c67-4c5b-b112-36a304b66dad'] })).ok, true);
});

test('expired token is refused', async () => {
  const now = Math.floor(Date.now() / 1000);
  const tok = mintIdToken(kp.privateKey, { iat: now - 7200, exp: now - 3600 });
  const r = await verifyIdToken(tok, base);
  assert.equal(r.ok, false);
  assert.match(r.reason, /expired/i);
});

test('far-future iat is refused', async () => {
  const now = Math.floor(Date.now() / 1000);
  const tok = mintIdToken(kp.privateKey, { iat: now + 3600, exp: now + 7200 });
  const r = await verifyIdToken(tok, base);
  assert.equal(r.ok, false);
  assert.match(r.reason, /issued/i);
});

test('tampered payload fails the signature', async () => {
  const tok = mintIdToken(kp.privateKey);
  const [h, p, s] = tok.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  claims.email = 'jane@example.com'; claims.aud = 'test-client-id'; claims.admin = true;
  const forged = h + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + s;
  const r = await verifyIdToken(forged, base);
  assert.equal(r.ok, false);
  assert.match(r.reason, /signature/i);
});

test('alg none is refused outright', async () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'test-client-id', email: 'jane@example.com', email_verified: true, iat: now, exp: now + 3600 })).toString('base64url');
  const r = await verifyIdToken(header + '.' + payload + '.', base);
  assert.equal(r.ok, false);
});

test('key with a different kid is not found', async () => {
  const tok = mintIdToken(kp.privateKey, {}, { header: { kid: 'some-other-kid' } });
  const r = await verifyIdToken(tok, base);
  assert.equal(r.ok, false);
  assert.match(r.reason, /key/i);
});

test('garbage input does not throw', async () => {
  for (const junk of ['', 'not.a.jwt', 'a.b', null, undefined, 'x'.repeat(20000)]) {
    const r = await verifyIdToken(junk, base);
    assert.equal(r.ok, false);
  }
});

test('replay guard refuses the second use of the same token', async () => {
  const guard = new ReplayGuard({ ttlMs: 60000 });
  const tok = mintIdToken(kp.privateKey);
  const r1 = await verifyIdToken(tok, { ...base, replayGuard: guard });
  assert.equal(r1.ok, true);
  const r2 = await verifyIdToken(tok, { ...base, replayGuard: guard });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /replay/i);
});

test('replay guard expires entries after the ttl', async () => {
  let t = 1000;
  const guard = new ReplayGuard({ ttlMs: 50, now: () => t });
  const tok = mintIdToken(kp.privateKey);
  assert.equal((await verifyIdToken(tok, { ...base, replayGuard: guard })).ok, true);
  t += 100; // beyond ttl
  assert.equal((await verifyIdToken(tok, { ...base, replayGuard: guard })).ok, true);
});

// ---- security-review regressions (2026-07-24 pre-merge review) ----

test('nOAuth: Google token with ABSENT email_verified is refused', async () => {
  const tok = mintIdToken(kp.privateKey, { email_verified: undefined });
  const r = await verifyIdToken(tok, base);
  assert.equal(r.ok, false);
  assert.match(r.reason, /verified/i);
});

test('nOAuth: Microsoft token from an UNPINNED tenant is refused even with a perfect email', async () => {
  const tok = mintIdToken(kp.privateKey, { iss: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0', email_verified: undefined });
  const r1 = await verifyIdToken(tok, base);                                        // no pin configured
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /not enabled|tenant/i);
  const r2 = await verifyIdToken(tok, { ...base, msTenants: ['11111111-2222-3333-4444-555555555555'] }); // wrong pin
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /tenant/i);
});

test('Microsoft token from the PINNED tenant passes without email_verified (Entra omits it)', async () => {
  const tok = mintIdToken(kp.privateKey, { iss: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0', email_verified: undefined });
  const r = await verifyIdToken(tok, { ...base, msTenants: ['9188040D-6C67-4C5B-B112-36A304B66DAD'] });
  assert.equal(r.ok, true);
});

test('key binding: nonce must equal the expected device fingerprint', async () => {
  const good = mintIdToken(kp.privateKey, { nonce: 'MQESOO' });
  assert.equal((await verifyIdToken(good, { ...base, expectedNonce: 'MQESOO' })).ok, true);
  assert.equal((await verifyIdToken(good, { ...base, expectedNonce: 'mqesoo' })).ok, true, 'case-insensitive');
  const swapped = await verifyIdToken(good, { ...base, expectedNonce: 'ZZZZZZ' });
  assert.equal(swapped.ok, false);
  assert.match(swapped.reason, /nonce/i);
  const missing = await verifyIdToken(mintIdToken(kp.privateKey), { ...base, expectedNonce: 'MQESOO' });
  assert.equal(missing.ok, false, 'token without a nonce cannot enrol a key');
});

test('key rotation: a kid missing from the cached JWKS triggers ONE forced refetch', async () => {
  const calls = [];
  const stale = { keys: [] };
  const fresh = { keys: [kp.jwk] };
  const source = async (iss, kid, opts = {}) => { calls.push(!!opts.forceRefresh); return opts.forceRefresh ? fresh : stale; };
  const r = await verifyIdToken(mintIdToken(kp.privateKey), { ...base, jwksSource: source });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [false, true]);
});
