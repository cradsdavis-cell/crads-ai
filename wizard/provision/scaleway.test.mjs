// scaleway.test.mjs: the Scaleway client against a stubbed API. Nothing here
// reaches the network; the fetch stub IS the API. Shapes were read from
// Scaleway's published OpenAPI specs (Instance v1, IAM v1alpha1, Block v1,
// Marketplace v2) on 2026-10-14; the Marketplace local images and the fr-par-2
// prices are copied from the public (no-account) Marketplace and Product
// Catalog answers of the same day.
//   node --test wizard/provision/scaleway.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ScalewayClient, ScalewayError, parseCredentials, USER_DATA_LIMIT, ROOT_VOLUME_BYTES, ZONE, TAG,
} from './scaleway.mjs';
import { provisionSelfHost, destroySelfHost } from './engine.mjs';

const SECRET = '11111111-2222-4333-8444-555555555555';
const PROJECT = '6170692e-7363-616c-6577-61792e636f6d';
const CREDS = JSON.stringify({ secretKey: SECRET, projectId: PROJECT });
const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF6zXyq1x2Qq0m7T3v9m4T8u5X6a7B8c9D0e1F2g3H4i owner@wizard';
const ARM_IMG = 'b8a50ea4-1947-48af-9806-09bef7444877'; // ubuntu_noble arm64 instance_sbs, fr-par-2
const X86_IMG = '60fd3002-c87f-4156-9588-e84022e3595a'; // ubuntu_noble x86_64 instance_sbs, fr-par-2
const GiB = 2 ** 30;
const nosleep = async () => {};

// products/servers entries, trimmed to the fields read; hourly prices are the
// fr-par-2 list prices of 2026-10-14.
const ptype = (hourly, ncpus, ramGiB, arch, extra = {}) => ({
  hourly_price: hourly, monthly_price: Math.round(hourly * 720 * 100) / 100, ncpus, ram: ramGiB * GiB, arch, gpu: 0,
  end_of_service: false, volumes_constraint: { min_size: 0, max_size: 0 },
  per_volume_constraint: { l_ssd: { min_size: 0, max_size: 0 } }, capabilities: { block_storage: true }, ...extra,
});
const PRODUCTS = {
  'BASIC2-A2C-4G': ptype(0.023, 2, 4, 'arm64'),
  'BASIC2-A2C-8G': ptype(0.0345, 2, 8, 'arm64'),
  'BASIC2-A4C-16G': ptype(0.0689, 4, 16, 'arm64'),
  'PLAY2-NANO': ptype(0.02754, 2, 4, 'x86_64'),
  'PLAY2-MICRO': ptype(0.05508, 4, 8, 'x86_64'),
  'PRO2-XS': ptype(0.1122, 4, 16, 'x86_64'),
  'DEV1-M': ptype(0.020196, 3, 4, 'x86_64', { per_volume_constraint: { l_ssd: { min_size: 1e9, max_size: 40e9 } } }),
  'POP2-2C-8G-WIN': ptype(0.1823, 2, 8, 'x86_64'),
  'GPU-3070-S': ptype(0.98, 8, 16, 'x86_64', { gpu: 1 }),
  'GP1-XS-OLD': ptype(0.09, 4, 16, 'x86_64', { end_of_service: true }),
};
const AVAILABILITY = {
  'BASIC2-A2C-4G': { availability: 'available' },
  'BASIC2-A2C-8G': { availability: 'scarce' },
  'BASIC2-A4C-16G': { availability: 'available' },
  'PLAY2-NANO': { availability: 'available' },
  'PLAY2-MICRO': { availability: 'shortage' },
  'PRO2-XS': { availability: 'available' },
  'DEV1-M': { availability: 'available' },
  'NOT-LISTED': { availability: 'available' },
};
const LOCAL_IMAGES = [
  { id: '78f1ed12-edae-4575-afca-a00dd5deb9bd', arch: 'x86_64', type: 'instance_local', label: 'ubuntu_noble', zone: 'fr-par-2', compatible_commercial_types: ['DEV1-M'] },
  { id: X86_IMG, arch: 'x86_64', type: 'instance_sbs', label: 'ubuntu_noble', zone: 'fr-par-2', compatible_commercial_types: ['DEV1-M', 'PRO2-XS', 'PLAY2-MICRO', 'PLAY2-NANO'] },
  { id: ARM_IMG, arch: 'arm64', type: 'instance_sbs', label: 'ubuntu_noble', zone: 'fr-par-2', compatible_commercial_types: ['BASIC2-A2C-4G', 'BASIC2-A2C-8G', 'BASIC2-A4C-16G'] },
  { id: '3c56f09f-7733-44fe-8551-7ea63cd843bf', arch: 'x86_64', type: 'instance_sbs_snapshot', label: 'ubuntu_noble', zone: 'fr-par-2', compatible_commercial_types: ['PLAY2-NANO'] },
];
const VOLUME_TYPES = [
  { type: 'sbs_5k', pricing: { currency_code: 'EUR', units: 0, nanos: 129999 }, zone: 'fr-par-2' },
  { type: 'sbs_15k', pricing: { currency_code: 'EUR', units: 0, nanos: 177000 }, zone: 'fr-par-2' },
];

