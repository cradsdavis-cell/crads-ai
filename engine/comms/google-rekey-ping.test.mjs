// google-rekey-ping.test.mjs — run: node --test engine/comms/google-rekey-ping.test.mjs
//
// The probe must treat ONLY invalid_grant as death, tell the member exactly
// once, mark the row, and cost nothing between windows — the scheduler runs it
// hourly, so "almost always free and silent" is still the contract. The token
// endpoint is a local stub: the credential file's own token_uri is the only
// address the script knows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const SCRIPT = path.join(import.meta.dirname, 'google-rekey-ping.mjs');
// the probe fetches the stub endpoint served by THIS process, so the script
// must run async — execFileSync would block the loop and deadlock the pair
const execFileP = promisify(execFile);

// a stub Google token endpoint whose answer each test picks
const endpoint = () => new Promise((resolve) => {
  const state = { mode: 'alive', hits: 0 };
  const s = http.createServer((req, res) => {
    state.hits += 1;
    if (state.mode === 'alive') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"access_token":"at","expires_in":3599}'); return; }
    if (state.mode === 'dead') { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"invalid_grant"}'); return; }
    res.writeHead(500); res.end('boom');
  });
  s.listen(0, '127.0.0.1', () => resolve({ s, state, url: `http://127.0.0.1:${s.address().port}/token` }));
});

const box = ({ tokenUri, keyedAt = Date.now() - 3600e3, chat = '12345', creds = true } = {}) => {
  const d = tmpDir('grp-');
  mkdirSync(path.join(d, '.kernel'), { recursive: true });
  mkdirSync(path.join(d, 'secrets'), { recursive: true });
  if (chat) writeFileSync(path.join(d, 'secrets', 'telegram_chat_id'), chat + '\n');
  if (keyedAt != null) {
    const cf = path.join(d, '.kernel', 'google-creds', 'jane@gmail.com.json');
    if (creds) {
      mkdirSync(path.dirname(cf), { recursive: true });
      writeFileSync(cf, JSON.stringify({ token: 'at', refresh_token: 'rt', token_uri: tokenUri, client_id: 'c.apps.googleusercontent.com', client_secret: 's', scopes: [], expiry: '1970-01-01T00:00:00' }));
    }
    writeFileSync(path.join(d, '.kernel', 'mcp-oauth.json'), JSON.stringify({
      google: { provider: 'google-byo', email: 'jane@gmail.com', keyed_at: keyedAt, creds_file: cf },
    }));
  }
  return d;
};
const run = async (d) => JSON.parse((await execFileP('node', [SCRIPT, d])).stdout);
const outbox = (d) => { try { return readdirSync(path.join(d, '.kernel', 'outbox')); } catch { return []; } };
const deadMark = (d) => { try { return JSON.parse(readFileSync(path.join(d, '.kernel', 'google-key-dead.json'), 'utf8')); } catch { return null; } };

test('silent when there is nothing to probe', async () => {
  const { s, url } = await endpoint();
  try {
    const noKey = tmpDir('grp-');
    mkdirSync(path.join(noKey, '.kernel'), { recursive: true });
    assert.equal((await run(noKey)).why, 'no google key');
    const noCreds = box({ tokenUri: url, creds: false });
    assert.equal((await run(noCreds)).why, 'credential file incomplete');
  } finally { s.close(); }
});

test('an alive key: probe once per window, no message, no marker', async () => {
  const { s, state, url } = await endpoint();
  try {
    const d = box({ tokenUri: url });
    assert.equal((await run(d)).why, 'key alive');
    assert.equal((await run(d)).why, 'not due', 'the 6h throttle holds between windows');
    assert.equal(state.hits, 1, 'one probe, not one per scheduler tick');
    assert.equal(outbox(d).length, 0);
    assert.equal(deadMark(d), null);
  } finally { s.close(); }
});

test('a transient server error is NOT death', async () => {
  const { s, state, url } = await endpoint();
  try {
    state.mode = 'error';
    const d = box({ tokenUri: url });
    assert.match((await run(d)).why, /indefinite error/);
    assert.equal(deadMark(d), null, 'no marker on a 500');
    assert.equal(outbox(d).length, 0);
  } finally { s.close(); }
});

