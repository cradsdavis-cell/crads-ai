// mcp-oauth-lib.test.mjs — run: node --test engine/comms/mcp-oauth-lib.test.mjs
//
// Our own OAuth, replacing the puppeteered CLI. Fetch is injected, so every
// branch is exercised without a network; the live servers (canva, notion) were
// checked by hand first and their real shapes are what these fakes mimic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pkce, newState, discover, register, authorizeUrl, exchange, refresh, tokenRecord, stateMatches } from './mcp-oauth-lib.mjs';

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const AS = {
  authorization_endpoint: 'https://mcp.canva.com/authorize',
  token_endpoint: 'https://mcp.canva.com/token',
  registration_endpoint: 'https://mcp.canva.com/register',
  code_challenge_methods_supported: ['plain', 'S256'],
};

test('PKCE is S256 and the challenge really is the hash of the verifier', () => {
  const { verifier, challenge, method } = pkce();
  assert.equal(method, 'S256', 'plain is advertised by real servers and must never be chosen');
  const expect = createHash('sha256').update(verifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(challenge, expect);
  assert.notEqual(pkce().verifier, verifier, 'a fresh verifier per flow');
});

test('discovery follows protected-resource → authorization-server', async () => {
  const seen = [];
  const f = async (u) => {
    seen.push(u);
    if (u.endsWith('/.well-known/oauth-protected-resource')) return res(200, { authorization_servers: ['https://auth.example.com'] });
    if (u === 'https://auth.example.com/.well-known/oauth-authorization-server') return res(200, AS);
    return res(404, {});
  };
  const m = await discover(f, 'https://mcp.example.com/mcp');
  assert.equal(m.token_endpoint, AS.token_endpoint);
  assert.equal(m._as, 'https://auth.example.com');
  assert.match(seen[0], /oauth-protected-resource$/);
});

test('a server with no protected-resource doc falls back to its own origin', async () => {
  // canva and notion both behave this way, so this is the common path, not the edge
  const f = async (u) => (u === 'https://mcp.canva.com/.well-known/oauth-authorization-server' ? res(200, AS) : res(404, {}));
  const m = await discover(f, 'https://mcp.canva.com/mcp');
  assert.equal(m.authorization_endpoint, AS.authorization_endpoint);
});

test('a server advertising nothing usable fails in words a member can read', async () => {
  await assert.rejects(() => discover(async () => res(404, {}), 'https://nope.example/mcp'),
    /does not advertise an OAuth endpoint/i);
});

test('registration sends OUR redirect, and that is the point of the whole design', async () => {
  let body = null;
  const f = async (_u, o) => { body = JSON.parse(o.body); return res(201, { client_id: 'abc123' }); };
  const { clientId } = await register(f, AS, 'http://127.0.0.1:53119/callback');
  assert.equal(clientId, 'abc123');
  assert.deepEqual(body.redirect_uris, ['http://127.0.0.1:53119/callback'],
    'the browser must land on the APP, not on the box — that is what removes the paste step');
  assert.ok(body.grant_types.includes('refresh_token'), 'ask for refresh or the member re-signs in forever');
  assert.equal(body.token_endpoint_auth_method, 'none', 'public client; PKCE is the protection');
});

test('a provider without registration says so plainly (this is Google)', async () => {
  await assert.rejects(() => register(async () => res(201, {}), { token_endpoint: 'x' }, 'http://127.0.0.1:1/cb'),
    /needs a client ID set up by hand/i);
});

test('the authorize URL carries PKCE, state and the resource', () => {
  const u = new URL(authorizeUrl({
    meta: AS, clientId: 'abc', redirectUri: 'http://127.0.0.1:1/cb',
    challenge: 'CH', state: 'ST', resource: 'https://mcp.canva.com/mcp',
  }));
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('code_challenge'), 'CH');
  assert.equal(u.searchParams.get('state'), 'ST');
  assert.equal(u.searchParams.get('response_type'), 'code');
  // RFC 8707: without this a provider hosting many resources can mint a token for the wrong one
  assert.equal(u.searchParams.get('resource'), 'https://mcp.canva.com/mcp');
});

test('the exchange sends the verifier, and a refusal is not silently swallowed', async () => {
  let sent = null;
  const ok = async (_u, o) => { sent = new URLSearchParams(o.body); return res(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }); };
  const j = await exchange(ok, AS, { code: 'C', clientId: 'abc', redirectUri: 'http://127.0.0.1:1/cb', verifier: 'V', resource: 'R' });
  assert.equal(j.access_token, 'AT');
  assert.equal(sent.get('code_verifier'), 'V');
  assert.equal(sent.get('grant_type'), 'authorization_code');
  await assert.rejects(() => exchange(async () => res(400, {}), AS, { code: 'C', clientId: 'a', redirectUri: 'r', verifier: 'v' }),
    /would not issue a token \(400\)/);
});

test('refresh reuses the refresh token and reports a refusal', async () => {
  let sent = null;
  const f = async (_u, o) => { sent = new URLSearchParams(o.body); return res(200, { access_token: 'AT2', expires_in: 60 }); };
  await refresh(f, AS, { refreshToken: 'RT', clientId: 'abc' });
  assert.equal(sent.get('grant_type'), 'refresh_token');
  assert.equal(sent.get('refresh_token'), 'RT');
  await assert.rejects(() => refresh(async () => res(401, {}), AS, { refreshToken: 'x', clientId: 'y' }), /refresh refused \(401\)/);
});

test('the stored record makes expiry ABSOLUTE, and unknown stays unknown', () => {
  const r = tokenRecord({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }, 1_000_000);
  assert.equal(r.expires_at, 1_000_000 + 3600_000, 'a relative lifetime is useless to a job reading this hours later');
  // a provider that says nothing must NOT be treated as expired: that would break
  // a working connection on a guess
  assert.equal(tokenRecord({ access_token: 'AT' }).expires_at, null);
  assert.equal(tokenRecord({ access_token: 'AT' }).refresh_token, null);
  assert.throws(() => tokenRecord({}), /no access token/);
});

test('state comparison is constant-time and rejects every near miss', () => {
  const s = newState();
  assert.equal(stateMatches(s, s), true);
  assert.equal(stateMatches(s, s + 'x'), false, 'length differs');
  assert.equal(stateMatches(s, s.slice(0, -1) + '!'), false, 'last char differs');
  assert.equal(stateMatches('', ''), false, 'empty must never match: it is the CSRF guard');
  assert.equal(stateMatches(s, ''), false);
  assert.equal(stateMatches(s, undefined), false);
});