/**
 * A stateful fake of the four APIs. Every call is logged as "METHOD /path?query"
 * (prefix stripped) and kept with its headers and body in `calls`.
 */
export function fakeScaleway(opts = {}) {
  const state = {
    servers: {}, keys: [], volumes: {}, tasks: {}, userData: {}, calls: [], log: [],
    runningAfterPolls: 1, goneAfterPolls: 1, detachAfterPolls: 1, products: PRODUCTS, ...opts,
  };
  let n = 0;
  const uuid = (p) => `${p}0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const ok = (body, status = 200, headers = {}) => ({ status, body, headers });
  const err = (status, type, message) => ({ status, body: { type, message } });
  const serverView = (id) => {
    const s = state.servers[id];
    return {
      id, name: s.name, state: s.state, tags: s.tags, project: PROJECT, commercial_type: s.type, creation_date: s.created,
      allowed_actions: s.state === 'running' ? ['poweroff', 'terminate', 'reboot', 'stop_in_place', 'backup'] : ['poweron', 'backup'],
      volumes: { 0: { id: s.vol, volume_type: 'sbs_volume', size: ROOT_VOLUME_BYTES, state: 'available', boot: true, zone: ZONE } },
      public_ips: s.state === 'running'
        ? [{ id: 'ip-v4', address: '51.15.0.42', family: 'inet', dynamic: true, state: 'attached' },
          { id: 'ip-v6', address: '2001:bc8::1', family: 'inet6', dynamic: false, state: 'attached' }]
        : [],
      public_ip: null, zone: ZONE, arch: 'arm64',
    };
  };
  const route = (method, path, body, headers) => {
    const [p, q = ''] = path.split('?');
    const qs = new URLSearchParams(q);
    const I = `/instance/v1/zones/${ZONE}`;
    if (state.auth === 401) return err(401, 'denied_authentication', 'authentication is denied');
    if (method === 'GET' && p === `${I}/servers` && qs.get('per_page') === '1') {
      if (state.instancesForbidden) return err(403, 'permission_denied', 'insufficient permissions');
      return ok({ servers: [] });
    }
    if (method === 'GET' && p === `${I}/servers`) {
      const name = qs.get('name');
      return ok({ servers: Object.keys(state.servers).filter((id) => state.servers[id].name.includes(name)).map(serverView) });
    }
    if (method === 'GET' && p === `/account/v3/projects/${PROJECT}`) {
      if (state.projectRead === 403) return err(403, 'permission_denied', 'insufficient permissions');
      return ok({ id: PROJECT, name: 'default', organization_id: 'org' });
    }
    if (method === 'GET' && p.startsWith('/account/v3/projects/')) return err(404, 'not_found', 'resource is not found');
    if (method === 'GET' && p === `${I}/products/servers`) {
      const entries = Object.entries(state.products);
      const page = Number(qs.get('page')); const per = Number(qs.get('per_page'));
      const slice = Object.fromEntries(entries.slice((page - 1) * per, page * per));
      return ok({ servers: slice }, 200, { 'x-total-count': String(entries.length) });
    }
    if (method === 'GET' && p === `${I}/products/servers/availability`) {
      if (state.availabilityDown) return err(500, 'internal', 'boom');
      return ok({ servers: AVAILABILITY }, 200, { 'x-total-count': String(Object.keys(AVAILABILITY).length) });
    }
    if (method === 'GET' && p === `/block/v1/zones/${ZONE}/volume-types`) return ok({ volume_types: VOLUME_TYPES, total_count: 2 });
    if (method === 'GET' && p === '/marketplace/v2/local-images') {
      return ok({ local_images: LOCAL_IMAGES.filter((li) => li.label === qs.get('image_label') && li.zone === qs.get('zone') && (!qs.get('type') || li.type === qs.get('type'))), total_count: 3 });
    }
    if (method === 'GET' && p === '/iam/v1alpha1/ssh-keys') {
      if (state.keysForbidden) return err(403, 'permission_denied', 'insufficient permissions');
      const pid = qs.get('project_id');
      const ks = state.keys.filter((k) => !pid || k.project_id === pid);
      return ok({ ssh_keys: ks, total_count: ks.length });
    }
    if (method === 'POST' && p === '/iam/v1alpha1/ssh-keys') {
      if (state.keys.some((k) => k.public_key.split(/\s+/)[1] === body.public_key.split(/\s+/)[1])) return err(409, 'resource_already_exists', 'ssh key already exists');
      const k = { id: uuid('a'), name: body.name, public_key: body.public_key, project_id: body.project_id, disabled: false, fingerprint: '256 MD5:aa' };
      state.keys.push(k);
      return ok(k);
    }
    const keyM = p.match(/^\/iam\/v1alpha1\/ssh-keys\/(.+)$/);
    if (keyM) {
      const k = state.keys.find((x) => x.id === keyM[1]);
      if (!k) return err(404, 'not_found', 'resource is not found');
      if (method === 'PATCH') { Object.assign(k, body); return ok(k); }
      if (method === 'DELETE') { state.keys = state.keys.filter((x) => x !== k); return ok(null, 204); }
    }
    if (method === 'POST' && p === `${I}/servers`) {
      const id = uuid('s'); const vol = uuid('v');
      state.servers[id] = { name: body.name, state: 'stopped', tags: body.tags, type: body.commercial_type, vol, polls: 0, created: `2026-10-14T00:00:${String(n).padStart(2, '0')}Z` };
      state.volumes[vol] = { status: 'in_use', polls: 0 };
      state.lastCreate = id;
      if (state.dropCreate) { state.dropCreate = false; throw new Error('socket hang up'); }
      return ok({ server: serverView(id) }, 201);
    }
    const sM = p.match(new RegExp(`^${I}/servers/([^/]+)(/.*)?$`));
    if (sM) {
      const [, id, rest = ''] = sM;
      const s = state.servers[id];
      if (!s) return err(404, 'not_found', 'resource is not found');
      if (method === 'GET' && rest === '') {
        s.polls += 1;
        if (s.state === 'starting' && s.polls >= state.runningAfterPolls) s.state = 'running';
        if (s.state === 'terminating' && s.polls >= state.goneAfterPolls) { delete state.servers[id]; return err(404, 'not_found', 'resource is not found'); }
        return ok({ server: serverView(id) });
      }
      if (method === 'PATCH' && rest === '/user_data/cloud-init') {
        if (state.failUserData) return err(500, 'internal', 'user data store down');
        state.userData[id] = { text: body, contentType: headers['Content-Type'] };
        return ok(null, 204);
      }
      if (method === 'POST' && rest === '/action') {
        if (body.action === 'poweron') {
          if (state.failPoweron) return err(400, 'invalid_arguments', 'quota exceeded for BASIC2');
          if (s.state !== 'stopped') return err(400, 'precondition_failed', 'server should be stopped');
          s.state = state.stayStoppedAfterPoweron ? 'stopped' : 'starting'; s.polls = 0;
          const tid = uuid('t'); state.tasks[tid] = { status: 'pending', polls: 0 };
          return ok({ task: { id: tid, description: 'server_poweron', status: 'pending', href_from: `/servers/${id}/action`, href_result: `/servers/${id}` } });
        }
        if (body.action === 'terminate') {
          if (s.state !== 'running') return err(400, 'precondition_failed', 'server should be running');
          s.state = 'terminating'; s.polls = 0;
          return ok({ task: { id: uuid('t'), description: 'server_terminate', status: 'pending' } });
        }
      }
      if (method === 'DELETE' && rest === '') {
        if (s.state === 'running') return err(400, 'precondition_failed', 'server should be stopped');
        delete state.servers[id]; return ok(null, 204);
      }
    }
    const tM = p.match(new RegExp(`^${I}/tasks/(.+)$`));
    if (tM && method === 'GET') {
      if (state.noTaskEndpoint) return err(404, 'not_found', 'resource is not found');
      const t = state.tasks[tM[1]];
      if (!t) return err(404, 'not_found', 'resource is not found');
      t.polls += 1;
      if (t.status === 'pending' && t.polls >= (state.taskSuccessAfter ?? 2)) t.status = state.taskOutcome || 'success';
      return ok({ task: { id: tM[1], status: t.status, description: 'server_poweron' } });
    }
    const vM = p.match(new RegExp(`^/block/v1/zones/${ZONE}/volumes/(.+)$`));
    if (vM) {
      const v = state.volumes[vM[1]];
      if (!v) return err(404, 'not_found', 'resource is not found');
      if (method === 'GET') {
        const attached = Object.values(state.servers).some((s) => s.vol === vM[1]);
        if (!attached) { v.polls += 1; if (v.polls >= state.detachAfterPolls) v.status = 'available'; }
        return ok({ id: vM[1], status: v.status, type: 'sbs_5k', size: ROOT_VOLUME_BYTES });
      }
      if (method === 'DELETE') {
        if (v.status !== 'available') return err(412, 'precondition_failed', 'volume is in use');
        delete state.volumes[vM[1]]; return ok(null, 204);
      }
    }
    return err(404, 'not_found', `no stub for ${method} ${path}`);
  };
  const fetchImpl = async (url, o = {}) => {
    assert.ok(url.startsWith('https://api.scaleway.com/'), `only api.scaleway.com is ever called (got ${url})`);
    const path = url.replace('https://api.scaleway.com', '');
    const method = o.method || 'GET';
    const headers = o.headers || {};
    assert.equal(headers['X-Auth-Token'], SECRET, 'the secret rides in X-Auth-Token');
    const isJson = headers['Content-Type'] === 'application/json';
    const body = o.body === undefined ? undefined : isJson ? JSON.parse(o.body) : o.body;
    state.log.push(`${method} ${path}`);
    state.calls.push({ method, path, headers, body });
    const r = route(method, path, body, headers);
    const h = r.headers || {};
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k) => h[k.toLowerCase()] ?? null },
      json: async () => { if (r.body === null || r.body === undefined) throw new Error('no body'); return r.body; },
    };
  };
  return { fetchImpl, state };
}

const client = (fake, token = CREDS) => new ScalewayClient(token, { fetchImpl: fake.fetchImpl, sleep: nosleep });

// ---------------------------------------------------------------- credentials

test('credentials: JSON with secretKey + projectId, a bare secret key, and garbage that never throws', () => {
  assert.deepEqual(parseCredentials(CREDS), { secretKey: SECRET, projectId: PROJECT });
  assert.deepEqual(parseCredentials(`  ${SECRET}\n`), { secretKey: SECRET, projectId: null });
  assert.deepEqual(parseCredentials(JSON.stringify({ secret_key: SECRET, project_id: PROJECT })), { secretKey: SECRET, projectId: PROJECT }, 'snake_case accepted too');
  assert.match(parseCredentials('{"secretKey": ').error, /not valid JSON/);
  assert.match(parseCredentials('{"projectId":"x"}').error, /no secretKey/);
  assert.match(parseCredentials('[1,2]').error, /does not look like a Scaleway secret key/);
  assert.match(parseCredentials('SCWABCDEFGHIJ0123456').error, /ACCESS key/, 'the access key pasted by mistake is named as such');
  assert.match(parseCredentials('hello world').error, /does not look like a Scaleway secret key/);
  assert.match(parseCredentials(JSON.stringify({ secretKey: SECRET, projectId: 'my-project' })).error, /Project ID/);
  assert.throws(() => new ScalewayClient(''), /required/);
  assert.throws(() => new ScalewayClient(null), /required/);
  // garbage builds a client (so the validate route always gets an answer) ...
  const c = new ScalewayClient('not a key', { fetchImpl: async () => assert.fail('no request with bad credentials') });
  assert.equal(c.credError.length > 0, true);
});

test('the secret never appears in the client JSON or in an error message', async () => {
  const c = new ScalewayClient(CREDS, { fetchImpl: async () => { throw new Error(`connect failed ${SECRET}`); }, sleep: nosleep });
  assert.ok(!JSON.stringify(c).includes(SECRET), 'the secret is not enumerable');
  await assert.rejects(c.getServer('abc'), (e) => {
    assert.equal(e.code, 'network');
    assert.ok(!e.message.includes(SECRET), 'scrubbed from the message');
    return true;
  });
});

// ------------------------------------------------------------- validateToken

test('validateToken: ok with key + project; 401 and 403 are unauthorized; a missing project is named; never reaches the network with bad credentials', async () => {
  const f = fakeScaleway();
  assert.deepEqual(await client(f).validateToken(), { ok: true });
  assert.ok(f.state.log.every((k) => k.startsWith('GET ')), 'read-only');
  assert.ok(f.state.log.includes(`GET /instance/v1/zones/fr-par-2/servers?project=${PROJECT}&per_page=1`));
  assert.ok(f.state.log.includes(`GET /iam/v1alpha1/ssh-keys?project_id=${PROJECT}&page_size=1`));

  const bad = fakeScaleway({ auth: 401 });
  assert.deepEqual(await client(bad).validateToken(), { ok: false, reason: 'unauthorized' });

  const noInst = fakeScaleway({ instancesForbidden: true });
  const ri = await client(noInst).validateToken();
  assert.equal(ri.reason, 'unauthorized');
  assert.match(ri.detail, /InstancesFullAccess/);
  const noKeys = fakeScaleway({ keysForbidden: true });
  const r = await client(noKeys).validateToken();
  assert.equal(r.reason, 'unauthorized');
  assert.match(r.detail, /SSHKeysFullAccess/);

  const bare = fakeScaleway();
  const v = await client(bare, SECRET).validateToken();
  assert.equal(v.ok, false);
  assert.match(v.reason, /missing project ID/);
  assert.equal(bare.state.log.length, 0, 'the project cannot be discovered from the secret key, so nothing is asked');

  const garbage = await new ScalewayClient('SCWABCDEFGHIJ0123456', { fetchImpl: async () => assert.fail('no request') }).validateToken();
  assert.equal(garbage.ok, false);
  assert.match(garbage.reason, /ACCESS key/);
});

test('validateToken: a Project ID that names no project is refused; a key without ProjectReadOnly still passes', async () => {
  const f = fakeScaleway();
  const wrong = JSON.stringify({ secretKey: SECRET, projectId: '00000000-0000-4000-8000-000000000000' });
  const r = await client(f, wrong).validateToken();
  assert.equal(r.ok, false);
  assert.match(r.reason, /no Scaleway Project has that ID/);
  const g = fakeScaleway({ projectRead: 403 });
  assert.deepEqual(await client(g).validateToken(), { ok: true });
});

// ----------------------------------------------------------------- zone lock

test('zone lock: one location, Paris fr-par-2; every zone-taking method refuses any other zone before a request', async () => {
  const f = fakeScaleway();
  const c = client(f);
  assert.deepEqual(await c.listLocations(), [{ name: 'fr-par-2', city: 'Paris', country: 'FR' }]);
  const refused = (p) => assert.rejects(p, (e) => e instanceof ScalewayError && e.code === 'zone_refused' && /fr-par-2/.test(e.message));
  await refused(c.createServer({ name: 'aios-x', serverType: 'BASIC2-A2C-8G', location: 'nl-ams-1', userData: 'x' }));
  await refused(c.createServer({ name: 'aios-x', serverType: 'BASIC2-A2C-8G', location: 'pl-waw-1', userData: 'x' }));
  await refused(c.createServer({ name: 'aios-x', serverType: 'BASIC2-A2C-8G', location: 'fr-par-1', userData: 'x' }));
  await refused(c.listServerTypes('nl-ams-1'));
  await refused(c.listAvailability('pl-waw-2'));
  await refused(c.getServer('s', { zone: 'nl-ams-2' }));
  await refused(c.deleteServer('s', { zone: 'nl-ams-2' }));
  await refused(c.waitAction('t', { zone: 'pl-waw-1' }));
  assert.throws(() => new ScalewayClient(CREDS, { fetchImpl: f.fetchImpl, zone: 'nl-ams-1' }), /zone|fr-par-2/);
  assert.equal(f.state.log.length, 0, 'nothing was asked of Scaleway');
});

// ------------------------------------------------------------------ catalogue

test('catalogue: all product pages read, monthly = hourly x 730 plus the 80 GB block root, memory from bytes, arch normalised, GPU/Windows/end-of-service dropped', async () => {
  // 100 filler types on page 1 force a second page
  const filler = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`FILL-${i}`, ptype(1, 1, 1, 'x86_64')]));
  const f = fakeScaleway({ products: { ...filler, ...PRODUCTS } });
  const c = client(f);
  const types = await c.listServerTypes();
  assert.ok(f.state.log.includes('GET /instance/v1/zones/fr-par-2/products/servers?per_page=100&page=2'), 'page 2 read');
  const names = types.map((t) => t.name);
  for (const gone of ['POP2-2C-8G-WIN', 'GPU-3070-S', 'GP1-XS-OLD']) assert.ok(!names.includes(gone), `${gone} dropped`);
  const std = types.find((t) => t.name === 'BASIC2-A2C-8G');
  // 0.0345 x 730 = 25.185 -> 25.19; root 80 GB x 0.000129999 x 730 = 7.59
  assert.deepEqual(std.priceParts, { server: 25.19, rootVolume: 7.59 });
  assert.deepEqual(std.prices, { 'fr-par-2': 32.78 });
  assert.equal(std.memoryGb, 8);
  assert.equal(std.cores, 2);
  assert.equal(std.arch, 'arm');
  assert.equal(std.diskGb, 80);
  assert.equal(std.rootVolume, 'block');
  assert.equal(std.id, std.name, 'the id IS the commercial type, which availability lists');
  const nano = types.find((t) => t.name === 'PLAY2-NANO');
  assert.equal(nano.arch, 'x86');
  assert.equal(nano.priceParts.server, 20.1);
  assert.equal(types.find((t) => t.name === 'DEV1-M').localDiskGb, 40, 'local disk reported, never used');
  await c.listAvailability();
  assert.equal(f.state.log.filter((k) => k.startsWith('GET /instance/v1/zones/fr-par-2/products/servers?')).length, 2, 'products read once (two pages) and cached');
});

test('availability: shortage dropped, scarce kept, unlisted names dropped; an unreadable availability offers every listed type', async () => {
  const f = fakeScaleway();
  const a = await client(f).listAvailability();
  assert.deepEqual(Object.keys(a), ['fr-par-2']);
  assert.ok(a['fr-par-2'].includes('BASIC2-A2C-8G'), 'scarce still builds');
  assert.ok(!a['fr-par-2'].includes('PLAY2-MICRO'), 'shortage does not');
  assert.ok(!a['fr-par-2'].includes('NOT-LISTED'));
  const g = fakeScaleway({ availabilityDown: true });
  const b = await client(g).listAvailability();
  assert.deepEqual(b['fr-par-2'], Object.keys(PRODUCTS));
});

// ------------------------------------------------------------------- SSH keys

test('ensureSshKey: created in the project once, found by key body on a re-run, a disabled match re-enabled; deleteSshKey tolerates gone', async () => {
  const f = fakeScaleway();
  const c = client(f);
  const id = await c.ensureSshKey('demo-owner', PUB);
  const create = f.state.calls.find((x) => x.method === 'POST' && x.path === '/iam/v1alpha1/ssh-keys');
  assert.deepEqual(create.body, { name: 'demo-owner', public_key: PUB, project_id: PROJECT });
  assert.equal(await c.ensureSshKey('demo-owner-again', `${PUB.replace(' owner@wizard', ' other-comment')}`), id, 'same key body, same id');
  assert.equal(f.state.calls.filter((x) => x.method === 'POST' && x.path === '/iam/v1alpha1/ssh-keys').length, 1, 'never created twice');
  f.state.keys[0].disabled = true;
  assert.equal(await c.ensureSshKey('demo-owner', PUB), id);
  assert.equal(f.state.keys[0].disabled, false, 'a disabled key is not installed by Scaleway, so it is re-enabled');
  await c.deleteSshKey(id);
  assert.equal(f.state.keys.length, 0);
  await c.deleteSshKey(id); // already gone: not an error
  assert.ok(f.state.log.filter((k) => k === `DELETE /iam/v1alpha1/ssh-keys/${id}`).length === 2);
});

test('ensureSshKey: the same key in another project is a clear conflict, not a silent wrong id', async () => {
  const f = fakeScaleway();
  f.state.keys.push({ id: 'k-elsewhere', name: 'x', public_key: PUB, project_id: 'aaaaaaaa-0000-4000-8000-000000000000', disabled: false });
  await assert.rejects(client(f).ensureSshKey('demo-owner', PUB), (e) => e.code === 'key_conflict' && /another Project/.test(e.message));
});

// ------------------------------------------------------------------ create

test('createServer: create (stopped) -> PATCH cloud-init as text/plain -> poweron, in that order, with exact bodies', async () => {
  const f = fakeScaleway();
  const c = client(f);
  const ud = `#cloud-config\n# ${PUB}\n`;
  const r = await c.createServer({ name: 'aios-demo', serverType: 'BASIC2-A2C-8G', location: 'fr-par-2', sshKeyIds: ['k1'], userData: ud });
  const id = f.state.lastCreate;
  const writes = f.state.calls.filter((x) => x.method !== 'GET');
  assert.deepEqual(writes.map((x) => `${x.method} ${x.path}`), [
    'POST /instance/v1/zones/fr-par-2/servers',
    `PATCH /instance/v1/zones/fr-par-2/servers/${id}/user_data/cloud-init`,
    `POST /instance/v1/zones/fr-par-2/servers/${id}/action`,
  ]);
  assert.deepEqual(writes[0].body, {
    name: 'aios-demo',
    project: PROJECT,
    commercial_type: 'BASIC2-A2C-8G',
    image: ARM_IMG,
    volumes: { 0: { volume_type: 'sbs_volume', size: 80_000_000_000 } },
    dynamic_ip_required: true,
    tags: [TAG, 'aios-demo'],
  });
  assert.equal(writes[1].headers['Content-Type'], 'text/plain');
  assert.equal(writes[1].body, ud, 'the cloud-init text verbatim, not JSON');
  assert.deepEqual(writes[2].body, { action: 'poweron' });
  assert.equal(r.id, id);
  assert.equal(r.ip, null, 'the dynamic IPv4 arrives at boot; getServer() reads it');
  assert.ok(r.actionId && f.state.tasks[r.actionId], 'actionId is the poweron task id');
});

