// google-signin: the interactive OAuth leg of the verified handshake (D58).
// System browser -> Google -> loopback redirect -> PKCE code exchange -> id_token.
// The nonce parameter is the DEVICE FINGERPRINT (security contract: the rock
// refuses any token whose nonce does not match the staged key).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pkcePair, buildAuthUrl, signInWithGoogle, signInForTokens, browserCommand } from './google-signin.mjs';

test('pkcePair: S256 challenge matches the verifier, charset is base64url', () => {
  const { verifier, challenge } = pkcePair();
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
});

test('buildAuthUrl carries every required parameter, nonce included', () => {
  const u = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:9/cb', nonce: 'MQESOO', state: 'st1', challenge: 'ch1', loginHint: 'jane@example.com' }));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const q = u.searchParams;
  assert.equal(q.get('client_id'), 'cid');
  assert.equal(q.get('redirect_uri'), 'http://127.0.0.1:9/cb');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('scope'), 'openid email profile');
  assert.equal(q.get('nonce'), 'MQESOO');
  assert.equal(q.get('state'), 'st1');
  assert.equal(q.get('code_challenge'), 'ch1');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('login_hint'), 'jane@example.com');
});

// Full loop with a stub browser (curls the callback) + stub token endpoint.
function stubBrowser({ code = 'authcode-1', tamperState = false, error = '' } = {}) {
  return async (url) => {
    const u = new URL(url);
    const cb = new URL(u.searchParams.get('redirect_uri'));
    const state = tamperState ? 'WRONG' : u.searchParams.get('state');
    if (error) cb.search = `?error=${error}&state=${state}`;
    else cb.search = `?code=${code}&state=${state}`;
    await fetch(cb).catch(() => {});
  };
}

test('happy path: browser callback + code exchange yields the id_token', async () => {
  const exchanges = [];
  const fetcher = async (url, init) => {
    exchanges.push(Object.fromEntries(new URLSearchParams(init.body)));
    return { ok: true, json: async () => ({ id_token: 'h.p.sig' }) };
  };
  const r = await signInWithGoogle({ clientId: 'cid', clientSecret: 'cs', nonce: 'MQESOO', openBrowser: stubBrowser(), fetcher, timeoutMs: 8000 });
  assert.equal(r.ok, true);
  assert.equal(r.idToken, 'h.p.sig');
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].code, 'authcode-1');
  assert.equal(exchanges[0].client_id, 'cid');
  assert.equal(exchanges[0].grant_type, 'authorization_code');
  assert.ok(exchanges[0].code_verifier, 'PKCE verifier sent on exchange');
});

