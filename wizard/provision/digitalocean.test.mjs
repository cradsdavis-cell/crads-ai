// digitalocean.test.mjs: the DigitalOcean client against a stubbed API.
// Nothing here reaches the network; the fetch stub IS the API, and its shapes
// are the ones read from DigitalOcean's OpenAPI spec on 2026-09-09.
//   node --test wizard/provision/digitalocean.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DigitalOceanClient, USER_DATA_LIMIT } from './digitalocean.mjs';
import { provisionSelfHost, destroySelfHost } from './engine.mjs';

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF6zXyq1x2Qq0m7T3v9m4T8u5X6a7B8c9D0e1F2g3H4i owner@wizard';

// The routing table mirrors engine.test's fakeHetzner: key = "METHOD /path",
// handler(body) -> body, {status} for an error. `state` lets a test flip the
// droplet from new to active between polls.
export function fakeDigitalOcean(log = [], opts = {}) {
  const state = { droplets: {}, keys: [], polls: 0, ...opts };
  let nextId = 5001;
  const droplet = (id) => ({
    id, name: state.droplets[id].name, status: state.droplets[id].status,
    networks: { v4: state.droplets[id].status === 'active'
      ? [{ ip_address: '10.1.1.1', type: 'private' }, { ip_address: '203.0.113.42', type: 'public' }]
      : [] },
  });
  const routes = {
    'GET /account': () => ({ account: { status: state.accountStatus || 'active', status_message: state.statusMessage || '', droplet_limit: 10, email: 'x@example.com' } }),
    'GET /regions?per_page=200': () => ({ regions: [
      { slug: 'syd1', name: 'Sydney 1', available: true, sizes: ['s-2vcpu-4gb', 's-4vcpu-8gb'] },
      { slug: 'nyc3', name: 'New York 3', available: true, sizes: ['s-2vcpu-4gb', 's-4vcpu-8gb', 's-8vcpu-16gb', 'c-2'] },
      { slug: 'ams2', name: 'Amsterdam 2', available: false, sizes: [] },
    ] }),
    'GET /sizes?per_page=200': () => ({ sizes: [
      { slug: 's-2vcpu-4gb', memory: 4096, vcpus: 2, disk: 80, price_monthly: 24.0, regions: ['syd1', 'nyc3'], available: true, description: 'Basic' },
      { slug: 's-4vcpu-8gb', memory: 8192, vcpus: 4, disk: 160, price_monthly: 48.0, regions: ['syd1', 'nyc3'], available: true, description: 'Basic' },
      { slug: 's-8vcpu-16gb', memory: 16384, vcpus: 8, disk: 320, price_monthly: 96.0, regions: ['nyc3'], available: true, description: 'Basic' },
      { slug: 'c-2', memory: 4096, vcpus: 2, disk: 25, price_monthly: 42.0, regions: ['nyc3'], available: true, description: 'CPU-Optimized' },
      { slug: 's-1vcpu-512mb-10gb', memory: 512, vcpus: 1, disk: 10, price_monthly: 4.0, regions: ['nyc3'], available: false, description: 'Basic' },
    ] }),
    'POST /account/keys': (body) => {
      if (state.keys.some((k) => k.public_key.split(/\s+/)[1] === body.public_key.split(/\s+/)[1])) {
        return { status: 422, body: { id: 'unprocessable_entity', message: 'SSH Key is already in use on your account' } };
      }
      const k = { id: 700 + state.keys.length, name: body.name, public_key: body.public_key, fingerprint: 'aa:bb' };
      state.keys.push(k);
      return { ssh_key: k };
    },
    'GET /account/keys?per_page=200': () => ({ ssh_keys: state.keys }),
    'POST /droplets': (body) => {
      assert.match(body.name, /^aios-/);
      assert.equal(body.image, 'ubuntu-24-04-x64');
      assert.ok(Array.isArray(body.ssh_keys) && body.ssh_keys.length === 1, 'exactly the owner key');
      assert.ok(body.user_data.includes(PUB), 'owner key must be in cloud-init');
      assert.deepEqual(body.tags, [body.name], 'tagged with its own name for adopt-by-tag');
      assert.equal(body.with_droplet_agent, false);
      if (state.dropCreate) { state.dropCreate = false; state.droplets[nextId] = { name: body.name, status: 'new' }; state.lost = nextId++; throw new Error('socket hang up'); }
      const id = nextId++;
      state.droplets[id] = { name: body.name, status: 'new' };
      return { status: 202, body: { droplet: droplet(id), links: { actions: [{ id: 90000 + id, rel: 'create', href: `https://api.digitalocean.com/v2/actions/${90000 + id}` }] } } };
    },
    'DELETE /droplets/5001': () => (state.droplets[5001] ? (delete state.droplets[5001], { status: 204, body: null }) : { status: 404, body: { id: 'not_found', message: 'The resource you were accessing could not be found.' } }),
  };
  const fetchImpl = async (url, o = {}) => {
    const path = url.replace('https://api.digitalocean.com/v2', '');
    const method = o.method || 'GET';
    const key = `${method} ${path}`;
    log.push(key);
    let handler = routes[key];
    // dynamic routes
    if (!handler && method === 'GET' && /^\/actions\/\d+$/.test(path)) {
      handler = () => ({ action: { id: Number(path.split('/')[2]), status: state.actionStatus || 'completed' } });
    }
    if (!handler && method === 'GET' && /^\/droplets\/\d+$/.test(path)) {
      const id = Number(path.split('/')[2]);
      handler = () => {
        if (!state.droplets[id]) return { status: 404, body: { id: 'not_found', message: 'not found' } };
        state.polls += 1;
        if (state.polls >= (state.activeAfterPolls ?? 2)) state.droplets[id].status = 'active';
        return { droplet: droplet(id) };
      };
    }
    if (!handler && method === 'GET' && path.startsWith('/droplets?tag_name=')) {
      const tag = decodeURIComponent(path.split('tag_name=')[1].split('&')[0]);
      handler = () => ({ droplets: Object.entries(state.droplets).filter(([, d]) => d.name === tag).map(([id]) => droplet(Number(id))) });
    }
    if (!handler) return { ok: false, status: 404, json: async () => ({ id: 'not_found', message: `no stub for ${key}` }) };
    let r;
    try { r = handler(o.body ? JSON.parse(o.body) : undefined); } catch (e) { if (e.message === 'socket hang up') throw e; throw e; }
    if (r && typeof r === 'object' && 'status' in r && 'body' in r) {
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => { if (r.body === null) throw new Error('no body'); return r.body; } };
    }
    return { ok: true, status: 200, json: async () => r ?? {} };
  };
  return { fetchImpl, log, state };
}

