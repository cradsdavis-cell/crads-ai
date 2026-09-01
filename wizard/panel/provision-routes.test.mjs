// provision-routes.test.mjs — the door's self-host create flow against a fake
// Hetzner and a scratch ssh dir. Nothing touches the network or the real ~/.ssh.
//   node --test wizard/panel/provision-routes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { provisionRoutes } from './provision-routes.mjs';

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF6zXyq1x2Qq0m7T3v9m4T8u5X6a7B8c9D0e1F2g3H4i owner@door';

function fakeClient(calls) {
  return {
    validateToken: async () => ({ ok: true }),
    listLocations: async () => [{ name: 'nbg1', city: 'Nuremberg', country: 'DE' }],
    listServerTypes: async () => [
      { id: 1, name: 'cx33', cores: 4, memoryGb: 8, diskGb: 80, arch: 'x86' },
      { id: 2, name: 'cpx11', cores: 2, memoryGb: 2, diskGb: 40, arch: 'x86' },
    ],
    listAvailability: async () => ({ nbg1: [1], hel1: [1, 2] }),
    ensureSshKey: async () => 7,
    createServer: async (o) => { calls.push(['create', o.name]); return { id: 42, ip: '203.0.113.9', actionId: 9 }; },
    waitAction: async () => ({ status: 'success' }),
    getServer: async () => ({ id: 42, name: 'aios-demo', status: 'running', ip: '203.0.113.9' }),
    deleteServer: async (id) => { calls.push(['delete', id]); },
  };
}

