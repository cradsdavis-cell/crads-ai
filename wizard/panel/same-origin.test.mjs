// same-origin.test.mjs — the one gate that stops a web page driving this app.
//   node --test wizard/panel/same-origin.test.mjs
//
// 2026-08-20 audit. The panel, door and member-connect servers bind loopback
// with no auth and no CSRF token. A page the operator merely visits could POST
// to them on a guessed ephemeral port and never need to read the reply:
// /term/open then /term/input is blind command execution in the org container
// (ids are the sequential t1, t2, ...), and /pebble-build-request provisions and
// bills a real box from a name and an email. The old defence was a per-route
// json content-type check that existed on four routes out of dozens.
import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossOriginBlocked } from './same-origin.mjs';
import { createDoorServer } from './door-server.mjs';

const req = (method, headers = {}) => ({ method, headers });

test('safe methods are never blocked: a cross-origin GET can read nothing anyway', () => {
  for (const m of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(crossOriginBlocked(req(m, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })), false);
  }
});

test('a browser that says another site drove this is refused', () => {
  assert.equal(crossOriginBlocked(req('POST', { 'sec-fetch-site': 'cross-site' })), true);
  assert.equal(crossOriginBlocked(req('POST', { 'sec-fetch-site': 'same-site' })), true,
    'same-site is still not us: another port or scheme on the same registrable domain');
});

test('our own page and a typed navigation are allowed', () => {
  assert.equal(crossOriginBlocked(req('POST', { 'sec-fetch-site': 'same-origin' })), false);
  assert.equal(crossOriginBlocked(req('POST', { 'sec-fetch-site': 'none' })), false);
});

test('a foreign Origin is refused even when Sec-Fetch-Site is absent (older Safari)', () => {
  assert.equal(crossOriginBlocked(req('POST', { origin: 'https://evil.example', host: '127.0.0.1:7777' })), true);
  assert.equal(crossOriginBlocked(req('POST', { origin: 'null', host: '127.0.0.1:7777' })), true,
    'a sandboxed iframe or data: document sends null');
  assert.equal(crossOriginBlocked(req('POST', { origin: 'not a url', host: '127.0.0.1:7777' })), true);
});

test('the app addressing itself by either loopback spelling is allowed', () => {
  for (const o of ['http://127.0.0.1:7777', 'http://localhost:7777']) {
    assert.equal(crossOriginBlocked(req('POST', { origin: o, host: '127.0.0.1:7777' })), false, o);
  }
  assert.equal(crossOriginBlocked(req('POST', { origin: 'http://127.0.0.1:7778', host: '127.0.0.1:7777' })), true,
    'a different port is a different app');
});

test('a non-browser caller passes untouched: the gate refuses evidence, it does not demand it', () => {
  assert.equal(crossOriginBlocked(req('POST', {})), false, 'curl, the app node process and the ssh relays send neither header');
});

test('the gate is live on a real server, and does not disturb ordinary use', async () => {
  const s = await new Promise((resolve) => {
    const srv = createDoorServer({
      port: 0, host: '127.0.0.1', htmlText: '<html>door</html>',
      bridge: { targets: () => [{ host: 'acme-rock', org: 'acme', kind: 'rock' }] },
      probe: () => Promise.resolve({ code: 0, stdout: 'login=aios-op\n', stderr: '' }),
    });
    srv.on('listening', () => resolve(srv));
  });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const body = JSON.stringify({ host: 'acme-rock' });
    const hostile = await fetch(`${base}/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
      body,
    });
    assert.equal(hostile.status, 403, 'a page on another site cannot drive the door');

    const ours = await fetch(`${base}/probe`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body,
    });
    assert.equal(ours.status, 200, 'our own page still works');

    const cli = await fetch(`${base}/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(cli.status, 200, 'a headerless programmatic caller still works');

    assert.equal((await fetch(`${base}/`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 200,
      'reading the page cross-origin is not the threat and is not blocked');
  } finally { s.close(); }
});
