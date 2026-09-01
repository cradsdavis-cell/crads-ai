// gh-token-refresh.test.mjs — the sign-in has to outlive the day it was made.
// Run: node --test engine/gh-token-refresh.test.mjs
//
// THE BUG THIS EXISTS FOR (found live on test-org-4, 2026-08-10): the device
// flow kept only the access token. GitHub OAuth user tokens expire in about 8
// hours, so every connected mineral's GitHub went dead within a day, silently,
// and the only way back was a human running connect-github on the box. The
// first live anchor stalled on exactly that — adoption could not create the
// channel repos, and the dead token surfaced two layers later as "repository
// not found", then "Bad credentials".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveGrant, refreshIfNeeded, storePath } from './gh-token-refresh.mjs';
import { tmpDir } from '../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = () => tmpDir('ghref-');
const okGh = (calls) => (args, opts = {}) => { calls.push({ args, input: opts.input }); return { status: 0, stdout: '', stderr: '' }; };

test('the login KEEPS the refresh half, private on disk; an expiry-off app stores nothing', () => {
  const d = dir();
  assert.equal(saveGrant({ access_token: 'gho_x', refresh_token: 'ghr_y', expires_in: 28800, refresh_token_expires_in: 15897600 }, { dir: d, nowMs: 1000 }), true);
  const st = JSON.parse(readFileSync(storePath(d), 'utf8'));
  assert.equal(st.refresh_token, 'ghr_y');
  assert.equal(st.expires_at, 1000 + 28800 * 1000);
  assert.ok(!('access_token' in st), 'the access token lives in gh, never twice on disk');
  assert.equal(statSync(storePath(d)).mode & 0o777, 0o600, 'private to the user');
  const d2 = dir();
  assert.equal(saveGrant({ access_token: 'gho_x' }, { dir: d2 }), false, 'no refresh token: nothing to keep');
  assert.ok(!existsSync(storePath(d2)));
});

test('a fresh token is left alone; an ageing one is exchanged and the NEW refresh token replaces the old', async () => {
  const d = dir();
  saveGrant({ refresh_token: 'ghr_1', expires_in: 28800 }, { dir: d, nowMs: Date.now() });
  const calls = [];
  const noNet = async () => { throw new Error('the network must not be touched while fresh'); };
  const fresh = await refreshIfNeeded({ dir: d, fetcher: noNet, gh: okGh(calls), log: () => {} });
  assert.equal(fresh.fresh, true);
  assert.equal(calls.length, 0);

  // wind the clock to inside the early window
  const st = JSON.parse(readFileSync(storePath(d), 'utf8'));
  writeFileSync(storePath(d), JSON.stringify({ ...st, expires_at: Date.now() + 60 * 1000 }));
  let sent = null;
  const fetcher = async (url, init) => {
    sent = { url, body: Object.fromEntries(new URLSearchParams(init.body)) };
    return { json: async () => ({ access_token: 'gho_new', refresh_token: 'ghr_2', expires_in: 28800, refresh_token_expires_in: 15897600 }) };
  };
  const calls2 = [];
  const r = await refreshIfNeeded({ dir: d, fetcher, gh: okGh(calls2), log: () => {} });
  assert.equal(r.refreshed, true);
  assert.equal(sent.body.grant_type, 'refresh_token');
  assert.equal(sent.body.refresh_token, 'ghr_1', 'the OLD refresh token was spent');
  const login = calls2.find((c) => c.args.join(' ').includes('auth login --with-token'));
  assert.ok(login, 'the fresh token is stored through gh');
  assert.equal(login.input, 'gho_new\n', 'over stdin, never argv');
  assert.equal(JSON.parse(readFileSync(storePath(d), 'utf8')).refresh_token, 'ghr_2',
    'single-use rotation: the NEW refresh token replaced it');
});

test('failures never destroy the way back: offline keeps the store, a refusal names connect-github', async () => {
  const d = dir();
  saveGrant({ refresh_token: 'ghr_1', expires_in: 1 }, { dir: d, nowMs: Date.now() });
  const said = [];
  const off = await refreshIfNeeded({ dir: d, fetcher: async () => { throw new Error('ENETDOWN'); }, gh: okGh([]), log: (m) => said.push(m) });
  assert.equal(off.offline, true);
  assert.equal(JSON.parse(readFileSync(storePath(d), 'utf8')).refresh_token, 'ghr_1', 'a blip costs nothing');

  const refused = await refreshIfNeeded({ dir: d, fetcher: async () => ({ json: async () => ({ error: 'bad_refresh_token' }) }), gh: okGh([]), log: (m) => said.push(m) });
  assert.equal(refused.refused, true);
  assert.ok(existsSync(storePath(d)), 'even a refusal leaves the store for a later attempt');
  assert.match(said.join(' '), /connect-github/, 'the human is told the one thing that fixes it');

  const empty = await refreshIfNeeded({ dir: dir(), fetcher: async () => { throw new Error('no'); }, gh: okGh([]), log: () => {} });
  assert.match(empty.skipped, /no refresh store/, 'a mineral connected before this is a silent no-op');
});

