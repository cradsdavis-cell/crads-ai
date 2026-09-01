// P3.1: GitHub device-flow sign-in — the member authorises from any browser by
// typing a short code; the app never sees their password and needs no client secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDeviceFlow } from './github-device-flow.mjs';

const CODE_RESP = { device_code: 'dev123', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 };

function fetcherScript(pollResponses) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)) });
    if (url.includes('/login/device/code')) return { ok: true, json: async () => CODE_RESP };
    const next = pollResponses.shift();
    return { ok: true, json: async () => next };
  };
  f.calls = calls;
  return f;
}

test('happy path: code surfaces, poll returns the token', async () => {
  const fetcher = fetcherScript([{ error: 'authorization_pending' }, { access_token: 'gho_tok', token_type: 'bearer' }]);
  const flow = await startDeviceFlow({ clientId: 'cid1', fetcher, sleeper: async () => {} });
  assert.equal(flow.userCode, 'ABCD-1234');
  assert.equal(flow.verificationUri, 'https://github.com/login/device');
  const r = await flow.poll();
  assert.equal(r.ok, true);
  assert.equal(r.token, 'gho_tok');
  assert.equal(fetcher.calls[0].body.client_id, 'cid1');
  assert.equal(fetcher.calls[0].body.scope, 'repo');
  assert.equal(fetcher.calls[2].body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(fetcher.calls[2].body.device_code, 'dev123');
});

test('slow_down increases the wait, then still succeeds', async () => {
  const waits = [];
  const fetcher = fetcherScript([{ error: 'slow_down', interval: 7 }, { access_token: 'gho_tok2' }]);
  const flow = await startDeviceFlow({ clientId: 'cid', fetcher, sleeper: async (s) => waits.push(s) });
  const r = await flow.poll();
  assert.equal(r.ok, true);
  assert.ok(waits.some((w) => w >= 7), `a wait of >=7s happened (${waits})`);
});

test('denial and expiry are clean terminal refusals', async () => {
  for (const [err, re] of [['access_denied', /denied|cancelled/i], ['expired_token', /expired/i]]) {
    const fetcher = fetcherScript([{ error: err }]);
    const flow = await startDeviceFlow({ clientId: 'cid', fetcher, sleeper: async () => {} });
    const r = await flow.poll();
    assert.equal(r.ok, false);
    assert.match(r.reason, re);
  }
});

test('missing client id refuses before any network call', async () => {
  const fetcher = fetcherScript([]);
  await assert.rejects(() => startDeviceFlow({ clientId: '', fetcher }), /client id/i);
  assert.equal(fetcher.calls.length, 0);
});

test('garbage responses never throw out of poll', async () => {
  const fetcher = async (url) => (url.includes('/device/code')
    ? { ok: true, json: async () => CODE_RESP }
    : { ok: false, status: 500, json: async () => { throw new Error('not json'); } });
  const flow = await startDeviceFlow({ clientId: 'cid', fetcher, sleeper: async () => {}, maxPolls: 3 });
  const r = await flow.poll();
  assert.equal(r.ok, false);
});

test('unknown terminal errors abort immediately, never burn the poll budget', async () => {
  let polls = 0;
  const fetcher = async (url) => {
    if (url.includes('/device/code')) return { ok: true, json: async () => CODE_RESP };
    polls++; return { ok: true, json: async () => ({ error: 'device_flow_disabled' }) };
  };
  const flow = await startDeviceFlow({ clientId: 'cid', fetcher, sleeper: async () => {} });
  const r = await flow.poll();
  assert.equal(r.ok, false);
  assert.match(r.reason, /device_flow_disabled/);
  assert.equal(polls, 1, 'exactly one poll, no hammering');
});
