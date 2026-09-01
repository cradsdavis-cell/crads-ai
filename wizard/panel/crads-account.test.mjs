// crads-account.test.mjs — the app side of the ONE Crads account (T5).
// The contract under test: silent-first (disk session, no UI), interactive
// second (loopback + one-time code), Google fallback third, and a nonce/scope
// ask ALWAYS reaches the mint (the handover lesson: a stub that swallows its
// arguments hides a dead path).
// Run: node --test wizard/panel/crads-account.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getAppToken, signInWithCrads, interactiveSignIn, readSession, currentEmail, signOut } from './crads-account.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const dir = () => tmpDir('crads-acct-');
const SITE = 'https://site.test';

function seedSession(p, over = {}) {
  writeFileSync(p, JSON.stringify({
    email: 'sam@x.com', session_jwt: 'sess-jwt-1',
    app_token: 'cached-token', app_token_exp: Date.now() + 3600 * 1000, ...over,
  }));
}

// a fetcher that records every call and answers from a route table
function fakeFetcher(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ path, body, auth: (init.headers || {}).authorization || '' });
    const route = routes[path];
    if (!route) return { ok: false, status: 404, json: async () => ({}) };
    const out = typeof route === 'function' ? route({ path, body, init }) : route;
    return { ok: (out.status || 200) < 400, status: out.status || 200, json: async () => out.body || {} };
  };
  f.calls = calls;
  return f;
}

test('silent mint: a fresh cached token is reused with no network; a nonce ask mints anew and is never cached', async () => {
  const sessionPath = join(dir(), 's.json');
  seedSession(sessionPath);
  const fetcher = fakeFetcher({
    '/api/auth/app-token': ({ body }) => ({ body: { ok: true, app_token: `minted:${body.nonce || ''}:${body.scope || ''}`, app_token_exp: Date.now() + 3600e3 } }),
  });
  const plain = await getAppToken({ sessionPath, siteUrl: SITE, fetcher });
  assert.equal(plain.ok, true);
  assert.equal(plain.idToken, 'cached-token', 'fresh cached token reused');
  assert.equal(plain.email, 'sam@x.com');
  assert.equal(fetcher.calls.length, 0, 'no network for a fresh plain token');

  const bound = await getAppToken({ sessionPath, siteUrl: SITE, fetcher, nonce: 'abc123', scope: 'enrol' });
  assert.equal(bound.ok, true);
  assert.equal(bound.idToken, 'minted:abc123:enrol', 'the mint RECEIVED the nonce and scope');
  assert.equal(fetcher.calls[0].auth, 'Bearer sess-jwt-1', 'session rides the Authorization header');
  const onDisk = JSON.parse(readFileSync(sessionPath, 'utf8'));
  assert.equal(onDisk.app_token, 'cached-token', 'a bound token is never cached');
});

test('an expired cache mints and re-caches; a 401 says sign-in-needed and leaves the file standing', async () => {
  const sessionPath = join(dir(), 's.json');
  seedSession(sessionPath, { app_token_exp: Date.now() - 1000 });
  const fetcher = fakeFetcher({
    '/api/auth/app-token': { body: { ok: true, app_token: 'fresh-token', app_token_exp: Date.now() + 3600e3 } },
  });
  const r = await getAppToken({ sessionPath, siteUrl: SITE, fetcher });
  assert.equal(r.idToken, 'fresh-token');
  assert.equal(JSON.parse(readFileSync(sessionPath, 'utf8')).app_token, 'fresh-token', 'plain mints re-cache');

  const revokedPath = join(dir(), 's.json');
  seedSession(revokedPath, { app_token_exp: Date.now() - 1000 });
  const dead = fakeFetcher({ '/api/auth/app-token': { status: 401, body: { error: 'sign_in_needed' } } });
  const refused = await getAppToken({ sessionPath: revokedPath, siteUrl: SITE, fetcher: dead });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'sign-in-needed');
  assert.ok(existsSync(revokedPath), 'a refusal never deletes the session file');
  assert.equal((await getAppToken({ sessionPath: join(dir(), 'none.json'), siteUrl: SITE, fetcher })).reason, 'sign-in-needed', 'no session at all is the same honest answer');
});

