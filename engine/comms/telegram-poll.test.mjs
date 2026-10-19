// telegram-poll.test.mjs: run: node --test engine/comms/telegram-poll.test.mjs
//
// Pins trap 71: a refused bot token made the bridge retry getUpdates with no
// pause (1,377 refusals in about 47 seconds in the 2026-10-14 drill). A 401 or
// 404 now waits 5 s, doubling to a 10 minute cap, logs once per wait, and the
// bridge picks up a corrected token without a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { makeApi, pollTurn, tokenBackoff, TOKEN_BACKOFF_FIRST_MS, TOKEN_BACKOFF_CAP_MS, OTHER_FAILURE_MS } from './telegram-poll.mjs';

const BRIDGE = path.join(import.meta.dirname, 'telegram.mjs');
const BAD = '111111111:AAFakeRevokedTokenForTestsOnly_xxxxxxx';
const GOOD = '222222222:AAFakeWorkingTokenForTestsOnly_xxxxxxx';

// A fake fetch that answers like Telegram: the GOOD token gets an empty update
// list, anything else gets `refusal`.
function fakeTelegram(refusal = { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized: invalid token specified' } }) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const good = url.includes(`/bot${GOOD}/`);
    const { status, body } = good ? { status: 200, body: { ok: true, result: [] } } : refusal;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, urls };
}

function harness(refusal) {
  let token = BAD;
  const fake = fakeTelegram(refusal);
  const api = makeApi({ base: 'https://telegram.invalid', getToken: () => token, fetchImpl: fake.fetchImpl });
  const logs = [];
  const handled = { updates: 0, flushes: 0 };
  const backoff = tokenBackoff();
  const turn = () => pollTurn({
    api, offset: 0, backoff, log: (m) => logs.push(m),
    handleUpdates: async () => { handled.updates += 1; },
    flushOutbox: async () => { handled.flushes += 1; },
  });
  return { turn, logs, handled, backoff, urls: fake.urls, setToken: (t) => { token = t; } };
}

test('a refused token backs off 5 s, doubling to a 10 minute cap, with one log line per wait', async () => {
  const h = harness();
  const waits = [];
  for (let i = 0; i < 10; i += 1) {
    const r = await h.turn();
    assert.equal(r.tokenRefused, true);
    waits.push(r.waitMs / 1000);
  }
  assert.equal(TOKEN_BACKOFF_FIRST_MS, 5_000);
  assert.equal(TOKEN_BACKOFF_CAP_MS, 600_000);
  assert.deepEqual(waits, [5, 10, 20, 40, 80, 160, 320, 600, 600, 600]);
  assert.equal(h.urls.length, 10, 'one request per turn, never a burst');
  assert.equal(h.logs.length, 10, 'one log line per wait');
  assert.match(h.logs[0], /refused the bot token \(401: Unauthorized: invalid token specified\)\. Retrying in 5 s/);
  assert.match(h.logs[9], /Retrying in 10 min/);
  assert.deepEqual(h.handled, { updates: 0, flushes: 0 }, 'no updates handled and no outbox flush on a refused token');
});

test('a corrected token is used on the next turn, logged once, and resets the back-off', async () => {
  const h = harness();
  await h.turn(); await h.turn(); await h.turn();
  h.setToken(GOOD);
  const ok = await h.turn();
  assert.deepEqual(ok, { waitMs: 0, tokenRefused: false });
  assert.ok(h.urls.at(-1).includes(`/bot${GOOD}/getUpdates`), 'the request carries the new token');
  assert.match(h.logs.at(-1), /works again after 3 refused attempts/);
  assert.deepEqual(h.handled, { updates: 1, flushes: 1 });
  await h.turn();
  assert.equal(h.logs.length, 4, 'a healthy poll logs nothing');
  h.setToken(BAD);
  assert.equal((await h.turn()).waitMs, 5_000, 'a later refusal starts again from 5 s');
});

test('a malformed token (404) backs off the same way', async () => {
  const h = harness({ status: 404, body: { ok: false, error_code: 404, description: 'Not Found' } });
  const waits = [];
  for (let i = 0; i < 3; i += 1) waits.push((await h.turn()).waitMs);
  assert.deepEqual(waits, [5_000, 10_000, 20_000]);
});

test('other refusals never spin: 429 waits as told, anything else waits 3 s, neither grows the token back-off', async () => {
  const limited = harness({ status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 17', parameters: { retry_after: 17 } } });
  assert.deepEqual(await limited.turn(), { waitMs: 17_000, tokenRefused: false });
  const conflict = harness({ status: 409, body: { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' } });
  assert.deepEqual(await conflict.turn(), { waitMs: OTHER_FAILURE_MS, tokenRefused: false });
  assert.deepEqual(await conflict.turn(), { waitMs: OTHER_FAILURE_MS, tokenRefused: false });
  assert.equal(conflict.backoff.failures, 0);
});

// The real bridge process against a fake Telegram over HTTP: it must not spin on
// a refused token, and it must pick up a corrected token file without a restart.
test('the bridge sends one getUpdates per back-off step and hears a corrected token without a restart', async (t) => {
  const state = tmpDir('tgpoll-bridge-');
  mkdirSync(path.join(state, 'secrets'), { recursive: true });
  const tokenFile = path.join(state, 'secrets', 'telegram_bot_token');
  writeFileSync(tokenFile, BAD);
  writeFileSync(path.join(state, 'secrets', 'telegram_chat_id'), '4242');

  const calls = [];
  const srv = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls.push(req.url);
      res.setHeader('content-type', 'application/json');
      if (!req.url.startsWith(`/bot${GOOD}/`)) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized: invalid token specified' }));
      }
      // Hold a good long-poll open briefly, as Telegram does, so the test sees a calm loop.
      setTimeout(() => res.end(JSON.stringify({ ok: true, result: [] })), 200);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());

  let out = '';
  const child = spawn(process.execPath, [BRIDGE, state], {
    env: { ...process.env, TELEGRAM_API_BASE: `http://127.0.0.1:${srv.address().port}` },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  child.stdout.on('data', (c) => { out += c; });
  t.after(() => child.kill('SIGKILL'));

  await new Promise((r) => setTimeout(r, 2000));
  const refused = calls.filter((u) => u.endsWith('/getUpdates'));
  assert.equal(refused.length, 1, `one request in the first 2 s, not a hot loop (saw ${refused.length})`);
  assert.equal((out.match(/refused the bot token/g) || []).length, 1, 'one log line for one refusal');
  assert.ok(!calls.some((u) => u.endsWith('/sendMessage')), 'nothing is sent with a refused token');

  writeFileSync(tokenFile, GOOD);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !calls.some((u) => u === `/bot${GOOD}/getUpdates`)) await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls.some((u) => u === `/bot${GOOD}/getUpdates`), 'the corrected token was used without a restart');
  await new Promise((r) => setTimeout(r, 300));
  assert.match(out, /picked up a new bot token/);
  assert.match(out, /works again after 1 refused attempt\b/);
  assert.equal(child.exitCode, null, 'the bridge is still running');
});