test('image selection follows the machine: x86 types get the x86 instance_sbs image, Arm types the arm64 one; none is a clear error', async () => {
  const f = fakeScaleway();
  const c = client(f);
  await c.createServer({ name: 'aios-a', serverType: 'PLAY2-NANO', location: 'fr-par-2', userData: 'x' });
  await c.createServer({ name: 'aios-b', serverType: 'BASIC2-A4C-16G', location: 'fr-par-2', userData: 'x' });
  const creates = f.state.calls.filter((x) => x.method === 'POST' && x.path === '/instance/v1/zones/fr-par-2/servers');
  assert.equal(creates[0].body.image, X86_IMG);
  assert.equal(creates[1].body.image, ARM_IMG);
  assert.ok(f.state.log.some((k) => k.startsWith('GET /marketplace/v2/local-images?image_label=ubuntu_noble&zone=fr-par-2&type=instance_sbs')));
  await assert.rejects(c.createServer({ name: 'aios-c', serverType: 'DEV1-XL', location: 'fr-par-2', userData: 'x' }), (e) => e.code === 'image_not_found');
  assert.equal(creates.length, 2, 'no create without an image');
  // a UUID passed in is used as given, with no Marketplace lookup
  const g = fakeScaleway();
  await client(g).createServer({ name: 'aios-d', serverType: 'PLAY2-NANO', location: 'fr-par-2', userData: 'x', image: X86_IMG });
  assert.ok(!g.state.log.some((k) => k.includes('/marketplace/')));
});