function harness(over = {}) {
  const calls = [];
  const installs = [];
  const pins = [];
  const sshDir = tmpDir('prov-');
  // The Claude Code settings path MUST be injected. Without it the default is
  // the real ~/.claude/settings.json and a test run writes a fake mineral into
  // the developer's own Environment dropdown: caught doing exactly that on
  // 2026-09-01, one run after the register step was added.
  const settingsPath = join(sshDir, 'claude-settings.json');
  const handle = provisionRoutes({
    sshDir,
    settingsPath,
    makeClient: () => fakeClient(calls),
    install: (o) => { installs.push({ ...o }); return { publicKey: PUB + '\n' }; },
    pin: (ip) => pins.push(ip),
    probe: over.probe || (async () => ({ code: 0, stdout: 'chain-ok\n' })),
    sleep: async () => {},
    bootTimeoutMs: 2000,
    ...over,
  });
  const server = http.createServer((req, res) => { if (!handle(req, res, req.url.split('?')[0])) { res.writeHead(404); res.end(); } });
  // listen is async: the first call must WAIT for the bound port, or
  // server.address() is null and every test dies on an invalid URL.
  const ready = new Promise((r) => server.listen(0, '127.0.0.1', r));
  const call = async (method, path, body) => {
    await ready;
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  // closeAllConnections too: fetch's keep-alive sockets otherwise hold the
  // process open past the last test and the runner never exits.
  return { call, calls, installs, pins, sshDir, settingsPath, close: () => { server.closeAllConnections?.(); server.close(); } };
}

async function untilPhase(call, phase, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const s = (await call('GET', '/provision/status')).body;
    if (s.phase === phase) return s;
    if (s.phase === 'failed' && phase !== 'failed') assert.fail(`run failed: ${s.error}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`never reached phase ${phase}`);
}

test('validate: a good token answers catalogues + defaults', async (t) => {
  const h = harness(); t.after(h.close);
  const r = await h.call('POST', '/provision/validate', { token: 't' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.defaults.server_type, 'cx33');
  assert.equal(r.body.locations[0].city, 'Nuremberg');
  // per-location availability rides each type, so the page can refuse to offer
  // a pair Hetzner does not sell (cpx11 @ nbg1 was refused live, 2026-09-01)
  const cx33 = r.body.server_types.find((t) => t.name === 'cx33');
  const cpx11 = r.body.server_types.find((t) => t.name === 'cpx11');
  assert.deepEqual(cx33.locations.sort(), ['hel1', 'nbg1']);
  assert.deepEqual(cpx11.locations, ['hel1'], 'cpx11 must not be offered at nbg1');
});

test('validate: a rejected token is a 401, not a build', async (t) => {
  const h = harness({ makeClient: () => ({ validateToken: async () => ({ ok: false, reason: 'unauthorized' }) }) }); t.after(h.close);
  const r = await h.call('POST', '/provision/validate', { token: 'bad' });
  assert.equal(r.status, 401);
});

test('the whole flow: start -> ready; key before birth, HostName repaired after, pin last, token never on disk', async (t) => {
  const h = harness(); t.after(h.close);
  const r = await h.call('POST', '/provision/start', { token: 'tok-secret', name: 'demo' });
  assert.equal(r.status, 200);
  assert.equal(r.body.alias, 'demo-box');
  const s = await untilPhase(h.call, 'ready');
  assert.equal(s.ip, '203.0.113.9');
  assert.equal(s.server_id, 42);
  // key before birth: first install carries the placeholder, second the real IP
  assert.deepEqual(h.installs.map((i) => i.host), ['0.0.0.0', '203.0.113.9']);
  assert.deepEqual(h.pins, ['203.0.113.9']);
  // resume state persisted, and the token is in neither the file nor the status
  const stateFile = join(h.sshDir, 'demo-box.provision.json');
  assert.ok(existsSync(stateFile));
  assert.ok(!readFileSync(stateFile, 'utf8').includes('tok-secret'));
  assert.ok(!JSON.stringify(s).includes('tok-secret'));
});

test('a second start while one runs is a 409; a bad name never reaches the engine', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ probe: async () => { await gate; return { code: 0, stdout: 'chain-ok' }; } }); t.after(h.close);
  assert.equal((await h.call('POST', '/provision/start', { token: 't', name: 'Bad Name' })).status, 400);
  assert.equal((await h.call('POST', '/provision/start', { token: 't', name: 'demo' })).status, 200);
  await untilPhase(h.call, 'booting');
  assert.equal((await h.call('POST', '/provision/start', { token: 't', name: 'other' })).status, 409);
  release();
  await untilPhase(h.call, 'ready');
});

test('a failed boot surfaces the error and destroy clears the half-made run', async (t) => {
  const h = harness({ probe: async () => ({ code: 1, stdout: '' }), bootTimeoutMs: 1 }); t.after(h.close);
  await h.call('POST', '/provision/start', { token: 'tok', name: 'demo' });
  const s = await untilPhase(h.call, 'failed');
  assert.match(s.error, /never answered/);
  const d = await h.call('POST', '/provision/destroy', {});
  assert.equal(d.status, 200);
  assert.equal(d.body.destroyed, true);
  assert.ok(h.calls.some((c) => c[0] === 'delete'));
  assert.ok(!existsSync(join(h.sshDir, 'demo-box.provision.json')), 'state file cleared on destroy');
  assert.equal((await h.call('GET', '/provision/status')).body.phase, 'idle');
});

test('destroy after an app restart needs the token again (it was never stored)', async (t) => {
  const h = harness(); t.after(h.close);
  const r = await h.call('POST', '/provision/destroy', { name: 'ghost' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /never stored/);
});

// --- the Environment entry in the Claude Code app ------------------------------
// Access is app-first: SSH only, no browser IDE. A box that never reaches the
// dropdown is a box the member cannot open, however healthy it is. The
// hosted-era connect flow registered it; the self-host flow shipped without
// that step, so every mineral came up working and invisible (Sam, 2026-09-01).
test('a finished build registers the mineral in the Claude Code app', async (t) => {
  const h = harness({ openFolder: async () => ({ code: 0, stdout: 'demo\n' }) });
  t.after(h.close);
  await h.call('POST', '/provision/start', { token: 't', name: 'demo' });
  await untilPhase(h.call, 'ready');
  const entry = JSON.parse(readFileSync(h.settingsPath, 'utf8')).sshConfigs.find((c) => c.id === 'demo-box');
  assert.ok(entry, 'the mineral is in sshConfigs');
  assert.equal(entry.sshHost, 'demo-box', 'and dials the alias the Host block defines');
  assert.equal(entry.name, 'demo', 'named as the person named it');
  // /state/<name>, asked of the box once the chain is proven. A startDirectory
  // nobody confirmed is a session Claude Code cannot open.
  assert.equal(entry.startDirectory, '/state/demo');
});

test('a box that cannot answer the folder probe still gets a usable entry', async (t) => {
  // The registration and the folder question are two steps on purpose. A box
  // that is up but slow to answer must not lose its dropdown entry over it.
  const h = harness({ openFolder: async () => { throw new Error('ssh died'); } });
  t.after(h.close);
  await h.call('POST', '/provision/start', { token: 't', name: 'demo' });
  await untilPhase(h.call, 'ready');
  const entry = JSON.parse(readFileSync(h.settingsPath, 'utf8')).sshConfigs.find((c) => c.id === 'demo-box');
  assert.ok(entry, 'still registered');
  assert.equal(entry.startDirectory, '/state', 'falling back to the box root, not to nothing');
});

test('a settings file it cannot write never fails a build that worked', async (t) => {
  const h = harness({ register: () => { throw new Error('settings.json is read-only'); } });
  t.after(h.close);
  await h.call('POST', '/provision/start', { token: 't', name: 'demo' });
  const s = await untilPhase(h.call, 'ready');
  assert.equal(s.phase, 'ready', 'the mineral is up; the entry is repairable by hand');
});

test('no test may write the real ~/.claude/settings.json', () => {
  // The pin for the pollution above: harness() must inject settingsPath, and it
  // must land inside the scratch ssh dir, never in a home directory.
  const h = harness();
  h.close();
  assert.ok(h.settingsPath.startsWith(h.sshDir), 'settings path is inside the scratch dir');
});
