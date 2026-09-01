// mcp-refresh.test.mjs — run: node --test engine/comms/mcp-refresh.test.mjs
//
// The promise of doing OAuth ourselves is that a member signs in ONCE. This job
// is the only thing keeping that true, so the cases that matter are the ones
// where it must NOT act: an unknown expiry is not an expiry, and a token with no
// refresh is a fact to report, not a failure to retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// execFile, NOT execFileSync: the fake provider below lives in THIS process, so
// a sync spawn blocks the event loop and the server can never answer the pebble.
// Same self-deadlock I hit in the telegram tests earlier today.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const SCRIPT = path.join(import.meta.dirname, 'mcp-refresh.mjs');

function fakeProvider(state) {
  const srv = createServer((req, res) => {
    state.hits = (state.hits || 0) + 1;
    res.setHeader('content-type', 'application/json');
    if (state.fail) { res.statusCode = 401; return res.end('{}'); }
    res.end(JSON.stringify({ access_token: 'AT-' + state.hits, expires_in: 3600 }));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({
    srv, url: `http://127.0.0.1:${srv.address().port}/token`,
    stop: () => { srv.closeAllConnections(); srv.close(); },
  })));
}

function box(entries) {
  const d = tmpDir('mcpref-');
  mkdirSync(path.join(d, '.kernel'), { recursive: true });
  writeFileSync(path.join(d, '.kernel', 'mcp-oauth.json'), JSON.stringify(entries));
  writeFileSync(path.join(d, '.mcp.json'), JSON.stringify({ mcpServers: Object.fromEntries(
    Object.keys(entries).map((n) => [n, { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer OLD' } }]),
  ) }));
  return d;
}
const run = (d) => new Promise((resolve) => {
  execFile('node', [SCRIPT, d], { encoding: 'utf8' }, (_err, stdout) => resolve(JSON.parse(String(stdout).trim())));
});
const hdr = (d, n) => JSON.parse(readFileSync(path.join(d, '.mcp.json'), 'utf8')).mcpServers[n].headers.Authorization;

const due = (tok) => ({ url: 'https://mcp.example.com/mcp', token_endpoint: tok, client_id: 'cid', refresh_token: 'RT', expires_at: Date.now() + 60_000 });

test('a token inside the window is refreshed and the header is rewritten', async () => {
  const st = {}; const p = await fakeProvider(st);
  try {
    const d = box({ canva: due(p.url) });
    const r = await run(d);
    assert.deepEqual(r.refreshed, ['canva']);
    assert.equal(hdr(d, 'canva'), 'Bearer AT-1', 'the live header must move with the token');
    const store = JSON.parse(readFileSync(path.join(d, '.kernel', 'mcp-oauth.json'), 'utf8'));
    assert.equal(store.canva.refresh_token, 'RT', 'a response without a new refresh token keeps the old one');
    assert.ok(store.canva.expires_at > Date.now() + 3000_000, 'expiry moved forward');
  } finally { p.stop(); }
});

test('a token that is NOT due is left alone', async () => {
  const st = {}; const p = await fakeProvider(st);
  try {
    const d = box({ canva: { ...due(p.url), expires_at: Date.now() + 6 * 3600e3 } });
    const r = await run(d);
    assert.deepEqual(r.refreshed, []);
    assert.equal(st.hits ?? 0, 0, 'the provider must not be called at all');
    assert.equal(hdr(d, 'canva'), 'Bearer OLD');
  } finally { p.stop(); }
});

test('an UNKNOWN expiry is not an expiry, and no-refresh is reported not retried', async () => {
  // guessing here would churn tokens on connections that are working fine
  const st = {}; const p = await fakeProvider(st);
  try {
    const d = box({
      nodate: { ...due(p.url), expires_at: null },
      norefresh: { ...due(p.url), refresh_token: null },
    });
    const r = await run(d);
    assert.deepEqual(r.refreshed, []);
    assert.equal(st.hits ?? 0, 0);
    assert.equal(r.skipped.length, 2);
    assert.match(r.skipped.join(' '), /no expiry given/);
    assert.match(r.skipped.join(' '), /no refresh token/);
  } finally { p.stop(); }
});

test('a refused refresh is reported, and the working header is NOT destroyed', async () => {
  const st = { fail: true }; const p = await fakeProvider(st);
  try {
    const d = box({ canva: due(p.url) });
    const r = await run(d);   // exits 1 on failure; the JSON is still on stdout
    assert.deepEqual(r.refreshed, []);
    assert.match(r.failed.join(' '), /refresh refused \(401\)/);
    assert.equal(hdr(d, 'canva'), 'Bearer OLD',
      'the old token may still have life in it; a failed refresh must not disconnect the member');
  } finally { p.stop(); }
});

test('one bad service does not stop the others', async () => {
  const good = {}; const p = await fakeProvider(good);
  try {
    const d = box({ canva: due(p.url), broken: { ...due('http://127.0.0.1:1/token') } });
    const r = await run(d);
    assert.deepEqual(r.refreshed, ['canva']);
    assert.equal(r.failed.length, 1);
  } finally { p.stop(); }
});