test('invalid_grant: the marker lands and the member hears exactly once', async () => {
  const { s, state, url } = await endpoint();
  try {
    state.mode = 'dead';
    const d = box({ tokenUri: url });
    assert.equal((await run(d)).sent, 'dead');
    assert.ok(deadMark(d), 'the status row can now tell the truth');
    assert.equal((await run(d)).why, 'not due', 'quiet between windows');
    // force the next window: rewind the ledger clock
    const lf = path.join(d, '.kernel', 'google-rekey-ping.json');
    const led = JSON.parse(readFileSync(lf, 'utf8'));
    led.checked_at = Date.now() - 7 * 3600e3;
    writeFileSync(lf, JSON.stringify(led));
    assert.equal((await run(d)).why, 'dead, already told', 'still dead, but never told twice');
    const files = outbox(d);
    assert.equal(files.length, 1);
    const rec = JSON.parse(readFileSync(path.join(d, '.kernel', 'outbox', files[0]), 'utf8'));
    assert.equal(rec.chat_id, '12345');
    assert.match(rec.text, /stopped working/i);
    assert.match(rec.text, /Connections, then Google/i, 'the message says exactly where to click');
  } finally { s.close(); }
});

test('no Telegram link: the marker still lands, silently', async () => {
  const { s, state, url } = await endpoint();
  try {
    state.mode = 'dead';
    const d = box({ tokenUri: url, chat: null });
    assert.equal((await run(d)).why, 'dead, no telegram link');
    assert.ok(deadMark(d));
    assert.equal(outbox(d).length, 0);
  } finally { s.close(); }
});

test('a re-key retires the marker and the ledger slot', async () => {
  const { s, state, url } = await endpoint();
  try {
    state.mode = 'dead';
    const d = box({ tokenUri: url });
    assert.equal((await run(d)).sent, 'dead');
    // the member re-keys: keyed_at moves, the key is alive again
    state.mode = 'alive';
    const cf = path.join(d, '.kernel', 'google-creds', 'jane@gmail.com.json');
    writeFileSync(path.join(d, '.kernel', 'mcp-oauth.json'), JSON.stringify({
      google: { provider: 'google-byo', email: 'jane@gmail.com', keyed_at: Date.now(), creds_file: cf },
    }));
    assert.equal((await run(d)).why, 'key alive', 'a fresh keyed_at is a fresh slot: no throttle carry-over');
    assert.equal(deadMark(d), null, 'the marker is gone the moment the key proves alive');
    assert.ok(!existsSync(path.join(d, '.kernel', 'google-key-dead.json')));
  } finally { s.close(); }
});

// ---- several accounts (2026-09-14): each on its own clock, marker and line --

test('two accounts: the dead work key is marked and named; the alive primary is untouched', async () => {
  const { s, state, url } = await endpoint();
  try {
    const d = box({ tokenUri: url });
    // the second account points its credential file at a SECOND stub that answers dead
    const dead = await endpoint();
    dead.state.mode = 'dead';
    const cw = path.join(d, '.kernel', 'google-creds', 'jane@acme.example.json');
    writeFileSync(cw, JSON.stringify({ token: 'at', refresh_token: 'rt', token_uri: dead.url, client_id: 'w.apps.googleusercontent.com', client_secret: 's', scopes: [], expiry: '1970-01-01T00:00:00' }));
    const store = JSON.parse(readFileSync(path.join(d, '.kernel', 'mcp-oauth.json'), 'utf8'));
    store['google-work'] = { provider: 'google-byo', email: 'jane@acme.example', keyed_at: Date.now() - 3600e3, creds_file: cw };
    writeFileSync(path.join(d, '.kernel', 'mcp-oauth.json'), JSON.stringify(store));
    try {
      const r = await run(d);
      assert.equal(r.sent, 'dead');
      assert.deepEqual(r.accounts.map((a) => [a.key, a.why || a.sent]), [['google', 'key alive'], ['google-work', 'dead']]);
      assert.equal(deadMark(d), null, 'the primary marker never lands for another account\'s death');
      const wm = JSON.parse(readFileSync(path.join(d, '.kernel', 'google-key-dead.work.json'), 'utf8'));
      assert.equal(wm.keyed_at, store['google-work'].keyed_at);
      assert.ok(existsSync(path.join(d, '.kernel', 'google-rekey-ping.work.json')), 'its own ledger');
      const files = outbox(d);
      assert.equal(files.length, 1);
      const rec = JSON.parse(readFileSync(path.join(d, '.kernel', 'outbox', files[0]), 'utf8'));
      assert.match(rec.text, /jane@acme\.example/, 'the message names the account');
      assert.match(rec.text, /Connections, then Google Workspace \(work\), then Sign in/, 'and the exact row to press');
      assert.equal(state.hits, 1); assert.equal(dead.state.hits, 1);
      // next tick: both throttled, nothing repeats
      const r2 = await run(d);
      assert.equal(r2.sent, null);
      assert.match(r2.why, /google: not due; google-work: not due/);
      assert.equal(outbox(d).length, 1);
    } finally { dead.s.close(); }
  } finally { s.close(); }
});
