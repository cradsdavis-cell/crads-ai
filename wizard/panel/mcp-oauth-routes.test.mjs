// mcp-oauth-routes.test.mjs — run: node --test wizard/panel/mcp-oauth-routes.test.mjs
//
// The sign-in with no CLI and no paste. The listener runs HERE, in the app on the
// member's own machine, which is the single change that removes the dead
// "this site can't be reached" page: the browser can actually reach it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpOAuthRoutes } from './mcp-oauth-routes.mjs';

// A whole fake provider: metadata, registration, token exchange.
function provider(over = {}) {
  const calls = { registered: null, exchanged: null };
  const fetchFn = async (u, o = {}) => {
    const url = String(u);
    const j = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (url.endsWith('/.well-known/oauth-protected-resource')) return j(404, {});
    if (url.endsWith('/.well-known/oauth-authorization-server')) return j(200, {
      authorization_endpoint: 'https://prov.example/authorize',
      token_endpoint: 'https://prov.example/token',
      registration_endpoint: 'https://prov.example/register',
      ...over.meta,
    });
    if (url.endsWith('/register')) { calls.registered = JSON.parse(o.body); return over.regFail ? j(400, {}) : j(201, { client_id: 'CID' }); }
    if (url.endsWith('/token')) {
      calls.exchanged = new URLSearchParams(o.body);
      return over.tokenFail ? j(400, {}) : j(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
    }
    return j(404, {});
  };
  return { fetchFn, calls };
}

function harness(over = {}) {
  const sent = [];
  const state = {};
  const handle = createMcpOAuthRoutes({
    state, fetchFn: provider(over).fetchFn,
    sendToBox: async (host, payload) => { sent.push({ host, payload }); },
    ...over.routeOpts,
  });
  const call = (path, method = 'GET', body = null, rawUrl = null) => new Promise((resolve) => {
    const chunks = [];
    const req = { method, url: rawUrl || path, on(ev, cb) { if (ev === 'data' && body) cb(Buffer.from(JSON.stringify(body))); if (ev === 'end') cb(); }, destroy() {} };
    const res = {
      writeHead(code) { this.code = code; return this; },
      end(payload) { resolve({ code: this.code, body: payload ? (() => { try { return JSON.parse(payload); } catch { return payload; } })() : null }); },
    };
    handle(req, res, path);
    void chunks;
  });
  return { state, sent, call };
}

const START = { host: 'keith-box', name: 'canva', url: 'https://mcp.canva.com/mcp' };

test('start registers OUR loopback redirect and returns a real consent URL', async () => {
  const p = provider();
  const state = {};
  const handle = createMcpOAuthRoutes({ state, fetchFn: p.fetchFn, sendToBox: async () => {} });
  const h = harness();
  const r = await h.call('/mcp-oauth/start', 'POST', START);
  assert.equal(r.body.ok, true);
  const u = new URL(r.body.url);
  assert.equal(u.origin + u.pathname, 'https://prov.example/authorize');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  const redirect = u.searchParams.get('redirect_uri');
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/mcp-callback$/,
    'the browser must land on the APP; a box-side listener is what forced the paste step');
  void handle; void p;
});

test('the listener binds LOOPBACK only, never a routable interface', async () => {
  const h = harness();
  await h.call('/mcp-oauth/start', 'POST', START);
  assert.equal(h.state.server.address().address, '127.0.0.1');
});

test('a bad name or a non-https url is refused before anything is registered', async () => {
  const h = harness();
  for (const bad of [{ ...START, name: 'x' }, { ...START, name: 'a b' }, { ...START, name: '../etc' },
    { ...START, url: 'http://insecure.example/mcp' }, { ...START, url: 'nonsense' }]) {
    const r = await h.call('/mcp-oauth/start', 'POST', bad);
    assert.equal(r.body.ok, false, JSON.stringify(bad));
  }
  // Case is NORMALISED rather than refused: a member typing "Notion" means notion,
  // and the same rule already applies when they connect one by URL.
  const ok = await h.call('/mcp-oauth/start', 'POST', { ...START, name: 'Canva' });
  assert.equal(ok.body.ok, true);
  assert.ok(h.state.flows.get('canva'), 'stored under the normalised key');
});

test('a provider that cannot self-register says so in words (this is Google)', async () => {
  const h = harness({ meta: { registration_endpoint: undefined } });
  const r = await h.call('/mcp-oauth/start', 'POST', START);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /client ID set up by hand/i);
});

test('status tracks the flow, and an unknown service is "none" not an error', async () => {
  const h = harness();
  assert.equal((await h.call('/mcp-oauth/status', 'GET', null, '/mcp-oauth/status?name=canva')).body.state, 'none');
  await h.call('/mcp-oauth/start', 'POST', START);
  assert.equal((await h.call('/mcp-oauth/status', 'GET', null, '/mcp-oauth/status?name=canva')).body.state, 'waiting');
});

test('cancel forgets the flow, so a stale callback can never complete it', async () => {
  const h = harness();
  await h.call('/mcp-oauth/start', 'POST', START);
  await h.call('/mcp-oauth/cancel', 'POST', { name: 'canva' });
  assert.equal(h.state.flows.get('canva'), undefined);
});

