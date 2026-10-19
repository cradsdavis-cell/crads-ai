// hetzner.test.mjs: the Hetzner client against a stubbed API whose answers are
// shaped like the real ones, as read live on 2026-10-13. No network.
//   node --test wizard/provision/hetzner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HetznerClient, RUN_LABEL } from './hetzner.mjs';
import { RUN_TAG_RE } from './run-tag.mjs';
import { provisionSelfHost, destroySelfHost } from './engine.mjs';

// One server type as /v1/server_types answers it (trimmed to the fields read).
const loc = (name, available, recommended = false) => ({ id: { fsn1: 1, nbg1: 2, hel1: 3, ash: 4, hil: 5, sin: 6 }[name], name, available, recommended, deprecation: null });
const price = (location, gross) => ({ location, price_hourly: { gross: '0', net: '0' }, price_monthly: { gross: String(gross), net: String(gross) } });
const type = (id, name, architecture, cores, memory, disk, locations, eur) => ({
  id, name, architecture, cores, memory, disk, cpu_type: 'shared', deprecated: false, deprecation: null,
  locations, prices: locations.map((l) => price(l.name, eur)),
});

const PAGE1 = [
  type(93, 'cax21', 'arm', 4, 8, 80, [loc('fsn1', true), loc('nbg1', false), loc('hel1', true, true)], 10.49),
  type(94, 'cax31', 'arm', 8, 16, 160, [loc('fsn1', false), loc('nbg1', false), loc('hel1', true, true)], 20.99),
  type(109, 'cx33', 'x86', 4, 8, 80, [loc('fsn1', false), loc('nbg1', false), loc('hel1', false)], 8.49),
];
const PAGE2 = [
  type(117, 'cpx32', 'x86', 4, 8, 160, [loc('fsn1', true), loc('nbg1', true), loc('hel1', true, true), loc('sin', true)], 35.49),
  type(23, 'cpx31', 'x86', 4, 8, 160, [loc('fsn1', false), loc('ash', true), loc('hil', true)], 17.49),
  { ...type(9, 'cx31', 'x86', 2, 8, 80, [loc('nbg1', true)], 5), deprecated: true, deprecation: { announced: '2024-06-06T00:00:00Z', unavailable_after: '2024-09-06T00:00:00Z' } },
];
const IMAGES = [
  { id: 161547269, name: 'ubuntu-24.04', architecture: 'x86', type: 'system', status: 'available', deprecated: null },
  { id: 161547270, name: 'ubuntu-24.04', architecture: 'arm', type: 'system', status: 'available', deprecated: null },
];

// `servers` is the person's project: id -> { name, labels, status }. The
// handlers below answer the server reads, the label lookup, the delete, the
// key upload and the create action the way Hetzner does.
function stub({ datacentersGone = true, servers = {}, dropCreate = false } = {}) {
  const log = [];
  const bodies = [];
  let nextId = 555;
  const server = (id) => ({ id, name: servers[id].name, status: servers[id].status || 'running', labels: servers[id].labels || {}, public_net: { ipv4: { ip: `198.51.100.${id % 250}` } } });
  const err = (status, code, message) => ({ ok: false, status, json: async () => ({ error: { code, message } }) });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const key = `${opts.method || 'GET'} ${u.pathname.replace('/v1', '')}`;
    log.push(`${key}${u.search}`);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    const byId = key.match(/^(GET|DELETE) \/servers\/(\d+)$/);
    if (byId) {
      const id = Number(byId[2]);
      if (!servers[id]) return err(404, 'not_found', 'server not found');
      if (byId[1] === 'DELETE') { delete servers[id]; return ok({ action: { id: 900, status: 'running' } }); }
      return ok({ server: server(id) });
    }
    if (key === 'GET /servers') {
      const sel = u.searchParams.get('label_selector');
      const [k, v] = String(sel || '').split('=');
      return ok({ servers: Object.keys(servers).map(Number).filter((id) => (servers[id].labels || {})[k] === v).map(server) });
    }
    if (key === 'POST /ssh_keys') return ok({ ssh_key: { id: 700 } });
    if (/^GET \/actions\/\d+$/.test(key)) return ok({ action: { id: 777, status: 'success' } });
    if (key === 'GET /server_types') {
      const page = Number(u.searchParams.get('page') || 1);
      const next = page === 1 ? 2 : null;
      return ok({ server_types: page === 1 ? PAGE1 : PAGE2, meta: { pagination: { page, per_page: 50, next_page: next, last_page: 2, total_entries: 6 } } });
    }
    if (key === 'GET /datacenters' && datacentersGone) {
      // what Hetzner answers since its 2026-06-02 changelog
      return { ok: false, status: 410, json: async () => ({ error: { code: 'deprecated_api_endpoint', message: 'API functionality was removed' } }) };
    }
    if (key === 'GET /images') {
      const arch = u.searchParams.get('architecture');
      const name = u.searchParams.get('name');
      return ok({ images: IMAGES.filter((i) => (!arch || i.architecture === arch) && (!name || i.name === name)) });
    }
    if (key === 'POST /servers') {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      // Hetzner server names are unique per project: a retry of a create that
      // landed answers 409, exactly as it would live.
      if (Object.values(servers).some((x) => x.name === body.name)) return err(409, 'uniqueness_error', 'server name is already used');
      const id = nextId++;
      servers[id] = { name: body.name, labels: body.labels || {}, status: 'running' };
      if (dropCreate) { dropCreate = false; throw new Error('socket hang up'); }
      return ok({ server: { id, public_net: { ipv4: { ip: '198.51.100.8' } } }, action: { id: 777 } });
    }
    return { ok: false, status: 404, json: async () => ({ error: { code: 'not_found', message: `no stub for ${key}` } }) };
  };
  return { fetchImpl, log, bodies };
}

