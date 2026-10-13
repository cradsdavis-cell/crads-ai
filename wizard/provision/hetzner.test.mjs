// hetzner.test.mjs: the Hetzner client against a stubbed API whose answers are
// shaped like the real ones, as read live on 2026-10-13. No network.
//   node --test wizard/provision/hetzner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HetznerClient } from './hetzner.mjs';

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

function stub({ datacentersGone = true } = {}) {
  const log = [];
  const bodies = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const key = `${opts.method || 'GET'} ${u.pathname.replace('/v1', '')}`;
    log.push(`${key}${u.search}`);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
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
      return ok({ server: { id: 555, public_net: { ipv4: { ip: '198.51.100.8' } } }, action: { id: 777 } });
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
