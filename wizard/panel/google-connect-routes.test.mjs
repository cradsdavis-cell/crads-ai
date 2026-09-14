// google-connect-routes: the app-side BYO-Google flow. Client-file parse ships
// the definition to the box and stashes the key in memory; start runs the
// member-client sign-in, honours the member's granular consent (probe follows
// the granted services), and delivers the full record to the box; the secret
// never appears in any response and is dropped from memory the moment a flow
// finishes. All collaborators injected: no network, no real browser, no box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGoogleConnectRoutes, GOOGLE_WORKSPACE_SCOPES, expiryFrom } from './google-connect-routes.mjs';

const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const INSTALLED = { installed: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-test-secret-value' } };

const listen = (route) => new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (!route(req, res, path)) { res.writeHead(404); res.end(); }
  });
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const post = (s, path, body, headers = { 'content-type': 'application/json' }) =>
  fetch(`http://127.0.0.1:${s.address().port}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
const get = (s, path) => fetch(`http://127.0.0.1:${s.address().port}${path}`);
const until = async (s, host, stop) => {
  let body;
  for (let i = 0; i < 80; i++) {
    body = await (await get(s, `/google-connect/status?host=${host}`)).json();
    if (stop.includes(body.stage)) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  return body;
};

// A happy-path stub set; override pieces per test. runVerb mirrors the panel's
// sendToBox stance: it throws on refusal and resolves with the parsed reply.
function stubs(over = {}) {
  const seen = { verbs: [], signIn: null, probes: [] };
  return {
    seen,
    opts: {
      runVerb: over.runVerb || (async (host, verb, args) => {
        seen.verbs.push({ host, verb, payload: JSON.parse(Buffer.from(args.payload_b64, 'base64').toString('utf8')) });
        // a 2026-08-24 box: keyed_at only, no re-key clock
        if (verb === 'mcp-token-set-google') return { ok: true, name: 'google', email: 'jane@example.com', keyed_at: 1000 };
        return { ok: true, key: 'google' };
      }),
      signIn: over.signIn || (async (args) => {
        seen.signIn = args;
        return { ok: true, tokens: { access_token: 'at-x', refresh_token: 'rt-x', expires_in: 3599,
          scope: 'openid https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify' } };
      }),
      fetcher: over.fetcher || (async (url, init) => { seen.probes.push({ url, init }); return { status: 200 }; }),
    },
  };
}

test('the scope union matches workspace-mcp auth/scopes.py byte-for-byte, deduped', () => {
  assert.equal(GOOGLE_WORKSPACE_SCOPES.length, 23);
  assert.equal(new Set(GOOGLE_WORKSPACE_SCOPES).size, 23, 'no duplicates');
  assert.ok(GOOGLE_WORKSPACE_SCOPES.includes('openid'));
  assert.ok(GOOGLE_WORKSPACE_SCOPES.includes('https://www.googleapis.com/auth/gmail.modify'));
  assert.ok(GOOGLE_WORKSPACE_SCOPES.includes('https://www.googleapis.com/auth/gmail.settings.basic'));
  assert.ok(GOOGLE_WORKSPACE_SCOPES.includes('https://www.googleapis.com/auth/contacts.readonly'));
  assert.ok(GOOGLE_WORKSPACE_SCOPES.every((s) => s === 'openid' || s.startsWith('https://www.googleapis.com/auth/')));
});

test('expiry lands tz-naive UTC with no fractional seconds, the shape workspace-mcp parses', () => {
  assert.equal(expiryFrom(3599, Date.parse('2026-08-17T00:00:00.500Z')), '2026-08-17T00:59:59');
  assert.match(expiryFrom(undefined), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});

test('happy path: client -> start -> done, with the box fed in the right order and the secret nowhere', async () => {
  const st = stubs();
  const s = await listen(createGoogleConnectRoutes({ opts: st.opts }));
  try {
    const r1 = await (await post(s, '/google-connect/client', { host: 'jane01-box', email: 'jane@example.com', client_json_b64: b64(INSTALLED) })).json();
    assert.equal(r1.ok, true);
    assert.equal(r1.client, '…nt.com', 'last 6 chars of the client id only');
    assert.ok(!JSON.stringify(r1).includes('GOCSPX'), 'the secret never rides a response');

    const r2 = await (await post(s, '/google-connect/start', { host: 'jane01-box' })).json();
    assert.equal(r2.ok, true);
    const body = await until(s, 'jane01-box', ['done', 'failed']);
    assert.equal(body.stage, 'done');
    assert.equal(body.email, 'jane@example.com');
    assert.equal(body.rekey_due_at, null, 'no re-key clock: the published key has no scheduled death');
    assert.ok(body.steps.some((l) => /unverified-app warning/.test(l)), 'the scary screen is pre-narrated');
    assert.ok(body.steps.some((l) => /proving the key against your calendar/.test(l)));
    assert.ok(body.steps.some((l) => /delivering the key to your box/.test(l)));
    assert.ok(!JSON.stringify(body).includes('GOCSPX'), 'the secret never rides a status payload');
    assert.ok(!JSON.stringify(body).includes('rt-x'), 'nor does the refresh token');

    // the box saw the definition first, then the full record
    assert.deepEqual(st.seen.verbs.map((v) => v.verb), ['mcp-add-google', 'mcp-token-set-google']);
    assert.deepEqual(st.seen.verbs[0].payload, { email: 'jane@example.com', key: 'google' }, 'no key named = the primary row, so an older page keeps working');
    const rec = st.seen.verbs[1].payload;
    assert.equal(rec.client_id, INSTALLED.installed.client_id);
    assert.equal(rec.client_secret, INSTALLED.installed.client_secret);
    assert.equal(rec.access_token, 'at-x');
    assert.equal(rec.refresh_token, 'rt-x');
    assert.deepEqual(rec.scopes,
      ['openid', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/gmail.modify'],
      'the GRANTED scopes, split on spaces — what the member ticked, not what was asked');
    assert.match(rec.expiry, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

    // the sign-in ran with the member's client + the full union + their email
    assert.equal(st.seen.signIn.clientId, INSTALLED.installed.client_id);
    assert.equal(st.seen.signIn.loginHint, 'jane@example.com');
    assert.deepEqual(st.seen.signIn.scopes, GOOGLE_WORKSPACE_SCOPES);

    // the probe carried the access token
    assert.match(st.seen.probes[0].url, /calendar\/v3\/users\/me\/calendarList\?maxResults=1$/);
    assert.equal(st.seen.probes[0].init.headers.authorization, 'Bearer at-x');
  } finally { s.close(); }
});

test('a Web application client is named as the wrong kind, and nothing reaches the box', async () => {
  const st = stubs();
  const s = await listen(createGoogleConnectRoutes({ opts: st.opts }));
  try {
    const r = await (await post(s, '/google-connect/client', {
      host: 'jane01-box', email: 'jane@example.com',
      client_json_b64: b64({ web: { client_id: 'x.apps.googleusercontent.com', client_secret: 's' } }),
    })).json();
    assert.equal(r.ok, false);
    assert.match(r.reason, /Web application client/);
    assert.match(r.reason, /Desktop app/);
    assert.equal(st.seen.verbs.length, 0, 'no verb ran');
  } finally { s.close(); }
});

test('unreadable file, non-Google client id, missing secret, bad email: each refused in words', async () => {
  const st = stubs();
  const s = await listen(createGoogleConnectRoutes({ opts: st.opts }));
  try {
    const cases = [
      [{ host: 'h-box', email: 'jane@example.com', client_json_b64: 'not-base64-json!!' }, /not the JSON Google gave you/],
      [{ host: 'h-box', email: 'jane@example.com', client_json_b64: b64({ installed: { client_id: 'evil.example.com', client_secret: 's' } }) }, /no Google OAuth client/],
      [{ host: 'h-box', email: 'jane@example.com', client_json_b64: b64({ installed: { client_id: 'a.apps.googleusercontent.com' } }) }, /missing its client secret/],
      [{ host: 'h-box', email: 'nope', client_json_b64: b64(INSTALLED) }, /does not look like an email/],
    ];
    for (const [body, re] of cases) {
      const r = await (await post(s, '/google-connect/client', body)).json();
      assert.equal(r.ok, false, JSON.stringify(body).slice(0, 60));
      assert.match(r.reason, re);
    }
    assert.equal(st.seen.verbs.length, 0);
  } finally { s.close(); }
});

test('start without a dropped key file is refused', async () => {
  const st = stubs();
  const s = await listen(createGoogleConnectRoutes({ opts: st.opts }));
  try {
    const r = await (await post(s, '/google-connect/start', { host: 'jane01-box' })).json();
    assert.equal(r.ok, false);
    assert.match(r.reason, /drop your key file first/);
  } finally { s.close(); }
});

test('a sign-in without a refresh token fails in plain words, and nothing ships to the box', async () => {
  const st = stubs({ signIn: async () => ({ ok: true, tokens: { access_token: 'at-x', expires_in: 3599, scope: 's' } }) });
  const s = await listen(createGoogleConnectRoutes({ opts: st.opts }));
  try {
    await post(s, '/google-connect/client', { host: 'h-box', email: 'jane@example.com', client_json_b64: b64(INSTALLED) });
    await post(s, '/google-connect/start', { host: 'h-box' });
    const body = await until(s, 'h-box', ['done', 'failed']);
    assert.equal(body.stage, 'failed');
    assert.match(body.reason, /did not include a refresh token/);
    assert.match(body.reason, /approve every screen/);
    assert.deepEqual(st.seen.verbs.map((v) => v.verb), ['mcp-add-google'], 'the token verb never ran');
  } finally { s.close(); }
});

test('a probe refusal fails with the HTTP status in the reason', async () => {
  const st = stubs({ fetcher: async () => ({ status: 403 }) });
  const s = await listen(createGoogleConnectRoutes({ opts: st.opts }));
  try {
    await post(s, '/google-connect/client', { host: 'h-box', email: 'jane@example.com', client_json_b64: b64(INSTALLED) });
    await post(s, '/google-connect/start', { host: 'h-box' });
    const body = await until(s, 'h-box', ['done', 'failed']);
    assert.equal(body.stage, 'failed');
    assert.match(body.reason, /HTTP 403/);
    assert.deepEqual(st.seen.verbs.map((v) => v.verb), ['mcp-add-google'], 'a key that fails the probe never ships');
  } finally { s.close(); }
});

test('granular consent: a gmail-only grant probes the mailbox, not the calendar', async () => {
  const st = stubs({ signIn: async () => ({ ok: true, tokens: { access_token: 'at-x', refresh_token: 'rt-x', expires_in: 3599,
    scope: 'openid https://www.googleapis.com/auth/gmail.modify' } }) });
  const s = await listen(createGoogleConnectRoutes({ opts: st.opts }));
  try {
    await post(s, '/google-connect/client', { host: 'h-box', email: 'jane@example.com', client_json_b64: b64(INSTALLED) });
    await post(s, '/google-connect/start', { host: 'h-box' });
    const body = await until(s, 'h-box', ['done', 'failed']);
    assert.equal(body.stage, 'done');
    assert.match(st.seen.probes[0].url, /gmail\/v1\/users\/me\/profile$/, 'the probe followed the grant');
    assert.ok(body.steps.some((l) => /proving the key against your mailbox/.test(l)));
    const rec = st.seen.verbs.find((v) => v.verb === 'mcp-token-set-google').payload;
    assert.deepEqual(rec.scopes, ['openid', 'https://www.googleapis.com/auth/gmail.modify'],
      'the unticked services never reach the credential file');
  } finally { s.close(); }
});

test('granular consent: a docs-only grant ships unprobed rather than failing a fine key', async () => {
  const st = stubs({ signIn: async () => ({ ok: true, tokens: { access_token: 'at-x', refresh_token: 'rt-x', expires_in: 3599,
    scope: 'openid https://www.googleapis.com/auth/documents' } }) });
  const s = await listen(createGoogleConnectRoutes({ opts: st.opts }));
  try {
    await post(s, '/google-connect/client', { host: 'h-box', email: 'jane@example.com', client_json_b64: b64(INSTALLED) });
    await post(s, '/google-connect/start', { host: 'h-box' });
    const body = await until(s, 'h-box', ['done', 'failed']);
    assert.equal(body.stage, 'done');
    assert.equal(st.seen.probes.length, 0, 'no probe ran');
    assert.ok(body.steps.some((l) => /no safe test call/.test(l)), 'and the skip is narrated, not hidden');
  } finally { s.close(); }
});

test('granular consent: unticking every service is named as the fix, and nothing ships', async () => {
  const st = stubs({ signIn: async () => ({ ok: true, tokens: { access_token: 'at-x', refresh_token: 'rt-x', expires_in: 3599,
    scope: 'openid https://www.googleapis.com/auth/userinfo.email' } }) });
  const s = await listen(createGoogleConnectRoutes({ opts: st.opts }));
  try {
    await post(s, '/google-connect/client', { host: 'h-box', email: 'jane@example.com', client_json_b64: b64(INSTALLED) });
    await post(s, '/google-connect/start', { host: 'h-box' });
    const body = await until(s, 'h-box', ['done', 'failed']);
    assert.equal(body.stage, 'failed');
    assert.match(body.reason, /tick at least one/);
    assert.deepEqual(st.seen.verbs.map((v) => v.verb), ['mcp-add-google'], 'the token verb never ran');
  } finally { s.close(); }
});

test('a box refusal on delivery fails the flow with the box\'s words', async () => {
  const st = stubs();
  const inner = st.opts.runVerb;
  st.opts.runVerb = async (host, verb, args) => {
    if (verb === 'mcp-token-set-google') throw new Error('the mineral did not store it: {"ok":false,"error":"box-too-old"}');
    return inner(host, verb, args);
  };
  const s = await listen(createGoogleConnectRoutes({ opts: st.opts }));
  try {
    await post(s, '/google-connect/client', { host: 'h-box', email: 'jane@example.com', client_json_b64: b64(INSTALLED) });
    await post(s, '/google-connect/start', { host: 'h-box' });
    const body = await until(s, 'h-box', ['done', 'failed']);
    assert.equal(body.stage, 'failed');
    assert.match(body.reason, /box-too-old/);
  } finally { s.close(); }
});

test('cancel supersedes an in-flight flow: the abandoned run never writes its result', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const st = stubs({ signIn: async () => { await gate; return { ok: true, tokens: { access_token: 'a', refresh_token: 'r', expires_in: 1, scope: 's' } }; } });
  const s = await listen(createGoogleConnectRoutes({ opts: st.opts }));
  try {
    await post(s, '/google-connect/client', { host: 'h-box', email: 'jane@example.com', client_json_b64: b64(INSTALLED) });
    await post(s, '/google-connect/start', { host: 'h-box' });
    let body = await (await get(s, '/google-connect/status?host=h-box')).json();
    assert.equal(body.stage, 'waiting');
    await post(s, '/google-connect/cancel', { host: 'h-box' });
    release();
    await new Promise((r) => setTimeout(r, 50));
    body = await (await get(s, '/google-connect/status?host=h-box')).json();
    assert.equal(body.stage, 'idle', 'the cancelled flow stood down instead of finishing');
    assert.deepEqual(st.seen.verbs.map((v) => v.verb), ['mcp-add-google'], 'no delivery after cancel');
  } finally { s.close(); }
});

test('a second start supersedes the first: only the newest flow owns the state', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const st = stubs({
    signIn: async () => {
      calls += 1;
      if (calls === 1) { await gate; return { ok: true, tokens: { access_token: 'stale', refresh_token: 'stale', expires_in: 1, scope: 's' } }; }
      return { ok: true, tokens: { access_token: 'fresh', refresh_token: 'fresh-rt', expires_in: 1, scope: 'sc' } };
    },
  });
  const s = await listen(createGoogleConnectRoutes({ opts: st.opts }));
  try {
    await post(s, '/google-connect/client', { host: 'h-box', email: 'jane@example.com', client_json_b64: b64(INSTALLED) });
    await post(s, '/google-connect/start', { host: 'h-box' });
    await post(s, '/google-connect/start', { host: 'h-box' });
    const body = await until(s, 'h-box', ['done', 'failed']);
    release();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(body.stage, 'done');
    const delivered = st.seen.verbs.filter((v) => v.verb === 'mcp-token-set-google');
    assert.equal(delivered.length, 1, 'the stale flow never delivered');
    assert.equal(delivered[0].payload.access_token, 'fresh');
  } finally { s.close(); }
});

test('the stashed secret is dropped from memory once a flow finishes, either way', async () => {
  const state = {};
  const st = stubs();
  const s = await listen(createGoogleConnectRoutes({ state, opts: st.opts }));
  try {
    await post(s, '/google-connect/client', { host: 'h-box', email: 'jane@example.com', client_json_b64: b64(INSTALLED) });
    assert.ok(state.clients.get('h-box|google'), 'stashed after the drop, per host and account');
    await post(s, '/google-connect/start', { host: 'h-box' });
    await until(s, 'h-box', ['done', 'failed']);
    assert.equal(state.clients.get('h-box|google'), undefined, 'gone on done: the box holds the only copy');
  } finally { s.close(); }
});

test('POST routes refuse a non-JSON content-type (no-preflight CSRF guard)', async () => {
  const st = stubs();
  const s = await listen(createGoogleConnectRoutes({ opts: st.opts }));
  try {
    for (const path of ['/google-connect/client', '/google-connect/start', '/google-connect/cancel']) {
      const r = await fetch(`http://127.0.0.1:${s.address().port}${path}`, {
        method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"host":"h-box"}' });
      assert.equal(r.status, 415, path);
    }
    assert.equal(st.seen.verbs.length, 0);
  } finally { s.close(); }
});

test('status with nothing in flight reports idle', async () => {
  const s = await listen(createGoogleConnectRoutes({ opts: stubs().opts }));
  try {
    const j = await (await get(s, '/google-connect/status?host=nobody-box')).json();
    assert.deepEqual(j, { ok: true, key: 'google', stage: 'idle', steps: [], reason: null, email: null, rekey_due_at: null });
  } finally { s.close(); }
});

// ---- several Google accounts (2026-09-14, Sam's ruling) --------------------
// Every account is its own row and its own key; the routes carry `key` on
// every request and keep one stash + one flow per host AND account, so a
// second account can be signed in while the first one's card sits done.

test('a second account (key google-work) rides its own verbs, stash and status', async () => {
  const state = {};
  const st = stubs({
    runVerb: async (host, verb, args) => {
      const payload = JSON.parse(Buffer.from(args.payload_b64, 'base64').toString('utf8'));
      st.seen.verbs.push({ host, verb, payload });
      if (verb === 'mcp-token-set-google') return { ok: true, name: payload.key, email: payload.email, keyed_at: 1000 };
      return { ok: true, key: payload.key };
    },
  });
  const s = await listen(createGoogleConnectRoutes({ state, opts: st.opts }));
  try {
    const r1 = await (await post(s, '/google-connect/client', { host: 'jane01-box', key: 'google-work', email: 'jane@acme.example', client_json_b64: b64(INSTALLED) })).json();
    assert.equal(r1.ok, true);
    assert.equal(r1.key, 'google-work', 'the reply names the row the key landed on');
    assert.ok(state.clients.get('jane01-box|google-work'));
    assert.equal(state.clients.get('jane01-box|google'), undefined, 'the primary stash is untouched');
    // the primary's status is idle while the work account is mid-flow
    const r2 = await (await post(s, '/google-connect/start', { host: 'jane01-box', key: 'google-work' })).json();
    assert.equal(r2.ok, true);
    assert.equal(r2.key, 'google-work');
    const primary = await (await get(s, '/google-connect/status?host=jane01-box')).json();
    assert.equal(primary.stage, 'idle', 'a flow on one account is invisible on another');
    let body;
    for (let i = 0; i < 80; i++) {
      body = await (await get(s, '/google-connect/status?host=jane01-box&key=google-work')).json();
      if (['done', 'failed'].includes(body.stage)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(body.stage, 'done');
    assert.equal(body.key, 'google-work');
    assert.equal(body.email, 'jane@acme.example');
    // both box verbs carried the key: the definition and the credential record
    assert.deepEqual(st.seen.verbs.map((v) => [v.verb, v.payload.key]), [['mcp-add-google', 'google-work'], ['mcp-token-set-google', 'google-work']]);
    assert.equal(st.seen.verbs[0].payload.email, 'jane@acme.example');
    assert.equal(state.clients.get('jane01-box|google-work'), undefined, 'the work stash is dropped on done');
  } finally { s.close(); }
});

test('a malformed account key is refused in words, before anything reaches the box', async () => {
  const st = stubs();
  const s = await listen(createGoogleConnectRoutes({ opts: st.opts }));
  try {
    for (const key of ['Work Account', 'google-', 'google-' + 'x'.repeat(21), 'notion', '../google']) {
      const r = await (await post(s, '/google-connect/client', { host: 'h-box', key, email: 'jane@example.com', client_json_b64: b64(INSTALLED) })).json();
      assert.equal(r.ok, false, key);
      assert.match(r.reason, /account name/i, key);
    }
    const r = await (await post(s, '/google-connect/start', { host: 'h-box', key: 'Work Account' })).json();
    assert.equal(r.ok, false);
    assert.equal(st.seen.verbs.length, 0, 'no verb ran');
  } finally { s.close(); }
});

test('cancel is per account: cancelling the work flow leaves the primary flow running', async () => {
  const state = {};
  let release;
  const gate = new Promise((r) => { release = r; });
  const st = stubs({ signIn: async (args) => { await gate; return { ok: true, tokens: { access_token: 'at', refresh_token: 'rt', expires_in: 10, scope: 'openid https://www.googleapis.com/auth/calendar' } }; } });
  const s = await listen(createGoogleConnectRoutes({ state, opts: st.opts }));
  try {
    for (const key of ['google', 'google-work']) {
      await post(s, '/google-connect/client', { host: 'h-box', key, email: `${key}@example.com`, client_json_b64: b64(INSTALLED) });
      await post(s, '/google-connect/start', { host: 'h-box', key });
    }
    await post(s, '/google-connect/cancel', { host: 'h-box', key: 'google-work' });
    assert.equal(state.flows.get('h-box|google-work'), undefined, 'the work flow is gone');
    assert.ok(state.flows.get('h-box|google'), 'the primary flow is still in flight');
    assert.ok(state.clients.get('h-box|google-work'), 'the work stash survives a cancel, so Sign in again needs no new file');
    release();
    const body = await until(s, 'h-box', ['done', 'failed']);
    assert.equal(body.stage, 'done', 'the primary finishes untouched by the other account\'s cancel');
  } finally { s.close(); }
});
