// P3.3: the own-brain flow — start returns the GitHub code to show, status
// streams progress until done. Token lives only in the in-memory flow state,
// never on disk, never in a response. Since the member-connect surface was
// deleted (2026-09-01) the routes' one mount is the panel server (the seat's
// Backup card), so that is the server driven here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPanelServer } from './panel-server.mjs';

const TARGETS = [{ host: 'jane01-box', org: 'jane01', kind: 'member' }];
const listen = (opts) => new Promise((resolve) => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html>app</html>',
    bridge: { targets: () => TARGETS, run: () => { throw new Error('no real ssh in this test'); } },
    lastUsedPath: null, ...opts });
  s.on('listening', () => resolve(s));
});
const post = (s, path, body) => fetch(`http://127.0.0.1:${s.address().port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (s, path) => fetch(`http://127.0.0.1:${s.address().port}${path}`);

function stubs({ pollDelay = 0, pollResult = { ok: true, token: 'gho_x' }, ownResult = { ok: true, repo: 'jane-gh/jane01-brain', pushed: true } } = {}) {
  const seen = { ownArgs: null };
  return {
    seen,
    deviceFlow: async () => ({ userCode: 'WXYZ-9876', verificationUri: 'https://github.com/login/device',
      poll: async () => { if (pollDelay) await new Promise((r) => setTimeout(r, pollDelay)); return pollResult; } }),
    ownBrain: async (args) => { seen.ownArgs = args; args.log && args.log('created private repo'); return ownResult; },
  };
}

test('start -> code; status -> done with the repo; token never appears in any response', async () => {
  const st = stubs();
  const s = await listen({ deviceFlow: st.deviceFlow, ownBrain: st.ownBrain });
  try {
    const r = await post(s, '/own-brain/start', { slug: 'jane01' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.userCode, 'WXYZ-9876');
    assert.match(j.verificationUri, /github\.com\/login\/device/);
    // poll status until done
    let body;
    for (let i = 0; i < 40; i++) {
      body = await (await get(s, '/own-brain/status')).json();
      if (body.stage === 'done' || body.stage === 'failed') break;
      await new Promise((r2) => setTimeout(r2, 25));
    }
    assert.equal(body.stage, 'done');
    assert.equal(body.result.repo, 'jane-gh/jane01-brain');
    assert.ok(body.steps.some((l) => /created private repo/.test(l)));
    assert.ok(!JSON.stringify(body).includes('gho_x'), 'token never leaves the server');
    assert.equal(st.seen.ownArgs.slug, 'jane01');
    assert.equal(st.seen.ownArgs.boxAlias, 'jane01-box');
    assert.equal(st.seen.ownArgs.token, 'gho_x');
  } finally { s.close(); }
});

test('denied sign-in -> failed stage with the reason', async () => {
  const st = stubs({ pollResult: { ok: false, reason: 'sign-in was denied or cancelled on GitHub' } });
  const s = await listen({ deviceFlow: st.deviceFlow, ownBrain: st.ownBrain });
  try {
    await post(s, '/own-brain/start', { slug: 'jane01' });
    let body;
    for (let i = 0; i < 40; i++) {
      body = await (await get(s, '/own-brain/status')).json();
      if (body.stage === 'failed') break;
      await new Promise((r2) => setTimeout(r2, 25));
    }
    assert.equal(body.stage, 'failed');
    assert.match(body.reason, /denied/);
  } finally { s.close(); }
});

test('bad slug is a 400 before any flow starts', async () => {
  let started = 0;
  const s = await listen({ deviceFlow: async () => { started++; }, ownBrain: async () => {} });
  try {
    const r = await post(s, '/own-brain/start', { slug: 'NOPE!!' });
    assert.equal(r.status, 400);
    assert.equal(started, 0);
  } finally { s.close(); }
});

test('status with no flow yet reports idle', async () => {
  const s = await listen({});
  try {
    const j = await (await get(s, '/own-brain/status')).json();
    assert.equal(j.stage, 'idle');
  } finally { s.close(); }
});

test('non-JSON content-type is refused (no-preflight CSRF guard)', async () => {
  let started = 0;
  const s = await listen({ deviceFlow: async () => { started++; } });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/own-brain/start`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"slug":"jane01"}' });
    assert.equal(r.status, 415);
    assert.equal(started, 0);
  } finally { s.close(); }
});

// ---- D60 O6: /own-brain/precheck (gate the card BEFORE a device-flow round trip) --
test('precheck: org-owned + grant, org-owned + none, member-owned, unparseable -> member (two separate probes)', async () => {
  const mk = (files) => async (host, cmd) => {
    // two SEPARATE probes by contract: each cmd cats exactly one file
    if (cmd.includes('ownership.json')) return { code: 0, stdout: files.own ?? '', stderr: '' };
    if (cmd.includes('to-member.json')) return { code: 0, stdout: files.grant ?? '', stderr: '' };
    throw new Error(`unexpected probe: ${cmd}`);
  };
  const cases = [
    { files: { own: '{"owner":"org"}', grant: '{"granted":"2026-07-25"}' }, want: { orgOwned: true, granted: true } },
    { files: { own: '{"owner":"org"}', grant: '' }, want: { orgOwned: true, granted: false } },
    { files: { own: '{"owner":"member"}' }, want: { orgOwned: false, granted: false } },
    { files: { own: 'not-json{{' }, want: { orgOwned: false, granted: false } },
  ];
  for (const c of cases) {
    const s = await listen({ precheckBridge: mk(c.files) });
    try {
      const r = await get(s, '/own-brain/precheck');
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.orgOwned, c.want.orgOwned, JSON.stringify(c));
      assert.equal(j.granted, c.want.granted, JSON.stringify(c));
    } finally { s.close(); }
  }
});

test('precheck: the two probes are SEPARATE commands (no combined read, the O5a discipline)', async () => {
  const cmds = [];
  const bridge = async (host, cmd) => { cmds.push(cmd); return { code: 0, stdout: '{"owner":"org"}', stderr: '' }; };
  const s = await listen({ precheckBridge: bridge });
  try {
    await get(s, '/own-brain/precheck');
    assert.equal(cmds.length, 2, 'exactly two probes');
    assert.ok(cmds[0].includes('ownership.json') && !cmds[0].includes('to-member.json'), 'probe 1 reads ownership only');
    assert.ok(cmds[1].includes('to-member.json') && !cmds[1].includes('ownership.json'), 'probe 2 reads the grant only');
  } finally { s.close(); }
});