test('a create whose answer was lost is adopted by name, finished (cloud-init + poweron) and never doubled', async () => {
  const f = fakeScaleway({ dropCreate: true });
  const c = client(f);
  const r = await c.createServer({ name: 'aios-demo', serverType: 'BASIC2-A2C-8G', location: 'fr-par-2', userData: 'ud' });
  assert.equal(r.id, f.state.lastCreate, 'the server the dropped request made');
  assert.equal(f.state.log.filter((k) => k === 'POST /instance/v1/zones/fr-par-2/servers').length, 1, 'the create was NOT retried');
  assert.ok(f.state.log.includes(`GET /instance/v1/zones/fr-par-2/servers?project=${PROJECT}&name=aios-demo&per_page=50`));
  assert.equal(f.state.userData[r.id].text, 'ud', 'the adopted server still gets its cloud-init');
  assert.equal(f.state.servers[r.id].state, 'starting', 'and is powered on');
});

test('a lost create that left nothing behind is reported, not invented; a same-name server without our tag is not adopted', async () => {
  const f = fakeScaleway();
  f.state.servers.other = { name: 'aios-demo', state: 'running', tags: ['someone-else'], type: 'X', vol: 'v', polls: 0, created: '2026-01-01T00:00:00Z' };
  const fetchImpl = async (url, o = {}) => {
    if (o.method === 'POST' && url.endsWith('/instance/v1/zones/fr-par-2/servers')) throw new Error('socket hang up');
    return f.fetchImpl(url, o);
  };
  const c = new ScalewayClient(CREDS, { fetchImpl, sleep: nosleep });
  await assert.rejects(
    c.createServer({ name: 'aios-demo', serverType: 'BASIC2-A2C-8G', location: 'fr-par-2', userData: 'x' }),
    (e) => e.code === 'network' && /network failure/.test(e.message) && !e.serverId,
  );
  assert.ok(f.state.log.some((k) => k.includes('name=aios-demo')), 'it looked before giving up');
  assert.ok(!f.state.log.some((k) => k.includes('/servers/other/')), 'the stranger was left alone');
});