test('listAvailability reads /server_types locations[].available and never /datacenters', async () => {
  const s = stub();
  const c = new HetznerClient('t', { fetchImpl: s.fetchImpl });
  const a = await c.listAvailability();
  assert.deepEqual(a, { fsn1: [93, 117], hel1: [93, 94, 117], nbg1: [117], sin: [117], ash: [23], hil: [23] });
  assert.ok(!a.nbg1.includes(93), 'cax21 is not sold in nbg1');
  assert.ok(!Object.values(a).flat().includes(109), 'cx33, sold nowhere, is in no location');
  assert.ok(!Object.values(a).flat().includes(9), 'a deprecated type is in no location');
  assert.ok(!s.log.some((l) => l.startsWith('GET /datacenters')), 'the removed endpoint is never called');
});

test('the catalogue walks every page and is fetched once per client', async () => {
  const s = stub();
  const c = new HetznerClient('t', { fetchImpl: s.fetchImpl });
  const types = await c.listServerTypes();
  await c.listAvailability();
  assert.deepEqual(types.map((t) => t.name), ['cax21', 'cax31', 'cx33', 'cpx32', 'cpx31'], 'both pages, deprecated cx31 dropped');
  const cax21 = types.find((t) => t.name === 'cax21');
  assert.equal(cax21.arch, 'arm');
  assert.equal(cax21.memoryGb, 8);
  assert.equal(cax21.prices.hel1, 10.49);
  assert.equal(s.log.filter((l) => l.startsWith('GET /server_types')).length, 2, 'two pages, read once between them');
});

test('an Arm create sends the arm build of the image, an x86 create the x86 build', async () => {
  const s = stub();
  const c = new HetznerClient('t', { fetchImpl: s.fetchImpl });
  await c.createServer({ name: 'aios-a', serverType: 'cax21', location: 'hel1', sshKeyIds: [7], userData: '#cloud-config' });
  await c.createServer({ name: 'aios-b', serverType: 'cpx32', location: 'nbg1', sshKeyIds: [7], userData: '#cloud-config' });
  assert.equal(s.bodies[0].image, 161547270, 'arm id for cax21');
  assert.equal(s.bodies[1].image, 161547269, 'x86 id for cpx32');
  assert.ok(s.log.some((l) => l.includes('/images?') && l.includes('architecture=arm') && l.includes('name=ubuntu-24.04')));
});

test('an image id is sent as given; an unknown type falls back to the name for Hetzner to judge', async () => {
  const s = stub();
  const c = new HetznerClient('t', { fetchImpl: s.fetchImpl });
  await c.createServer({ name: 'aios-c', serverType: 'cax21', location: 'hel1', image: 42, sshKeyIds: [7], userData: '' });
  await c.createServer({ name: 'aios-d', serverType: 'zz99', location: 'hel1', sshKeyIds: [7], userData: '' });
  assert.equal(s.bodies[0].image, 42);
  assert.equal(s.bodies[1].image, 'ubuntu-24.04');
});