test('interactive: browser consent lands on the loopback, the code redeems, the session lands on disk 0600', async () => {
  const sessionPath = join(dir(), 's.json');
  const fetcher = fakeFetcher({
    '/api/auth/app-redeem': ({ body }) => (body.code === 'good-code'
      ? { body: { ok: true, email: 'sam@x.com', session_jwt: 'sess-2', app_token: 'tok-2', app_token_exp: Date.now() + 3600e3 } }
      : { status: 401, body: { error: 'invalid_code' } }),
  });
  // the "browser": follow the consent redirect straight back to the loopback,
  // trying a forged state first — it must be refused without killing the flow
  const openBrowser = async (url) => {
    const u = new URL(url);
    assert.equal(u.pathname, '/account/app-login', 'consent page is the destination');
    const port = u.searchParams.get('port');
    const state = u.searchParams.get('state');
    const forged = await fetch(`http://127.0.0.1:${port}/cb?code=evil&state=forged`);
    assert.equal(forged.status, 400, 'a forged state is refused');
    await fetch(`http://127.0.0.1:${port}/cb?code=good-code&state=${encodeURIComponent(state)}`);
    return true;
  };
  const r = await interactiveSignIn({ sessionPath, siteUrl: SITE, fetcher, openBrowser });
  assert.equal(r.ok, true);
  assert.equal(r.email, 'sam@x.com');
  const mode = statSync(sessionPath).mode & 0o777;
  assert.equal(mode, 0o600, 'the session file is private to the user');
  assert.equal(readSession({ sessionPath }).session_jwt, 'sess-2');
  assert.equal(currentEmail({ sessionPath }), 'sam@x.com');
  signOut({ sessionPath });
  assert.equal(readSession({ sessionPath }), null, 'signOut forgets the machine');
});

test('signInWithCrads binds a fresh interactive session to the asked nonce (mint AFTER redeem)', async () => {
  const sessionPath = join(dir(), 's.json');
  const fetcher = fakeFetcher({
    '/api/auth/app-redeem': { body: { ok: true, email: 'jo@x.com', session_jwt: 'sess-3', app_token: 'unbound', app_token_exp: Date.now() + 3600e3 } },
    '/api/auth/app-token': ({ body }) => ({ body: { ok: true, app_token: `bound:${body.nonce}`, app_token_exp: Date.now() + 3600e3 } }),
  });
  const openBrowser = async (url) => {
    const u = new URL(url);
    await fetch(`http://127.0.0.1:${u.searchParams.get('port')}/cb?code=c&state=${encodeURIComponent(u.searchParams.get('state'))}`);
    return true;
  };
  const r = await signInWithCrads({ sessionPath, siteUrl: SITE, fetcher, openBrowser, nonce: 'join-nonce-1', googleFallback: null });
  assert.equal(r.ok, true);
  assert.equal(r.idToken, 'bound:join-nonce-1', 'the asked nonce reached the mint, not the unbound redeem token');
});

test('google fallback: an unreachable site falls back to Google WITH the same nonce; both-fail names both reasons', async () => {
  const sessionPath = join(dir(), 's.json');
  const deadFetcher = async () => { throw new Error('site is down'); };
  const noBrowser = async () => false;
  const googleCalls = [];
  const googleFallback = async ({ nonce }) => { googleCalls.push(nonce); return { ok: true, idToken: 'google-token' }; };
  const r = await signInWithCrads({
    sessionPath, siteUrl: SITE, fetcher: deadFetcher, openBrowser: noBrowser, timeoutMs: 300,
    nonce: 'the-join-nonce', googleFallback,
  });
  assert.equal(r.ok, true);
  assert.equal(r.idToken, 'google-token');
  assert.deepEqual(googleCalls, ['the-join-nonce'], 'the fallback RECEIVED the same nonce (the binding survives the fallback)');

  const bothFail = await signInWithCrads({
    sessionPath, siteUrl: SITE, fetcher: deadFetcher, openBrowser: noBrowser, timeoutMs: 300,
    googleFallback: async () => ({ ok: false, reason: 'user closed it' }),
  });
  assert.equal(bothFail.ok, false);
  assert.match(bothFail.reason, /crads:/);
  assert.match(bothFail.reason, /google: user closed it/);
});