test('a failure after the server exists carries its id, for destroy-and-retry', async () => {
  const f = fakeScaleway({ failUserData: true });
  await assert.rejects(
    client(f).createServer({ name: 'aios-demo', serverType: 'BASIC2-A2C-8G', location: 'fr-par-2', userData: 'x' }),
    (e) => e instanceof ScalewayError && e.serverId === f.state.lastCreate && /must be removed/.test(e.message),
  );
  assert.ok(!f.state.log.some((k) => k.endsWith('/action')), 'never powered on without its cloud-init');
  const g = fakeScaleway({ failPoweron: true });
  await assert.rejects(
    client(g).createServer({ name: 'aios-demo', serverType: 'BASIC2-A2C-8G', location: 'fr-par-2', userData: 'x' }),
    (e) => e.serverId === g.state.lastCreate && e.status === 400,
  );
});

test(`user data over ${USER_DATA_LIMIT} bytes is refused before any request; a missing project is refused too`, async () => {
  const f = fakeScaleway();
  await assert.rejects(client(f).createServer({ name: 'aios-x', serverType: 'PLAY2-NANO', location: 'fr-par-2', userData: 'x'.repeat(USER_DATA_LIMIT + 1) }), (e) => e.code === 'user_data_too_large' && /127998/.test(e.message));
  await assert.rejects(client(f).createServer({ name: 'aios-x', serverType: 'PLAY2-NANO', location: 'fr-par-2', userData: 'é'.repeat(USER_DATA_LIMIT / 2 + 1) }), /user data limit/, 'bytes, not characters');
  await assert.rejects(client(f, SECRET).createServer({ name: 'aios-x', serverType: 'PLAY2-NANO', location: 'fr-par-2', userData: 'x' }), (e) => e.code === 'missing_project');
  assert.equal(f.state.log.length, 0);
});

