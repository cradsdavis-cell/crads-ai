// digitalocean.test.mjs: the DigitalOcean client against a stubbed API.
// Nothing here reaches the network; the fetch stub IS the API, and its shapes
// are the ones read from DigitalOcean's OpenAPI spec on 2026-09-09.
//   node --test wizard/provision/digitalocean.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DigitalOceanClient, USER_DATA_LIMIT, RUN_TAG_RE } from './digitalocean.mjs';
import { provisionSelfHost, destroySelfHost } from './engine.mjs';

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF6zXyq1x2Qq0m7T3v9m4T8u5X6a7B8c9D0e1F2g3H4i owner@wizard';

// The routing table mirrors engine.test's fakeHetzner: key = "METHOD /path",
// handler(body) -> body, {status} for an error. `state` lets a test flip the
// droplet from new to active between polls.
export function fakeDigitalOcean(log = [], opts = {}) {
  const state = { droplets: {}, keys: [], polls: 0, ...opts };
  let nextId = 5001;
  const droplet = (id) => ({
    id, name: state.droplets[id].name, status: state.droplets[id].status, tags: state.droplets[id].tags || [],
    networks: { v4: state.droplets[id].status === 'active'
      ? [{ ip_address: '10.1.1.1', type: 'private' }, { ip_address: '203.0.113.42', type: 'public' }]
      : [] },
  });
  const routes = {
    'GET /account': () => ({ account: { status: state.accountStatus || 'active', status_message: state.statusMessage || '', droplet_limit: state.dropletLimit ?? 10, email: 'x@example.com' } }),
    // A count only: meta.total, and at most one droplet the client never reads.
    'GET /droplets?per_page=1': () => (state.countForbidden
      ? { status: 403, body: { id: 'forbidden', message: 'You are not authorized to perform this operation' } }
      : { droplets: [], meta: { total: Object.keys(state.droplets).length } }),
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
      assert.equal(body.tags.length, 2, 'the name tag and the run tag, nothing else');
      assert.equal(body.tags[0], body.name, 'the name tag, so the person can find it in their console');
      assert.match(body.tags[1], RUN_TAG_RE, 'a run tag minted for this create');
      assert.equal(body.with_droplet_agent, false);
      state.createdTags = body.tags;
      if (state.createRefusal) return state.createRefusal;
      if (state.dropCreate) { state.dropCreate = false; state.droplets[nextId] = { name: body.name, status: 'new', tags: body.tags }; state.lost = nextId++; throw new Error('socket hang up'); }
      const id = nextId++;
      state.droplets[id] = { name: body.name, status: 'new', tags: body.tags };
      return { status: 202, body: { droplet: droplet(id), links: { actions: [{ id: 90000 + id, rel: 'create', href: `https://api.digitalocean.com/v2/actions/${90000 + id}` }] } } };
    },
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
    if (!handler && method === 'DELETE' && /^\/droplets\/\d+$/.test(path)) {
      const id = Number(path.split('/')[2]);
      handler = () => (state.droplets[id] ? (delete state.droplets[id], { status: 204, body: null }) : { status: 404, body: { id: 'not_found', message: 'The resource you were accessing could not be found.' } });
    }
    if (!handler && method === 'GET' && path.startsWith('/droplets?tag_name=')) {
      const tag = decodeURIComponent(path.split('tag_name=')[1].split('&')[0]);
      handler = () => ({ droplets: Object.entries(state.droplets).filter(([, d]) => (d.tags || []).includes(tag)).map(([id]) => droplet(Number(id))) });
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
  assert.equal(steps[2], 'create-server (s-2vcpu-4gb @ syd1)', 'DigitalOcean defaults (Standard is 4 GB since 2026-10-15), not Hetzner ones');
  assert.equal(state.provider, 'digitalocean');
  assert.ok(!JSON.stringify(state).includes('tok-secret'));
  assert.ok(log.includes('POST /droplets'));
  assert.ok(log.some((k) => k.startsWith('GET /actions/')), 'the create action was awaited');
  assert.ok(log.filter((k) => k.startsWith('GET /droplets/5001')).length >= 2, 'polled until active');
});

