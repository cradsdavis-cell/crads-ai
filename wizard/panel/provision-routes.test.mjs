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
// The fake Hetzner is shared with the dev-harness (docs screenshots, driven
// tests) so the routes test and the page fixtures cannot disagree about what
// a Hetzner answer looks like.
import { fakeClient } from '../dev-harness/provision-fixture.mjs';
import { PROVIDERS } from '../provision/providers.mjs';

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF6zXyq1x2Qq0m7T3v9m4T8u5X6a7B8c9D0e1F2g3H4i owner@door';


function harness(over = {}) {
  const calls = [];   // [['create', name, provider], ['delete', id, provider], ...] since 2026-09-09
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
    makeClient: (token, provider) => fakeClient(calls, provider),
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
  assert.equal(r.body.defaults.server_type, 'cax11', 'the 4 GB Arm machine is the Standard default (2026-10-15)');
  assert.equal(r.body.defaults.location, 'hel1', 'the default location is one that SELLS the default machine');
  assert.equal(r.body.locations[0].city, 'Nuremberg');
  // per-location availability rides each type, so the page can refuse to offer
  // a pair Hetzner does not sell (cpx11 @ nbg1 was refused live, 2026-09-01)
  const cax21 = r.body.server_types.find((t) => t.name === 'cax21');
  const cpx11 = r.body.server_types.find((t) => t.name === 'cpx11');
  assert.deepEqual(cax21.locations, ['hel1'], 'cax21 must not be offered at nbg1');
  assert.deepEqual(cpx11.locations, ['hel1'], 'cpx11 must not be offered at nbg1');
  // A type sold NOWHERE is dropped, not stamped with an empty list: the page
  // reads an empty list as "unknown, offer everywhere", which is how cx33
  // stayed the default on the day Hetzner sold it nowhere (2026-10-13).
  assert.equal(r.body.server_types.find((t) => t.name === 'cx33'), undefined);
});

test('validate: an unreadable availability offers every type everywhere, never a dead form', async (t) => {
  const h = harness({
    makeClient: (token, provider) => ({ ...fakeClient([], provider), listAvailability: async () => { throw new Error('deprecated_api_endpoint'); } }),
  });
  t.after(h.close);
  const r = await h.call('POST', '/provision/validate', { token: 't' });
  assert.equal(r.status, 200);
  assert.equal(r.body.server_types.length, (await fakeClient([]).listServerTypes()).length, 'nothing dropped when availability is unknown');
  for (const ty of r.body.server_types) assert.deepEqual(ty.locations, []);
  assert.equal(r.body.defaults.location, PROVIDERS.hetzner.defaults.location);
});

test('start with no machine named builds what the location sells, not a stale default', async (t) => {
  const h = harness(); t.after(h.close);
  const r = await h.call('POST', '/provision/start', { token: 't', name: 'pick', location: 'nbg1' });
  assert.equal(r.status, 200);
  await untilPhase(h.call, 'ready');
  const create = h.calls.find((c) => c[0] === 'create');
  assert.deepEqual(create.slice(3), ['cpx22', 'nbg1'], 'nbg1 sells no Arm Standard machine, so the x86 one in the chain');
  const r2 = await h.call('POST', '/provision/start', { token: 't', name: 'pick2' });
  assert.equal(r2.status, 200);
  await untilPhase(h.call, 'ready');
  const create2 = h.calls.filter((c) => c[0] === 'create')[1];
  assert.deepEqual(create2.slice(3), ['cax11', 'hel1']);
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

// --- the second provider (2026-09-09) -------------------------------------------
test('GET /provision/providers lists the registry without functions, Hetzner first', async (t) => {
  const h = harness(); t.after(h.close);
  const r = await h.call('GET', '/provision/providers');
  assert.equal(r.status, 200);
  // Providers not yet proven on real metal (preview, 2026-10-14) are left off
  // the list members see; every other registered provider is on it, in order.
  assert.deepEqual(r.body.providers.map((p) => p.id), Object.keys(PROVIDERS).filter((id) => !PROVIDERS[id].preview));
  assert.ok(!r.body.providers.some((p) => p.preview), 'no preview provider reaches a member');
  for (const p of r.body.providers) {
    for (const k of ['id', 'label', 'symbol', 'costsCopy', 'tokenLabel', 'tokenHelpDocSlug', 'defaults', 'sizeChains']) assert.ok(k in p, `${p.id} lacks ${k}`);
    assert.ok(!('makeClient' in p), 'no function crosses the wire');
  }
});

test('validate carries the provider shape: symbol, chains, its own defaults', async (t) => {
  const h = harness(); t.after(h.close);
  const hz = await h.call('POST', '/provision/validate', { token: 't' });
  assert.equal(hz.body.provider, 'hetzner');
  assert.equal(hz.body.symbol, '€');
  assert.deepEqual(hz.body.chains, PROVIDERS.hetzner.sizeChains);
  const dO = await h.call('POST', '/provision/validate', { token: 't', provider: 'digitalocean' });
  assert.equal(dO.status, 200);
  assert.equal(dO.body.provider, 'digitalocean');
  assert.equal(dO.body.symbol, '$');
  assert.deepEqual(dO.body.defaults, { location: PROVIDERS.digitalocean.defaults.location, server_type: PROVIDERS.digitalocean.defaults.serverType });
  const bad = await h.call('POST', '/provision/validate', { token: 't', provider: 'linode' });
  assert.equal(bad.status, 400);
});

test('a DigitalOcean build drives the DigitalOcean client, records the provider, and destroys on the same provider', async (t) => {
  const h = harness(); t.after(h.close);
  const r = await h.call('POST', '/provision/start', { token: 'dop_v1_sekrit', name: 'demo', provider: 'digitalocean', location: 'syd1', server_type: 's-4vcpu-8gb' });
  assert.equal(r.status, 200);
  const s = await untilPhase(h.call, 'ready');
  assert.equal(s.provider, 'digitalocean');
  assert.ok(h.calls.some((c) => c[0] === 'create' && c[2] === 'digitalocean'), 'created through the DigitalOcean client');
  const state = JSON.parse(readFileSync(join(h.sshDir, 'demo-box.provision.json'), 'utf8'));
  assert.equal(state.provider, 'digitalocean', 'the provider is in the resume state');
  assert.ok(!JSON.stringify(state).includes('sekrit'), 'the token is not');
  // after a restart the form may say nothing about the provider: the state knows
  const d = await h.call('POST', '/provision/destroy', { token: 'dop_v1_sekrit', name: 'demo' });
  assert.equal(d.status, 200);
  assert.ok(h.calls.some((c) => c[0] === 'delete' && c[2] === 'digitalocean'), 'deleted through the DigitalOcean client, not the default');
});

test('start refuses an unknown provider and names the right provider in the token refusal', async (t) => {
  const h = harness(); t.after(h.close);
  assert.equal((await h.call('POST', '/provision/start', { token: 't', name: 'demo', provider: 'aws' })).status, 400);
  const r = await h.call('POST', '/provision/start', { name: 'demo', provider: 'digitalocean' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /DigitalOcean API token/);
});