// ------------------------------------------------------------ wait + status

test('waitAction: success returns, failure throws, a stuck task times out, a missing task endpoint is unverified (the engine polls the server next)', async () => {
  const f = fakeScaleway();
  const c = client(f);
  const r = await c.createServer({ name: 'aios-demo', serverType: 'BASIC2-A2C-8G', location: 'fr-par-2', userData: 'x' });
  assert.equal((await c.waitAction(r.actionId)).status, 'success');
  f.state.tasks.t2 = { status: 'pending', polls: 0 };
  f.state.taskOutcome = 'failure';
  await assert.rejects(c.waitAction('t2'), (e) => e.code === 'action_failed');
  f.state.tasks.t3 = { status: 'pending', polls: 0 };
  f.state.taskSuccessAfter = 1e9;
  await assert.rejects(c.waitAction('t3', { timeoutMs: -1 }), (e) => e.code === 'timeout');
  f.state.noTaskEndpoint = true;
  assert.deepEqual(await c.waitAction('t4'), { id: 't4', status: 'unverified' });
});

test('getServer: starting/running/stopped map to the engine vocabulary, IPv4 from public_ips; a just-powered-on server reading stopped is still starting', async () => {
  const f = fakeScaleway({ runningAfterPolls: 2 });
  const c = client(f);
  const { id } = await c.createServer({ name: 'aios-demo', serverType: 'BASIC2-A2C-8G', location: 'fr-par-2', userData: 'x' });
  assert.deepEqual(await c.getServer(id), { id, name: 'aios-demo', status: 'starting', ip: null });
  assert.deepEqual(await c.getServer(id), { id, name: 'aios-demo', status: 'running', ip: '51.15.0.42' }, 'the v4 address, not the v6');
  f.state.servers[id].state = 'stopped';
  assert.equal((await c.getServer(id)).status, 'starting', 'inside the poweron grace window');
  c.poweringOn.clear();
  assert.equal((await c.getServer(id)).status, 'off');
  f.state.servers[id].state = 'stopping';
  assert.equal((await c.getServer(id)).status, 'off');
  f.state.servers[id].state = 'locked';
  assert.equal((await c.getServer(id)).status, 'unknown');
});