test('no build of the image for that architecture is a clear error, not a wrong-arch server', async () => {
  const s = stub();
  const c = new HetznerClient('t', { fetchImpl: s.fetchImpl });
  await assert.rejects(
    c.createServer({ name: 'aios-e', serverType: 'cax21', location: 'hel1', image: 'debian-13', sshKeyIds: [7], userData: '' }),
    (e) => e.code === 'image_not_found' && /arm/.test(e.message),
  );
  assert.equal(s.bodies.length, 0, 'nothing was created');
});

// ---- Only our own servers (2026-10-19, the rule DigitalOcean got the same
// day). The person's project may hold servers the app has nothing to do with;
// these pin that nothing here can act on one.

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF6zXyq1x2Qq0m7T3v9m4T8u5X6a7B8c9D0e1F2g3H4i owner@test';
const PERSON = () => ({ 4242: { name: 'my-website', labels: { env: 'prod' }, status: 'running' } });
const noRetrySleep = () => { const real = globalThis.setTimeout; globalThis.setTimeout = (fn) => real(fn, 0); return () => { globalThis.setTimeout = real; }; };

test('every create carries a run label minted for it, and answers the run tag for the record', async () => {
  const s = stub();
  const c = new HetznerClient('t', { fetchImpl: s.fetchImpl });
  const a = await c.createServer({ name: 'aios-a', serverType: 'cax21', location: 'hel1', sshKeyIds: [7], userData: '' });
  const b = await c.createServer({ name: 'aios-b', serverType: 'cax21', location: 'hel1', sshKeyIds: [7], userData: '' });
  assert.match(a.runTag, RUN_TAG_RE);
  assert.notEqual(a.runTag, b.runTag, 'one per create');
  assert.deepEqual(s.bodies[0].labels, { [RUN_LABEL]: a.runTag.slice('crads-run-'.length) }, 'the label, nothing else');
  await assert.rejects(c.createServer({ name: 'aios-c', serverType: 'cax21', location: 'hel1', sshKeyIds: [7], userData: '', runTag: 'aios-c' }), (e) => e.code === 'bad_run_tag');
});

test('a full build on a project that already has a server never reads, matches or touches it', async () => {
  const servers = PERSON();
  const s = stub({ servers });
  const client = new HetznerClient('t', { fetchImpl: s.fetchImpl });
  const st = {};
  const r = await provisionSelfHost({ token: 't', boxName: 'demo', ownerPubKey: PUB, state: st, provider: 'hetzner', overrides: { client, serverType: 'cax21', location: 'hel1', sleep: async () => {} } });
  assert.notEqual(r.serverId, 4242, 'a new server, not theirs');
  assert.ok(!s.log.some((k) => k.includes('4242')), 'their server id never appears in a request');
  assert.ok(!s.log.some((k) => /^(PUT|PATCH|DELETE) /.test(k) || /^POST \/servers\/\d+\/actions/.test(k)), 'no update, rename, rebuild or delete call of any kind');
  assert.deepEqual(servers[4242], PERSON()[4242], 'theirs is exactly as it was');
  assert.match(st.runTag, RUN_TAG_RE, 'the build record carries the run tag');
  assert.equal(servers[r.serverId].labels[RUN_LABEL], st.runTag.slice('crads-run-'.length));
});