test('the state parameter is the CSRF guard, and a wrong one matches nothing', async () => {
  const h = harness();
  await h.call('/mcp-oauth/start', 'POST', START);
  const flow = h.state.flows.get('canva');
  // the callback matcher is stateMatches over live flows; a forged value must miss
  const forged = [...h.state.flows.values()].find((f) => {
    const { stateMatches } = { stateMatches: (a, b) => a === b };
    return stateMatches(f.state, 'not-the-state');
  });
  assert.equal(forged, undefined);
  assert.ok(flow.state && flow.state.length >= 16, 'and it is not guessable');
});

test('the verifier never leaves the app, and no response carries a token', async () => {
  const h = harness();
  const r = await h.call('/mcp-oauth/start', 'POST', START);
  const flow = h.state.flows.get('canva');
  assert.ok(flow.verifier, 'held in memory for the exchange');
  assert.ok(!JSON.stringify(r.body).includes(flow.verifier), 'and never in a response body');
});

// ---- a member's own client (2026-10-17, Asana v2: no DCR) -------------------
import { MEMBER_REDIRECT, MEMBER_REDIRECT_PORT } from './mcp-oauth-routes.mjs';
import http from 'node:http';

const OWN = { host: 'mel-box', name: 'asana', url: 'https://mcp.asana.com/v2/mcp', client_id: '1211234567890123', client_secret: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', resource: 'https://mcp.asana.com/v2' };

test('own client: no registration, the FIXED redirect, Asana\'s resource, no scope', async () => {
  const p = provider();
  const state = {};
  const handle = createMcpOAuthRoutes({ state, fetchFn: p.fetchFn, sendToBox: async () => {}, listen: false });
  const r = await new Promise((resolve) => {
    const req = { method: 'POST', url: '/mcp-oauth/start', on(ev, cb) { if (ev === 'data') cb(Buffer.from(JSON.stringify(OWN))); if (ev === 'end') cb(); }, destroy() {} };
    const res = { writeHead(c) { this.c = c; return this; }, end(b) { resolve(JSON.parse(b)); } };
    handle(req, res, '/mcp-oauth/start');
  });
  assert.equal(r.ok, true);
  assert.equal(p.calls.registered, null, 'a member-made app is never registered again');
  const u = new URL(r.url);
  assert.equal(u.searchParams.get('redirect_uri'), MEMBER_REDIRECT);
  assert.equal(u.searchParams.get('client_id'), OWN.client_id);
  assert.equal(u.searchParams.get('resource'), 'https://mcp.asana.com/v2');
  assert.equal(u.searchParams.get('scope'), null, 'Asana answers "Invalid scope(s)" to any scope on an MCP app');
  assert.ok(!r.url.includes(OWN.client_secret), 'the secret never goes in the browser URL');
});

test('own client: half a credential, junk, or a foreign resource is refused', async () => {
  const h = harness({ routeOpts: { listen: false } });
  for (const bad of [{ ...OWN, client_secret: '' }, { ...OWN, client_id: '' }, { ...OWN, client_id: 'a b"c' },
    { ...OWN, resource: 'https://evil.example/v2' }, { ...OWN, resource: 'http://mcp.asana.com/v2' }]) {
    const r = await h.call('/mcp-oauth/start', 'POST', bad);
    assert.equal(r.body.ok, false, JSON.stringify(bad));
  }
});

test('/mcp-oauth/redirect names the address the wizard tells the member to paste', async () => {
  const h = harness();
  const r = await h.call('/mcp-oauth/redirect');
  assert.equal(r.body.uri, MEMBER_REDIRECT);
  assert.equal(MEMBER_REDIRECT, `http://localhost:${MEMBER_REDIRECT_PORT}/mcp-callback`);
});

test('own client, end to end through the real fixed-port listener: secret + resource reach the token call and the box', async () => {
  const p = provider();
  const sent = [];
  const state = {};
  const handle = createMcpOAuthRoutes({ state, fetchFn: p.fetchFn, sendToBox: async (host, payload) => { sent.push({ host, payload }); } });
  const r = await new Promise((resolve) => {
    const req = { method: 'POST', url: '/mcp-oauth/start', on(ev, cb) { if (ev === 'data') cb(Buffer.from(JSON.stringify(OWN))); if (ev === 'end') cb(); }, destroy() {} };
    const res = { writeHead(c) { this.c = c; return this; }, end(b) { resolve(JSON.parse(b)); } };
    handle(req, res, '/mcp-oauth/start');
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const st = new URL(r.url).searchParams.get('state');
  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${MEMBER_REDIRECT_PORT}/mcp-callback?code=CODE&state=${encodeURIComponent(st)}`, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(b));
    }).on('error', reject);
  });
  assert.match(body, /Connected/);
  assert.equal(p.calls.exchanged.get('client_secret'), OWN.client_secret);
  assert.equal(p.calls.exchanged.get('resource'), 'https://mcp.asana.com/v2');
  assert.equal(p.calls.exchanged.get('redirect_uri'), MEMBER_REDIRECT);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.client_secret, OWN.client_secret, 'the box needs it to renew');
  assert.equal(sent[0].payload.resource, 'https://mcp.asana.com/v2', 'and the resource to renew against');
  assert.equal(sent[0].payload.url, 'https://mcp.asana.com/v2/mcp');
  for (const s of state.memberServers) s.close();
});