// ------------------------------------------------------------------- delete

test('deleteServer: a running server is terminated, then its detached block root is deleted; 404 at any point is done', async () => {
  const f = fakeScaleway();
  const c = client(f);
  const { id } = await c.createServer({ name: 'aios-demo', serverType: 'BASIC2-A2C-8G', location: 'fr-par-2', userData: 'x' });
  await c.getServer(id); // -> running
  const vol = f.state.servers[id].vol;
  const out = await c.deleteServer(id);
  assert.deepEqual(out, { keptFlexibleIps: ['ip-v6'] }, 'a flexible IP this client never made is reported, not deleted');
  const writes = f.state.calls.filter((x) => x.method !== 'GET').slice(3).map((x) => `${x.method} ${x.path}${x.body ? ` ${JSON.stringify(x.body)}` : ''}`);
  assert.deepEqual(writes, [
    `POST /instance/v1/zones/fr-par-2/servers/${id}/action {"action":"terminate"}`,
    `DELETE /block/v1/zones/fr-par-2/volumes/${vol}`,
  ]);
  assert.equal(f.state.servers[id], undefined);
  assert.equal(f.state.volumes[vol], undefined, 'nothing left billing');
  assert.ok(!f.state.log.includes(`DELETE /instance/v1/zones/fr-par-2/servers/${id}`), 'a running server is never DELETEd');
  await c.deleteServer(id); // already gone: not an error
});