test('anti-drift: the login saves the grant and the scheduler actually runs the refresher', () => {
  const login = readFileSync(join(HERE, 'gh-device-login.mjs'), 'utf8');
  assert.match(login, /saveGrant\(grant/, 'the device flow persists the refresh half');
  const sched = readFileSync(join(HERE, 'cron', 'scheduler.mjs'), 'utf8');
  assert.match(sched, /gh-token-refresh\.mjs/, 'the scheduler has a leg');
  // THE GUARD CHANGED SHAPE ON 2026-08-20, AND ONLY ITS SHAPE. This line used to
  // assert `device-refresh.json ] &&`, and that spelling is exactly what forced
  // the `|| true` on the end of the scheduler's line: `[ -f x ] && node y` exits
  // 1 on a mineral that has no store, so something had to swallow it, and what
  // swallowed it also swallowed the deliberate exit 1 this very file exists to
  // produce. Every hour a mineral's GitHub sign-in was unrenewable was recorded
  // in its run ledger as ok. The guard is now a presence test that exits 0, which
  // keeps the promise this assertion was making without keeping what broke it.
  assert.match(sched, /\[ -f \$\{stateDir\}\/\.kernel\/gh\/device-refresh\.json \] \|\| exit 0;/,
    'guarded: a mineral with no store exits 0 before it ever spawns node');
  assert.ok(!/gh-token-refresh\.mjs'\)\} \|\| true/.test(sched),
    'and nothing may throw the refresher\'s exit status away again');
});

// 2026-08-20 audit: the untested branch, and the one that mattered.
//
// Every test above stubs gh with okGh, which always returns status 0, so the
// exchange-succeeded-but-store-failed path was never exercised. That path used
// to return before saveGrant, throwing away the ROTATED refresh token while the
// file kept the one GitHub had just spent. Refresh tokens are single-use, so
// every later run re-sent a dead token, took the terminal refused branch, and
// the mineral's GitHub was gone until a human re-ran connect-github and typed a
// device code. There is no automatic way back.
const failingGh = (calls) => (args, opts = {}) => {
  calls.push({ args, input: opts.input });
  return { status: 1, stdout: '', stderr: 'could not write config\n' };
};

test('a failed access-token store never destroys the way back', async () => {
  const d = dir();
  saveGrant({ access_token: 'gho_old', refresh_token: 'ghr_spent', expires_in: 1, refresh_token_expires_in: 15897600 }, { dir: d, nowMs: 1000 });
  const calls = [];
  const fetcher = async () => ({ json: async () => ({ access_token: 'gho_new', refresh_token: 'ghr_rotated', expires_in: 28800, refresh_token_expires_in: 15897600 }) });
  const r = await refreshIfNeeded({ dir: d, nowMs: 2_000_000, fetcher, gh: failingGh(calls), force: true });

  assert.equal(r.storeFailed, true, 'the caller is told the access token did not land');
  const st = JSON.parse(readFileSync(storePath(d), 'utf8'));
  assert.equal(st.refresh_token, 'ghr_rotated',
    'the ROTATED token is on disk: GitHub already spent ghr_spent during the exchange, so keeping it would be keeping a dead token');
  assert.notEqual(st.refresh_token, 'ghr_spent', 'and the spent one is gone');
});

test('the retry after a failed store actually works, because the saved token is live', async () => {
  const d = dir();
  saveGrant({ access_token: 'gho_old', refresh_token: 'ghr_spent', expires_in: 1, refresh_token_expires_in: 15897600 }, { dir: d, nowMs: 1000 });
  const seen = [];
  const fetcher = async (_url, init) => {
    seen.push(new URLSearchParams(init.body).get('refresh_token'));
    return { json: async () => ({ access_token: 'gho_new', refresh_token: 'ghr_' + seen.length, expires_in: 28800, refresh_token_expires_in: 15897600 }) };
  };
  await refreshIfNeeded({ dir: d, nowMs: 2_000_000, fetcher, gh: failingGh([]), force: true });
  const second = await refreshIfNeeded({ dir: d, nowMs: 2_000_000, fetcher, gh: okGh([]), force: true });
  assert.equal(second.refreshed, true, 'the next hour recovers on its own; no human, no device code');
  assert.deepEqual(seen, ['ghr_spent', 'ghr_1'], 'and it sent the rotated token, not the spent one');
});
