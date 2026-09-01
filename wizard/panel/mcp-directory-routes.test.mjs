// wizard/panel/mcp-directory-routes.test.mjs: run node --test wizard/panel/mcp-directory-routes.test.mjs
//
// The routes behind the directory. fetchFn is injected, so the registry and the
// probed servers are both played by fixtures: no live network in CI, and the
// degrade paths (spec § Failure honesty) are testable deterministically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createMcpDirectoryRoutes } from './mcp-directory-routes.mjs';
import { CATALOGUE } from './mcp-catalogue.mjs';

// serve the handler on a real port so req/res are the genuine articles
async function serve(fetchFn, opts = {}) {
  const handle = createMcpDirectoryRoutes({ fetchFn, ...opts });
  const srv = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    handle(req, res, path).then((hit) => { if (!hit) { res.writeHead(404); res.end(); } })
      .catch(() => { try { res.writeHead(500); res.end(); } catch { /* answered */ } });
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, close: () => srv.close() };
}

const REG_PAYLOAD = { servers: [
  { server: { name: 'io.example/crm', title: 'Example CRM', description: 'customers', remotes: [{ type: 'streamable-http', url: 'https://mcp.example-crm.com/mcp' }] },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } } },
  { server: { name: 'io.example/old', title: 'Old Version', description: 'stale', remotes: [{ type: 'streamable-http', url: 'https://old.example.com/mcp' }] },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: false } } },
  { server: { name: 'io.example/local', title: 'Local Only', description: 'stdio only', remotes: [] },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } } },
], metadata: {} };

test('catalogue route serves the baked tier', async () => {
  const { base, close } = await serve(async () => { throw new Error('no network expected'); });
  try {
    const d = await (await fetch(`${base}/mcp-dir/catalogue`)).json();
    assert.equal(d.ok, true);
    assert.equal(d.entries.length, CATALOGUE.length);
    assert.ok(Array.isArray(d.categories));
  } finally { close(); }
});

test('search maps registry rows, dropping non-latest and remoteless', async () => {
  const { base, close } = await serve(async (u) => {
    assert.match(String(u), /registry\.modelcontextprotocol\.io\/v0\/servers/);
    assert.match(String(u), /search=crm/);
    return { ok: true, json: async () => REG_PAYLOAD };
  });
  try {
    const d = await (await fetch(`${base}/mcp-dir/search?q=crm`)).json();
    assert.equal(d.registry_ok, true);
    assert.equal(d.hits.length, 1, 'only the latest+active row with a remote');
    assert.deepEqual(d.hits[0], { name: 'io.example/crm', title: 'Example CRM', desc: 'customers', url: 'https://mcp.example-crm.com/mcp' });
  } finally { close(); }
});

test('registry down degrades honestly, never errors the page', async () => {
  const { base, close } = await serve(async () => { throw new Error('ECONNREFUSED'); });
  try {
    const d = await (await fetch(`${base}/mcp-dir/search?q=x`)).json();
    assert.equal(d.ok, true, 'degrade is a result, not an error');
    assert.equal(d.registry_ok, false);
    assert.deepEqual(d.hits, []);
  } finally { close(); }
});

// The registry is a third party writing into our page. The ROUTE is data: it
// must pass hostile text through unmangled (mangling here would be a silent
// content edit, and the page is where escaping belongs, see mcpDirCard). What
// the route must NOT pass through is a url it could not parse, or one carrying
// a quote, because that value is both an HTML attribute and a probe target.
const HOSTILE = { servers: [
  { server: {
    name: 'io.evil/xss',
    title: '<img src=x onerror="alert(1)">',
    description: 'a "quoted" <script>alert(1)</script> blurb',
    remotes: [{ type: 'streamable-http', url: 'https://mcp.evil.example/mcp' }],
  }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } } },
  { server: {
    name: 'io.evil/badurl',
    title: 'Bad URL',
    description: 'its endpoint breaks out of the attribute',
    remotes: [{ type: 'streamable-http', url: 'https://ok.example/mcp" onmouseover="alert(1)' }],
  }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } } },
  { server: {
    name: 'io.evil/javascript',
    title: 'Scheme Smuggler',
    description: 'not https at all',
    remotes: [{ type: 'streamable-http', url: 'javascript:alert(1)' }],
  }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } } },
] };