test('deleteServer: a stopped half-made server (failed before poweron) is DELETEd, not terminated, and its disk goes too', async () => {
  const f = fakeScaleway({ failPoweron: true });
  const c = client(f);
  let sid;
  await c.createServer({ name: 'aios-demo', serverType: 'BASIC2-A2C-8G', location: 'fr-par-2', userData: 'x' }).catch((e) => { sid = e.serverId; });
  const vol = f.state.servers[sid].vol;
  await c.deleteServer(sid);
  assert.ok(f.state.log.includes(`DELETE /instance/v1/zones/fr-par-2/servers/${sid}`));
  assert.ok(!f.state.calls.some((x) => x.body?.action === 'terminate'), 'no terminate on a stopped server');
  assert.equal(f.state.volumes[vol], undefined);
});

test('deleteServer: a disk still attached after the deadline is reported by id, so it is not silently left billing', async () => {
  const f = fakeScaleway({ detachAfterPolls: 1e9 });
  const c = client(f);
  const { id } = await c.createServer({ name: 'aios-demo', serverType: 'BASIC2-A2C-8G', location: 'fr-par-2', userData: 'x' });
  await c.getServer(id);
  const vol = f.state.servers[id].vol;
  await assert.rejects(c.deleteServer(id, { timeoutMs: 0 }), (e) => e.code === 'volume_cleanup' && e.message.includes(vol));
});

// ------------------------------------------------------- through the engine

test('full run through the engine: validate -> key -> create -> poweron -> running; destroy removes server and disk; the secret never lands in state', async () => {
  // Through the registry's id and defaults: the entry and the client fit.
  const f = fakeScaleway();
  const c = client(f);
  const state = {};
  const steps = [];
  const r = await provisionSelfHost({
    token: CREDS, boxName: 'demo', ownerPubKey: PUB, state, provider: 'scaleway',
    onStep: (s, d) => steps.push(d ? `${s} (${d})` : s),
    overrides: { client: c, image: 'ghcr.io/x/crads-pebble:v2', sleep: nosleep },
  });
  assert.equal(r.ip, '51.15.0.42');
  assert.equal(r.serverId, f.state.lastCreate);
  assert.equal(steps[2], 'create-server (BASIC2-A2C-4G @ fr-par-2)', 'Standard is 4 GB since 2026-10-15');
  assert.ok(f.state.userData[r.serverId].text.includes(PUB), 'the owner key rides the cloud-init');
  assert.ok(f.state.log.some((k) => k.includes('/tasks/')), 'the poweron task was awaited');
  assert.ok(!JSON.stringify(state).includes(SECRET));
  const vol = f.state.servers[r.serverId].vol;
  const d = await destroySelfHost({ token: CREDS, state, client: c });
  assert.equal(d.destroyed, true);
  assert.equal(Object.keys(f.state.servers).length, 0);
  assert.equal(f.state.volumes[vol], undefined);
});

// Live, 2026-10-14: a new account's first create was refused with "quota(s)
// exceeded for this resource" because every Paris server quota starts at 0
// until Scaleway accepts an ID document. The page must say what to do.
test('a quota refusal becomes a plain instruction to verify ID, with its own code', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ type: 'quotas_exceeded', message: 'quota(s) exceeded for this resource', details: [] }) });
  const c = new ScalewayClient(CREDS, { fetchImpl, sleep: nosleep });
  await assert.rejects(c.request('/instance/v1/zones/fr-par-2/servers', { method: 'POST', body: {}, retry: false }), (e) =>
    e.code === 'quota' && /Verify ID/.test(e.message) && /Retry/.test(e.message) && !/—/.test(e.message));
  const byMessage = async () => ({ ok: false, status: 403, json: async () => ({ type: 'invalid_request_error', message: 'quota(s) exceeded for this resource' }) });
  await assert.rejects(new ScalewayClient(CREDS, { fetchImpl: byMessage, sleep: nosleep }).request('/x', { method: 'POST', body: {}, retry: false }), (e) => e.code === 'quota');
  const other = async () => ({ ok: false, status: 404, json: async () => ({ type: 'not_found', message: 'resource not found' }) });
  await assert.rejects(new ScalewayClient(CREDS, { fetchImpl: other, sleep: nosleep }).request('/x'), (e) => e.code === 'not_found');
});