test('a tampered state is ignored, the flow times out instead of accepting it', async () => {
  const fetcher = async () => { throw new Error('exchange must never run'); };
  const r = await signInWithGoogle({ clientId: 'cid', clientSecret: 'cs', nonce: 'X', openBrowser: stubBrowser({ tamperState: true }), fetcher, timeoutMs: 1500 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /timed out/i);
});

test('user denies consent: clean refusal, no exchange', async () => {
  const fetcher = async () => { throw new Error('exchange must never run'); };
  const r = await signInWithGoogle({ clientId: 'cid', clientSecret: 'cs', nonce: 'X', openBrowser: stubBrowser({ error: 'access_denied' }), fetcher, timeoutMs: 8000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /denied|cancelled/i);
});

test('no browser answers: times out with a reason, never hangs', async () => {
  const r = await signInWithGoogle({ clientId: 'cid', clientSecret: 'cs', nonce: 'X', openBrowser: async () => {}, fetcher: async () => ({ ok: true, json: async () => ({}) }), timeoutMs: 1200 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /timed out/i);
});

test('exchange failure surfaces as a refusal, not a crash', async () => {
  const fetcher = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
  const r = await signInWithGoogle({ clientId: 'cid', clientSecret: 'cs', nonce: 'X', openBrowser: stubBrowser(), fetcher, timeoutMs: 8000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /exchange/i);
});

test('Windows opener never routes the URL through cmd (the & command-separator bug)', () => {
  const url = buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:9/cb', nonce: 'MQESOO', state: 'st1', challenge: 'ch1' });
  assert.ok(/&response_type=code/.test(url), 'sanity: the URL has ampersand-joined params');
  const win = browserCommand('win32', url);
  assert.notEqual(win.cmd, 'cmd', 'must not use cmd.exe (splits the URL at every &)');
  assert.equal(win.cmd, 'rundll32');
  // the FULL url must ride as ONE argv token, ampersands intact, never split
  assert.ok(win.args.includes(url), 'the whole URL is a single argument');
  assert.ok(win.args.every((a) => a === url || !a.includes(url.split('&')[1])), 'no arg is a truncated URL tail');
});

// ---- signInForTokens: the BYO-Google leg (member's own client, full token
// record back, no nonce because there is no id_token contract) ---------------

test('signInForTokens: offline + consent + the given scopes ride the auth URL, tokens come back', async () => {
  const opened = [];
  const browser = async (url) => { opened.push(url); await stubBrowser()(url); };
  const exchanges = [];
  const fetcher = async (url, init) => {
    exchanges.push(Object.fromEntries(new URLSearchParams(init.body)));
    return { ok: true, json: async () => ({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599, scope: 'https://s/a https://s/b' }) };
  };
  const r = await signInForTokens({ clientId: 'cid', clientSecret: 'cs', scopes: ['https://s/a', 'https://s/b'], loginHint: 'jane@example.com', openBrowser: browser, fetcher, timeoutMs: 8000 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tokens, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599, scope: 'https://s/a https://s/b' });
  const q = new URL(opened[0]).searchParams;
  assert.equal(q.get('access_type'), 'offline', 'offline access is what mints the refresh_token');
  assert.equal(q.get('prompt'), 'consent', 'consent must be re-shown or Google withholds the refresh_token');
  assert.equal(q.get('scope'), 'https://s/a https://s/b', 'the requested scopes, space-joined');
  assert.equal(q.get('login_hint'), 'jane@example.com');
  assert.equal(q.get('nonce'), null, 'no id_token contract, so no nonce');
  assert.equal(exchanges.length, 1);
  assert.ok(exchanges[0].code_verifier, 'PKCE verifier sent on exchange');
});

test('signInForTokens: a refresh_token Google withheld is passed through absent, not invented', async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({ access_token: 'at-1', expires_in: 3599, scope: 's' }) });
  const r = await signInForTokens({ clientId: 'cid', clientSecret: 'cs', scopes: ['s'], openBrowser: stubBrowser(), fetcher, timeoutMs: 8000 });
  assert.equal(r.ok, true);
  assert.equal(r.tokens.refresh_token, undefined, 'the caller decides what a missing refresh_token means');
});

test('signInForTokens: a tampered state is ignored, the flow times out instead of accepting it', async () => {
  const fetcher = async () => { throw new Error('exchange must never run'); };
  const r = await signInForTokens({ clientId: 'cid', clientSecret: 'cs', scopes: ['s'], openBrowser: stubBrowser({ tamperState: true }), fetcher, timeoutMs: 1500 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /timed out/i);
});

test('signInForTokens: refuses to start without a client or scopes', async () => {
  const noBrowser = async () => { throw new Error('the browser must never open'); };
  let r = await signInForTokens({ clientId: '', clientSecret: 'cs', scopes: ['s'], openBrowser: noBrowser });
  assert.equal(r.ok, false);
  assert.match(r.reason, /client id and secret/i);
  r = await signInForTokens({ clientId: 'cid', clientSecret: 'cs', scopes: [], openBrowser: noBrowser });
  assert.equal(r.ok, false);
  assert.match(r.reason, /scope/i);
});

test('mac + linux openers pass the whole URL as one arg', () => {
  const url = buildAuthUrl({ clientId: 'c', redirectUri: 'http://127.0.0.1:9/cb', nonce: 'N', state: 's', challenge: 'ch' });
  assert.deepEqual(browserCommand('darwin', url), { cmd: 'open', args: [url] });
  assert.deepEqual(browserCommand('linux', url), { cmd: 'xdg-open', args: [url] });
});