test('a create whose answer was lost is adopted by its RUN tag, never doubled, never a look-alike', async () => {
  // Worst case on the person's account: an older droplet with the same name
  // and the same old-style name tag (an earlier run, or another computer).
  const { fetchImpl, log, state } = fakeDigitalOcean([], { dropCreate: true, droplets: { 4242: { name: 'aios-demo', status: 'active', tags: ['aios-demo'] } } });
  const c = new DigitalOceanClient('t', { fetchImpl });
  const r = await c.createServer({ name: 'aios-demo', serverType: 's-4vcpu-8gb', location: 'syd1', sshKeyIds: [7], userData: `#cloud-config\n# ${PUB}\n` });
  assert.equal(r.id, state.lost, 'the droplet the dropped request made');
  assert.notEqual(r.id, 4242, 'not the older droplet that shares its name and name tag');
  assert.equal(r.runTag, state.createdTags[1]);
  assert.equal(r.actionId, null, 'no action to wait on; the engine polls the droplet instead');
  assert.equal(log.filter((k) => k === 'POST /droplets').length, 1, 'the create was NOT retried');
  assert.ok(log.some((k) => k === `GET /droplets?tag_name=${r.runTag}&per_page=10`), 'looked up by the run tag');
  assert.ok(!log.some((k) => k.startsWith('GET /droplets?tag_name=aios-')), 'never by the name tag');
});

test('a lost answer with two droplets on the run tag adopts neither', async () => {
  const runTag = 'crads-run-0123456789abcdef';
  const { fetchImpl, state } = fakeDigitalOcean([], { dropCreate: true, droplets: { 4243: { name: 'x', status: 'active', tags: [runTag] } } });
  const c = new DigitalOceanClient('t', { fetchImpl });
  await assert.rejects(
    c.createServer({ name: 'aios-demo', serverType: 's', location: 'syd1', sshKeyIds: [7], userData: `# ${PUB}`, runTag }),
    (e) => e.code === 'run_tag_ambiguous',
  );
  assert.ok(state.droplets[4243], 'untouched');
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
  state.droplets[5001] = { name: 'aios-demo', status: 'new', tags: ['aios-demo'] }; // a pre-run-tag build
  assert.equal((await c.getServer(5001)).status, 'starting');
  state.droplets[5001].status = 'active';
  assert.deepEqual(await c.getServer(5001), { id: 5001, name: 'aios-demo', status: 'running', ip: '203.0.113.42' });
  state.droplets[5001].status = 'off';
  assert.equal((await c.getServer(5001)).status, 'off');
  await c.deleteServer(5001); // a record from before run tags: the old self-tag is the mark
  await c.deleteServer(5001); // already gone: not an error
});

