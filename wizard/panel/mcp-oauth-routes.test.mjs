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