test('a hostile registry row survives as data, and an unusable url is dropped', async () => {
  const { base, close } = await serve(async () => ({ ok: true, json: async () => HOSTILE }));
  try {
    const d = await (await fetch(`${base}/mcp-dir/search?q=evil`)).json();
    assert.equal(d.registry_ok, true);
    assert.equal(d.hits.length, 1, 'the quote-carrying url and the javascript: url are both refused');
    assert.deepEqual(d.hits[0], {
      name: 'io.evil/xss',
      title: '<img src=x onerror="alert(1)">',
      desc: 'a "quoted" <script>alert(1)</script> blurb',
      url: 'https://mcp.evil.example/mcp',
    }, 'the route is data: it round-trips the payload intact and does not escape or strip it');
    assert.ok(!d.hits.some((h) => /["'<>]/.test(h.url)), 'no emitted url can carry an attribute breakout');
  } finally { close(); }
});

async function probeWith(fetchFn, url, opts) {
  const { base, close } = await serve(fetchFn, opts);
  try {
    return await (await fetch(`${base}/mcp-dir/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) })).json();
  } finally { close(); }
}

// discover() walks: origin/.well-known/oauth-protected-resource (optional), then
// /.well-known/oauth-authorization-server. Play the metadata server directly.
const META = (extra) => async (u) => {
  if (/oauth-protected-resource/.test(String(u))) return { ok: false };
  return { ok: true, json: async () => ({ authorization_endpoint: 'https://a/auth', token_endpoint: 'https://a/token', ...extra }) };
};

test('probe: DCR advertised means a real sign-in', async () => {
  const d = await probeWith(META({ registration_endpoint: 'https://a/register' }), 'https://mcp.example.com/mcp');
  assert.deepEqual(d, { ok: true, can_signin: true });
});

test('probe: metadata without DCR means token-only', async () => {
  const d = await probeWith(META({}), 'https://mcp.example.com/mcp');
  assert.deepEqual(d, { ok: true, can_signin: false, reason: 'no-dcr' });
});

test('probe: silence means we say we could not check', async () => {
  const d = await probeWith(async () => { throw new Error('timeout'); }, 'https://mcp.example.com/mcp');
  assert.deepEqual(d, { ok: true, can_signin: null, reason: 'no-answer' });
});

// The per-fetch cap is not the member's wait: discover() makes up to three
// fetches in sequence, so a server that hangs every leg used to cost three caps
// with a spinner on screen throughout. The deadline is across the WHOLE probe.
test('probe: a server that hangs every leg still answers inside the deadline', async () => {
  // unref'd: the point is that the ROUTE gives up, so the fixture's own timer
  // must not be what holds the test process open afterwards
  const hang = () => new Promise((_, reject) => { setTimeout(() => reject(new Error('never')), 60000).unref(); });
  const t0 = Date.now();
  const d = await probeWith(hang, 'https://mcp.hangs.example/mcp', { probeDeadlineMs: 300 });
  const ms = Date.now() - t0;
  assert.deepEqual(d, { ok: true, can_signin: null, reason: 'no-answer' });
  assert.ok(ms < 3000, `the probe must give up on its own deadline, took ${ms}ms`);
});

test('probe: junk and non-https urls are refused', async () => {
  for (const u of ['not a url', 'http://insecure.example.com/mcp']) {
    const d = await probeWith(async () => { throw new Error('unreachable'); }, u);
    assert.equal(d.ok, false);
    assert.equal(d.error, 'bad server url');
  }
});