test('destroy through the engine uses the provider the state names, without being told', async () => {
  const { fetchImpl, log, state } = fakeDigitalOcean();
  state.droplets[5001] = { name: 'aios-demo', status: 'active', tags: ['aios-demo', 'crads-run-00000000000000aa'] };
  const client = new DigitalOceanClient('t', { fetchImpl });
  const st = { provider: 'digitalocean', serverId: 5001, tokenValidated: true, sshKeyId: 700, runTag: 'crads-run-00000000000000aa' };
  const r = await destroySelfHost({ token: 't', state: st, client });
  assert.equal(r.destroyed, true);
  assert.ok(log.includes('DELETE /droplets/5001'));
  assert.equal(st.provider, 'digitalocean', 'the provider survives a destroy; only server fields clear');
  assert.equal(st.runTag, undefined, 'the run tag goes with the server');
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

// ---- Only our own droplets (2026-10-19). A member who already had a droplet
// read the build as trying to override it. These pin that nothing here can
// act on a droplet the app did not make.

const PERSON = { 4242: { name: 'my-website', status: 'active', tags: ['prod'] } };

test('a full build on an account that already has a droplet never reads, matches or touches it', async () => {
  const { fetchImpl, log, state } = fakeDigitalOcean([], { droplets: structuredClone(PERSON) });
  const client = new DigitalOceanClient('t', { fetchImpl });
  const st = {};
  const r = await provisionSelfHost({ token: 't', boxName: 'demo', ownerPubKey: PUB, state: st, provider: 'digitalocean', overrides: { client, sleep: async () => {} } });
  assert.notEqual(r.serverId, 4242, 'a new droplet, not theirs');
  assert.ok(!log.some((k) => k.includes('4242')), 'their droplet id never appears in a request');
  assert.ok(!log.some((k) => /^(PUT|PATCH|DELETE) /.test(k) || /\/actions$/.test(k)), 'no update, rename, rebuild or delete call of any kind');
  assert.deepEqual(state.droplets[4242], PERSON[4242], 'theirs is exactly as it was');
  assert.match(st.runTag, RUN_TAG_RE, 'the build record carries the run tag');
  assert.equal(st.runTag, state.createdTags[1]);
});

test('delete refuses a droplet that does not carry the record\'s run tag, and changes nothing', async () => {
  const { fetchImpl, log, state } = fakeDigitalOcean([], { droplets: { ...structuredClone(PERSON), 5001: { name: 'aios-demo', status: 'active', tags: ['aios-demo', 'crads-run-00000000000000bb'] } } });
  const c = new DigitalOceanClient('t', { fetchImpl });
  // A record pointing at the person's own droplet (corrupt, hand-edited, or
  // an id that is not ours for any reason): refused with or without a tag.
  for (const st of [{ provider: 'digitalocean', serverId: 4242, runTag: 'crads-run-00000000000000bb' }, { provider: 'digitalocean', serverId: 4242 }]) {
    await assert.rejects(destroySelfHost({ token: 't', state: st, client: c }), (e) => e.code === 'not_ours' && /has not deleted it/.test(e.message) && /my-website/.test(e.message));
    assert.equal(st.serverId, 4242, 'the record is left as it was');
  }
  // Our droplet, but the record names another run's tag: refused too.
  await assert.rejects(c.deleteServer(5001, { runTag: 'crads-run-00000000000000cc' }), (e) => e.code === 'not_ours');
  assert.ok(!log.some((k) => k.startsWith('DELETE ')), 'no delete was sent');
  assert.ok(state.droplets[4242] && state.droplets[5001]);
  // The right tag deletes.
  await c.deleteServer(5001, { runTag: 'crads-run-00000000000000bb' });
  assert.ok(!state.droplets[5001] && state.droplets[4242]);
});

test('a full account is told so in plain words before anything is made', async () => {
  const { fetchImpl, log, state } = fakeDigitalOcean([], { droplets: structuredClone(PERSON), dropletLimit: 1 });
  const c = new DigitalOceanClient('t', { fetchImpl });
  const v = await c.validateToken();
  assert.equal(v.ok, false);
  assert.equal(v.plain, true, 'member-facing words, shown as they are');
  assert.match(v.reason, /allows 1 droplet and already has 1/);
  assert.match(v.reason, /never changes or deletes the ones you already have/);
  assert.match(v.reason, /Nothing has been changed/);
  assert.doesNotMatch(v.reason, /\u2014/, 'no em dashes in member copy');
  // Through the engine: the same words, not "Could not reach DigitalOcean".
  await assert.rejects(
    provisionSelfHost({ token: 't', boxName: 'demo', ownerPubKey: PUB, state: {}, provider: 'digitalocean', overrides: { client: c } }),
    (e) => /^Your DigitalOcean account allows 1 droplet/.test(e.message),
  );
  assert.ok(!log.includes('POST /droplets') && !log.includes('POST /account/keys'), 'nothing was made');
  // Room left, or a count the token may not read: no refusal on that account.
  state.dropletLimit = 2;
  assert.deepEqual(await c.validateToken(), { ok: true });
  state.dropletLimit = 1; state.countForbidden = true;
  assert.deepEqual(await c.validateToken(), { ok: true }, 'an unreadable count never blocks; the create maps its own refusal');
});

test('the create\'s own refusals come back in plain words: droplet limit, token scope', async () => {
  const { fetchImpl, state } = fakeDigitalOcean();
  const c = new DigitalOceanClient('t', { fetchImpl });
  const args = { name: 'aios-demo', serverType: 's-2vcpu-4gb', location: 'syd1', sshKeyIds: [7], userData: `# ${PUB}` };
  state.createRefusal = { status: 422, body: { id: 'unprocessable_entity', message: 'creating this/these droplet(s) will exceed your droplet limit' } };
  await assert.rejects(c.createServer(args), (e) => e.code === 'droplet_limit' && /^Your DigitalOcean account is at its droplet limit\./.test(e.message) && /never changes or deletes/.test(e.message));
  state.createRefusal = { status: 403, body: { id: 'forbidden', message: 'You are not authorized to perform this operation' } };
  await assert.rejects(c.createServer(args), (e) => e.code === 'forbidden' && /read and write access/.test(e.message));
  state.createRefusal = { status: 422, body: { id: 'unprocessable_entity', message: 'Region is not available' } };
  await assert.rejects(c.createServer(args), /Region is not available/, 'any other refusal is passed on as DigitalOcean said it');
});
