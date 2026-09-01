// hc-wait-running.test.mjs: the wizard's boot-wait survives a bad answer from
// Hetzner, and fails honestly when it should.
//   node --test wizard/panel/hc-wait-running.test.mjs
//
// The JS twin of provisioning/managed/hc-wait-running.test.mjs, and it exists
// for the same 2026-08-10 rock build. The shell path polled with `hc` (curl -f);
// this path polled with hcGet, which dies on any non-2xx. Same defect either
// way: one 404, one 429, one 502 and the stamp was over on the first poll, with
// the retry loop never reaching a second iteration. And if the loop DID run out,
// it fell through to `running at null` and wrote SERVER_IP: "null" into the
// state file, so an exhausted wait was indistinguishable from a built box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hcWaitRunning, waitForBox } from '../engine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const RUNNING = (ip = '203.0.113.9') =>
  ({ status: 200, body: { server: { status: 'running', public_net: { ipv4: { ip } } } } });
const BOOTING = { status: 200, body: { server: { status: 'initializing', public_net: { ipv4: { ip: null } } } } };
const GONE = { status: 404, body: { error: { code: 'not_found' } } };
const THROWS = 'throw';

/** ctx stand-in: die throws, exactly as the engine's real one does. */
const ctx = { say() {}, step() {}, ok() {}, okw() {}, die(m) { throw Object.assign(new Error(m), { engine: true }); } };

/** Drive hcWaitRunning against a scripted sequence with a caller-supplied ctx.
 *  Throws whatever the engine throws, so a test can inspect the ctx afterwards. */
async function waitWith(useCtx, answers, tries = 5) {
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    const a = answers[Math.min(n++, answers.length - 1)];
    if (a === THROWS) throw new Error('socket hang up');
    return { status: a.status, ok: a.status >= 200 && a.status < 300, text: async () => JSON.stringify(a.body) };
  };
  try {
    return await hcWaitRunning(useCtx, 'stub-token', '161073973', { tries, gapMs: 0 });
  } finally {
    globalThis.fetch = real;
  }
}

/** Drive hcWaitRunning against a scripted sequence; the last answer repeats. */
async function wait(answers, { tries = 5 } = {}) {
  try {
    return { ip: await waitWith(ctx, answers, tries), err: null };
  } catch (e) {
    return { ip: null, err: e };
  }
}

test('a booting VM is waited out and its IPv4 handed back', async () => {
  const r = await wait([BOOTING, BOOTING, RUNNING('203.0.113.9')]);
  assert.equal(r.err, null, r.err?.message);
  assert.equal(r.ip, '203.0.113.9');
});

test('one bad answer does not kill the stamp (the 2026-08-10 regression)', async () => {
  for (const blip of [{ status: 500, body: {} }, { status: 429, body: {} }, THROWS, GONE]) {
    const r = await wait([blip, BOOTING, RUNNING()]);
    assert.equal(r.err, null, `a single ${blip.status ?? 'network'} failure must be survivable: ${r.err?.message}`);
    assert.equal(r.ip, '203.0.113.9');
  }
});

test('a server that answers and THEN 404s repeatedly is reported as deleted', async () => {
  const r = await wait([BOOTING, GONE, GONE, GONE, RUNNING()]);
  assert.ok(r.err, 'must fail');
  assert.match(r.err.message, /is GONE/);
  assert.match(r.err.message, /deleted it underneath/);
  assert.equal(r.ip, null, 'and never returns a late IP after giving up');
});

test('a fresh server that 404s before it is ever seen is waited out, not buried', async () => {
  // The 2026-08-12 regression, in the twin. Three 404s then a healthy answer is
  // a build that must SUCCEED: the shell side declared GONE ~6s after create and
  // its rollback then deleted the VM, which made the wrong verdict prove itself.
  const r = await wait([GONE, GONE, GONE, RUNNING('203.0.113.9')]);
  assert.equal(r.err, null, `must be survivable: ${r.err?.message}`);
  assert.equal(r.ip, '203.0.113.9', 'and the late IP is handed back');
});

test('a server that never once answers fails as unproven, and is NOT rolled back', async () => {
  const keepCtx = { ...ctx, keepServer: false };
  let err = null;
  try { await waitWith(keepCtx, [GONE], 4); } catch (e) { err = e; }
  assert.ok(err, 'must fail');
  assert.match(err.message, /never became visible/, 'says what it can actually prove');
  assert.doesNotMatch(err.message, /deleted it underneath/, 'and does not blame a teardown it cannot see');
  assert.equal(keepCtx.keepServer, true, 'and tells the caller to leave the VM alone');
});

test('a rejected token says so instead of burning the full wait', async () => {
  const r = await wait([{ status: 401, body: {} }, RUNNING()]);
  assert.ok(r.err, 'must fail');
  assert.match(r.err.message, /refused the token/);
});

test('running out of attempts is a failure, not a box with a null IP', async () => {
  const r = await wait([BOOTING], { tries: 3 });
  assert.ok(r.err, 'an exhausted wait must not look like success');
  assert.match(r.err.message, /never reached 'running'/);
  assert.equal(r.ip, null);
});

test('the provisioning path uses the wait, and no longer polls with hcGet', async () => {
  const s = readFileSync(join(HERE, '..', 'engine.mjs'), 'utf8');
  assert.match(s, /const ip = await hcWaitRunning\(ctx, cfg\.hcloudToken, live\.serverId\)/);
  assert.doesNotMatch(
    s,
    /for \(let i = 0; i < 60; i\+\+\) \{[\s\S]{0,200}hcGet\(ctx, cfg\.hcloudToken, `\$\{HC_API\}\/servers\//,
    'must not go back to a bare hcGet poll loop',
  );
});

// ---------------------------------------------------------------- readiness
//
// The second half of the same stamp, and the same shape of bug: this path asked
// the browser door a question the 2026-08-05 ruling stopped it from answering.

/** Drive waitForBox against a scripted sequence of urlStatus codes. */
async function reach(codes, { tries = 4 } = {}) {
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    const c = codes[Math.min(n++, codes.length - 1)];
    if (c === '000') throw new Error('connect ETIMEDOUT');
    return { status: Number(c), ok: c === '200', text: async () => '', json: async () => ({}) };
  };
  try {
    return await waitForBox(ctx, 'test-rock-1.example.test', { tries, gapMs: 0 });
  } finally {
    globalThis.fetch = real;
  }
}

test('404 from the shut door is the HEALTHY answer, not a failed build', async () => {
  // The whole reason this test exists. The old check wanted 200 or 302; the
  // hostname is routed at http_status:404 forever, so a healthy rock burned all
  // 90 polls and was reported as never serving.
  assert.equal(await reach(['404']), 'reachable');
});

test('the tunnel not being up yet is waited out, not accepted', async () => {
  assert.equal(await reach(['000', '530', '523', '404']), 'reachable', 'waits through the tunnel-down codes');
  assert.equal(await reach(['530'], { tries: 3 }), 'timeout', 'and never calls a permanently down tunnel reachable');
});

test('a box that answers 200 is still reachable (nothing regressed for a served door)', async () => {
  assert.equal(await reach(['200']), 'reachable');
});

test('the rock stamp reports what it proved, not more', async () => {
  const s = readFileSync(join(HERE, '..', 'engine.mjs'), 'utf8');
  assert.match(s, /const readyState = await waitForBox\(ctx, hostname\)/);
  assert.doesNotMatch(s, /code === '200' \|\| code === '302'/, 'the pre-door-shut check must not come back');
  assert.match(s, /rock is reachable \(tunnel up\)/, 'a tunnel answering is not proof the container is live');
});