test('validateToken: active answers ok; 401 is unauthorized; a locked account is refused with its message', async () => {
  const { fetchImpl, state } = fakeDigitalOcean();
  const c = new DigitalOceanClient('t', { fetchImpl });
  assert.deepEqual(await c.validateToken(), { ok: true });
  state.accountStatus = 'locked'; state.statusMessage = 'Please contact support';
  const r = await c.validateToken();
  assert.equal(r.ok, false);
  assert.match(r.reason, /locked: Please contact support/);
  const bad = new DigitalOceanClient('t', { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ id: 'Unauthorized', message: 'Unable to authenticate you' }) }) });
  assert.deepEqual(await bad.validateToken(), { ok: false, reason: 'unauthorized' });
});

test('catalogues: regions become locations with a country, only available Basic sizes, memory in GB, one USD price per selling region', async () => {
  const { fetchImpl, log } = fakeDigitalOcean();
  const c = new DigitalOceanClient('t', { fetchImpl });
  const locs = await c.listLocations();
  assert.deepEqual(locs, [{ name: 'syd1', city: 'Sydney', country: 'AU' }, { name: 'nyc3', city: 'New York', country: 'US' }], 'the unavailable region is dropped');
  const types = await c.listServerTypes();
  assert.deepEqual(types.map((t) => t.name), ['s-2vcpu-4gb', 's-4vcpu-8gb', 's-8vcpu-16gb'], 'no CPU-optimised, no unavailable');
  const std = types.find((t) => t.name === 's-4vcpu-8gb');
  assert.equal(std.memoryGb, 8);
  assert.equal(std.cores, 4);
  assert.equal(std.diskGb, 160);
  assert.deepEqual(std.prices, { syd1: 48, nyc3: 48 });
  assert.equal(std.id, std.name, 'the id IS the slug, which is what availability lists');
  const avail = await c.listAvailability();
  assert.deepEqual(avail.syd1, ['s-2vcpu-4gb', 's-4vcpu-8gb']);
  assert.equal(log.filter((k) => k.startsWith('GET /regions')).length, 1, 'regions are read once and cached');
});

test('ensureSshKey: created once, then the 422 on a re-run resolves to the same id by key body', async () => {
  const { fetchImpl } = fakeDigitalOcean();
  const c = new DigitalOceanClient('t', { fetchImpl });
  const id = await c.ensureSshKey('demo-owner', PUB);
  assert.equal(id, 700);
  assert.equal(await c.ensureSshKey('demo-owner-again', PUB), 700);
  await assert.rejects(c.ensureSshKey('other', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTHERKEYBODY000000000000000000000000000 x@y').then(() => {
    // a different key is simply created; force the conflict path with a stub that 422s everything
  }).then(async () => {
    const stub = async (url, o = {}) => (o.method === 'POST'
      ? { ok: false, status: 422, json: async () => ({ id: 'unprocessable_entity', message: 'SSH Key is already in use on your account' }) }
      : { ok: true, status: 200, json: async () => ({ ssh_keys: [] }) });
    await new DigitalOceanClient('t', { fetchImpl: stub }).ensureSshKey('x', PUB);
  }), /no matching key/);
});