test('a create whose answer was lost is adopted by its RUN label, never a look-alike of the same name', async () => {
  const restore = noRetrySleep();
  try {
    // The dropped socket is retried; the retry meets Hetzner's name 409; the
    // client then looks up THIS create's label and adopts what carries it.
    const servers = PERSON();
    const s = stub({ servers, dropCreate: true });
    const c = new HetznerClient('t', { fetchImpl: s.fetchImpl });
    const runTag = 'crads-run-00000000000000cc';
    const r = await c.createServer({ name: 'aios-demo', serverType: 'cax21', location: 'hel1', sshKeyIds: [7], userData: '', runTag });
    assert.equal(r.id, 555);
    assert.equal(r.runTag, runTag);
    assert.equal(s.bodies.length, 2, 'the blind retry, which met the 409');
    assert.equal(Object.keys(servers).length, 2, 'theirs and ours: never doubled');
    assert.ok(s.log.includes(`GET /servers?label_selector=${encodeURIComponent(`${RUN_LABEL}=00000000000000cc`)}&per_page=10`), 'looked up by the run label');
    assert.ok(!s.log.some((k) => k.startsWith('GET /servers?name=')), 'never by name');

    // Same 409, but the server of that name is an older one without this
    // create's label (an earlier run, another computer): nothing is adopted,
    // and Hetzner's own refusal stands.
    const older = { 4300: { name: 'aios-demo', labels: { [RUN_LABEL]: '00000000000000aa' } } };
    const s2 = stub({ servers: older });
    const c2 = new HetznerClient('t', { fetchImpl: s2.fetchImpl });
    await assert.rejects(c2.createServer({ name: 'aios-demo', serverType: 'cax21', location: 'hel1', sshKeyIds: [7], userData: '', runTag }), (e) => e.code === 'uniqueness_error');
    assert.ok(!s2.log.some((k) => k.includes('4300')), 'the older server is never read or touched');
  } finally { restore(); }
});

test('a lost answer with two servers on the run label adopts neither', async () => {
  const restore = noRetrySleep();
  try {
    const runTag = 'crads-run-0123456789abcdef';
    const servers = { 4243: { name: 'x', labels: { [RUN_LABEL]: '0123456789abcdef' } } };
    const s = stub({ servers, dropCreate: true });
    const c = new HetznerClient('t', { fetchImpl: s.fetchImpl });
    await assert.rejects(c.createServer({ name: 'aios-demo', serverType: 'cax21', location: 'hel1', sshKeyIds: [7], userData: '', runTag }), (e) => e.code === 'run_tag_ambiguous');
    assert.ok(servers[4243], 'untouched');
  } finally { restore(); }
});

test('delete refuses a server that does not carry the record\'s run label, and changes nothing', async () => {
  const servers = { ...PERSON(), 5001: { name: 'aios-demo', labels: { [RUN_LABEL]: '00000000000000bb' } } };
  const s = stub({ servers });
  const c = new HetznerClient('t', { fetchImpl: s.fetchImpl });
  // A record pointing at the person's own server (corrupt, hand-edited, or an
  // id that is not ours for any reason): refused with or without a run tag.
  for (const st of [{ provider: 'hetzner', serverId: 4242, runTag: 'crads-run-00000000000000bb' }, { provider: 'hetzner', serverId: 4242 }]) {
    await assert.rejects(destroySelfHost({ token: 't', state: st, client: c }), (e) => e.code === 'not_ours' && /has not deleted it/.test(e.message) && /my-website/.test(e.message));
    assert.equal(st.serverId, 4242, 'the record is left as it was');
  }
  // Ours but a different run's label: refused too.
  await assert.rejects(c.deleteServer(5001, { runTag: 'crads-run-00000000000000ff' }), (e) => e.code === 'not_ours');
  assert.ok(!s.log.some((k) => k.startsWith('DELETE ')), 'no delete was sent');
  assert.deepEqual(servers[4242], PERSON()[4242]);
  assert.ok(servers[5001]);

  // The record's own label: deleted, and the record forgets it.
  const st = { provider: 'hetzner', serverId: 5001, runTag: 'crads-run-00000000000000bb' };
  assert.deepEqual(await destroySelfHost({ token: 't', state: st, client: c }), { destroyed: true });
  assert.equal(servers[5001], undefined);
  assert.equal(st.runTag, undefined, 'the run tag goes with the server');
  // Already gone is the outcome wanted.
  await c.deleteServer(5001, { runTag: 'crads-run-00000000000000bb' });
});

test('a record from before run labels deletes only a server named aios-', async () => {
  const servers = { 6001: { name: 'aios-old' }, 6002: { name: 'database' } };
  const s = stub({ servers });
  const c = new HetznerClient('t', { fetchImpl: s.fetchImpl });
  await c.deleteServer(6001);
  assert.equal(servers[6001], undefined);
  await assert.rejects(c.deleteServer(6002), (e) => e.code === 'not_ours');
  assert.ok(servers[6002]);
});