test('full run through the engine on DigitalOcean: validate -> key -> create -> running; state names the provider, never the token', async () => {
  const { fetchImpl, log } = fakeDigitalOcean();
  const client = new DigitalOceanClient('tok-secret', { fetchImpl });
  const state = {};
  const steps = [];
  const r = await provisionSelfHost({
    token: 'tok-secret', boxName: 'demo', ownerPubKey: PUB, state, provider: 'digitalocean',
    onStep: (s, d) => steps.push(d ? `${s} (${d})` : s),
    overrides: { client, image: 'ghcr.io/x/crads-pebble:v2', sleep: async () => {} },
  });
  assert.equal(r.ip, '203.0.113.42', 'the public v4 address, read once the droplet is active');
  assert.equal(r.serverId, 5001);
  assert.equal(steps[2], 'create-server (s-4vcpu-8gb @ syd1)', 'DigitalOcean defaults, not Hetzner ones');
  assert.equal(state.provider, 'digitalocean');
  assert.ok(!JSON.stringify(state).includes('tok-secret'));
  assert.ok(log.includes('POST /droplets'));
  assert.ok(log.some((k) => k.startsWith('GET /actions/')), 'the create action was awaited');
  assert.ok(log.filter((k) => k.startsWith('GET /droplets/5001')).length >= 2, 'polled until active');
});

test('a create whose answer was lost is adopted by tag, never doubled', async () => {
  const { fetchImpl, log, state } = fakeDigitalOcean([], { dropCreate: true });
  const c = new DigitalOceanClient('t', { fetchImpl });
  const r = await c.createServer({ name: 'aios-demo', serverType: 's-4vcpu-8gb', location: 'syd1', sshKeyIds: [7], userData: `#cloud-config\n# ${PUB}\n` });
  assert.equal(r.id, state.lost, 'the droplet the dropped request made');
  assert.equal(r.actionId, null, 'no action to wait on; the engine polls the droplet instead');
  assert.equal(log.filter((k) => k === 'POST /droplets').length, 1, 'the create was NOT retried');
  assert.ok(log.some((k) => k.startsWith('GET /droplets?tag_name=aios-demo')));
});

test('a create whose answer was lost and left nothing behind is reported, not invented', async () => {
  const fetchImpl = async (url, o = {}) => {
    if (o.method === 'POST') throw new Error('socket hang up');
    return { ok: true, status: 200, json: async () => ({ droplets: [] }) };
  };
  const c = new DigitalOceanClient('t', { fetchImpl });
  await assert.rejects(c.createServer({ name: 'aios-x', serverType: 's', location: 'l', sshKeyIds: [1], userData: 'x' }), /network failure/);
});

test('user_data over 64 KiB is refused before any request', async () => {
  const log = [];
  const c = new DigitalOceanClient('t', { fetchImpl: async (u) => { log.push(u); return { ok: true, status: 200, json: async () => ({}) }; } });
  await assert.rejects(c.createServer({ name: 'aios-x', serverType: 's', location: 'l', sshKeyIds: [1], userData: 'x'.repeat(USER_DATA_LIMIT + 1) }), /64 KiB/);
  assert.equal(log.length, 0);
});

test('waitAction: completed returns, errored throws; getServer maps new/active/off; delete tolerates 404', async () => {
  const { fetchImpl, state } = fakeDigitalOcean([], { activeAfterPolls: 99 });
  const c = new DigitalOceanClient('t', { fetchImpl });
  assert.equal((await c.waitAction(90001)).status, 'completed');
  state.actionStatus = 'errored';
  await assert.rejects(c.waitAction(90001), /errored/);
  state.droplets[5001] = { name: 'aios-demo', status: 'new' };
  assert.equal((await c.getServer(5001)).status, 'starting');
  state.droplets[5001].status = 'active';
  assert.deepEqual(await c.getServer(5001), { id: 5001, name: 'aios-demo', status: 'running', ip: '203.0.113.42' });
  state.droplets[5001].status = 'off';
  assert.equal((await c.getServer(5001)).status, 'off');
  await c.deleteServer(5001);
  await c.deleteServer(5001); // already gone: not an error
});

test('destroy through the engine uses the provider the state names, without being told', async () => {
  const { fetchImpl, log, state } = fakeDigitalOcean();
  state.droplets[5001] = { name: 'aios-demo', status: 'active' };
  const client = new DigitalOceanClient('t', { fetchImpl });
  const st = { provider: 'digitalocean', serverId: 5001, tokenValidated: true, sshKeyId: 700 };
  const r = await destroySelfHost({ token: 't', state: st, client });
  assert.equal(r.destroyed, true);
  assert.ok(log.includes('DELETE /droplets/5001'));
  assert.equal(st.provider, 'digitalocean', 'the provider survives a destroy; only server fields clear');
});

test('a state started on one provider refuses to resume on the other', async () => {
  const { fetchImpl } = fakeDigitalOcean();
  const client = new DigitalOceanClient('t', { fetchImpl });
  const state = { provider: 'hetzner', tokenValidated: true, sshKeyId: 7, serverId: 101 };
  await assert.rejects(
    provisionSelfHost({ token: 't', boxName: 'demo', ownerPubKey: PUB, state, provider: 'digitalocean', overrides: { client } }),
    /started on Hetzner, not DigitalOcean/,
  );
  assert.equal(state.provider, 'hetzner', 'and does not overwrite the record');
});
