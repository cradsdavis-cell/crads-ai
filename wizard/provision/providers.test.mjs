// providers.test.mjs: the registry every provisioning surface reads.
//   node --test wizard/provision/providers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, providerOf, publicProviders, DEFAULT_PROVIDER, resolveSize, defaultLocationFor } from './providers.mjs';
import { HetznerClient } from './hetzner.mjs';
import { DigitalOceanClient } from './digitalocean.mjs';
import { ScalewayClient } from './scaleway.mjs';
import { OwnServerClient } from './own-server.mjs';

const CONTRACT = ['validateToken', 'listLocations', 'listServerTypes', 'listAvailability', 'ensureSshKey', 'createServer', 'waitAction', 'getServer', 'deleteServer', 'deleteSshKey'];

test('every provider carries the fields the door and the docs read', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.equal(p.id, id);
    for (const k of ['label', 'currency', 'symbol', 'console', 'tokenLabel', 'tokenHelpDocSlug', 'costsCopy', 'blurb']) {
      assert.equal(typeof p[k], 'string', `${id}.${k}`);
      // A server the person already has has no prices and no console of ours to name.
      const mayBeEmpty = p.ownServer && ['currency', 'symbol', 'console'].includes(k);
      if (!mayBeEmpty) assert.ok(p[k].length, `${id}.${k} is empty`);
      assert.ok(!p[k].includes('\u2014'), `${id}.${k} carries an em dash`);
    }
    assert.ok(p.defaults.location && p.defaults.serverType, `${id} defaults`);
    assert.deepEqual(Object.keys(p.sizeChains), ['standard', 'roomy', 'large'], `${id} names the three size cards`);
    for (const chain of Object.values(p.sizeChains)) assert.ok(chain.length >= 1);
    assert.ok(p.sizeChains.standard.includes(p.defaults.serverType), `${id}: the default machine is the Standard card`);
    assert.equal(typeof p.makeClient, 'function');
  }
});

test('each provider builds a client that honours the nine-method contract', () => {
  const hz = PROVIDERS.hetzner.makeClient('t');
  const dO = PROVIDERS.digitalocean.makeClient('t');
  assert.ok(hz instanceof HetznerClient);
  assert.ok(dO instanceof DigitalOceanClient);
  for (const c of [hz, dO]) for (const m of CONTRACT) assert.equal(typeof c[m], 'function', `${c.constructor.name}.${m}`);
  assert.throws(() => PROVIDERS.digitalocean.makeClient(''), /token is required/);
});

test('providerOf: default, named, unknown', () => {
  assert.equal(DEFAULT_PROVIDER, 'hetzner');
  assert.equal(providerOf().id, 'hetzner');
  assert.equal(providerOf(undefined).id, 'hetzner');
  assert.equal(providerOf('digitalocean').label, 'DigitalOcean');
  assert.throws(() => providerOf('aws'), /unknown provider/);
});

test('publicProviders carries no functions and no shared objects', () => {
  const a = publicProviders();
  const b = publicProviders();
  assert.deepEqual(a.map((p) => p.id), ['hetzner', 'digitalocean', 'own'], 'Hetzner leads; a server you already have comes after the two cloud companies');
  for (const p of a) assert.ok(!('makeClient' in p));
  a[0].sizeChains.standard.push('x');
  assert.notDeepEqual(a[0].sizeChains.standard, b[0].sizeChains.standard, 'fresh objects every call');
  assert.ok(!JSON.stringify(a).includes('function'));
});

test('the two providers offer the same machine specs behind the three cards', () => {
  // "Standard" must mean the same thing whichever card is picked: 4 / 8 / 16 GB.
  // The chain names encode the memory on both providers (cx23 = 4 GB, s-2vcpu-4gb).
  // Hetzner's memory per type, as its API answered on 2026-10-13. Every type in
  // a Hetzner chain must carry the same memory: a fallback is never smaller.
  const gb = { cax11: 4, cax21: 8, cax31: 16, cx23: 4, cx33: 8, cx43: 16, cpx21: 4, cpx22: 4, cpx31: 8, cpx32: 8, cpx41: 16, cpx42: 16 };
  const doGb = (slug) => Number(slug.match(/-(\d+)gb/)[1]);
  const want = { standard: 4, roomy: 8, large: 16 };
  for (const size of ['standard', 'roomy', 'large']) {
    for (const name of PROVIDERS.hetzner.sizeChains[size]) assert.equal(gb[name], want[size], `hetzner ${size}: ${name}`);
    for (const slug of PROVIDERS.digitalocean.sizeChains[size]) assert.equal(doGb(slug), want[size], `${size}: ${slug}`);
  }
});

test('Hetzner leads with Arm and keeps an x86 fallback in every chain (2026-10-13)', () => {
  const H = PROVIDERS.hetzner;
  assert.equal(H.defaults.serverType, 'cax11', 'Standard is the 4 GB Arm machine since 2026-10-15');
  for (const size of ['standard', 'roomy', 'large']) {
    const chain = H.sizeChains[size];
    assert.match(chain[0], /^cax/, `${size} starts on Arm`);
    assert.ok(chain.some((n) => /^cpx/.test(n)), `${size} has an x86 machine the US and Singapore sell`);
  }
});

// The 2026-10-13 catalogue in the validate answer's shape.
const LIVE = [
  { name: 'cax11', locations: ['fsn1', 'hel1'] },
  { name: 'cax21', locations: ['fsn1', 'hel1'] },
  { name: 'cax31', locations: ['hel1'] },
  { name: 'cpx22', locations: ['nbg1', 'fsn1', 'hel1', 'sin'] },
  { name: 'cpx32', locations: ['nbg1', 'fsn1', 'hel1', 'sin'] },
  { name: 'cpx42', locations: ['fsn1', 'hel1', 'sin'] },
  { name: 'cpx21', locations: ['ash', 'hil'] },
  { name: 'cpx31', locations: ['ash', 'hil'] },
  { name: 'cpx41', locations: ['ash', 'hil'] },
];

test('resolveSize: the first machine in the chain the location sells', () => {
  const H = PROVIDERS.hetzner;
  // Standard 4 GB, Roomy 8 GB, Extra roomy (large) 16 GB since 2026-10-15.
  assert.equal(resolveSize(H, 'standard', 'hel1', LIVE).name, 'cax11');
  assert.equal(resolveSize(H, 'standard', 'nbg1', LIVE).name, 'cpx22', 'no Arm in nbg1 that day');
  assert.equal(resolveSize(H, 'standard', 'ash', LIVE).name, 'cpx21');
  assert.equal(resolveSize(H, 'standard', 'sin', LIVE).name, 'cpx22');
  assert.equal(resolveSize(H, 'roomy', 'fsn1', LIVE).name, 'cax21');
  assert.equal(resolveSize(H, 'roomy', 'nbg1', LIVE).name, 'cpx32', 'no Arm in nbg1 that day');
  assert.equal(resolveSize(H, 'large', 'fsn1', LIVE).name, 'cpx42', 'cax31 is hel1 only');
  assert.equal(resolveSize(H, 'large', 'nbg1', LIVE), null, 'nothing 16 GB in nbg1 that day');
});

test('defaultLocationFor: the default location sells the default machine, or the next one does', () => {
  const H = PROVIDERS.hetzner;
  assert.equal(defaultLocationFor(H, LIVE), 'hel1');
  const noHel = LIVE.map((t) => ({ ...t, locations: t.locations.filter((l) => l !== 'hel1') }));
  assert.equal(defaultLocationFor(H, noHel), 'fsn1', 'hel1 out of Arm: fsn1');
  const noArm = LIVE.filter((t) => !/^cax/.test(t.name));
  assert.equal(defaultLocationFor(H, noArm), 'hel1', 'no Arm anywhere: the first preferred location that sells a Standard machine');
  assert.equal(defaultLocationFor(H, []), H.defaults.location, 'an unreadable catalogue keeps the static default');
  assert.equal(defaultLocationFor(PROVIDERS.digitalocean, []), 'syd1');
});

// The third provider (2026-10-14): Scaleway, the low-carbon option, Paris only.
// Contabo ("looks super dodgy") and BinaryLane (sign-up demands a purchase;
// DigitalOcean stays the Sydney option) were built and dropped the same day;
// neither may come back by accident.
test('every provider builds a client that honours the contract', () => {
  const tokens = {
    scaleway: JSON.stringify({ secretKey: '11111111-2222-3333-4444-555555555555', projectId: '11111111-2222-3333-4444-666666666666' }),
    own: JSON.stringify({ host: '203.0.113.10', user: 'ubuntu', slug: 'mel' }),
  };
  const classes = { scaleway: ScalewayClient, own: OwnServerClient };
  for (const [id, Cls] of Object.entries(classes)) {
    const c = PROVIDERS[id].makeClient(tokens[id]);
    assert.ok(c instanceof Cls, id);
    for (const m of CONTRACT) assert.equal(typeof c[m], 'function', `${id}.${m}`);
  }
});

test('providers not yet proven on real metal stay off the members\' list unless the operator opts in', () => {
  const preview = Object.values(PROVIDERS).filter((p) => p.preview).map((p) => p.id);
  assert.deepEqual(preview.sort(), ['scaleway']);
  for (const gone of ['contabo', 'binarylane']) assert.ok(!(gone in PROVIDERS), `${gone} stays out`);
  assert.deepEqual(publicProviders({ includePreview: false }).map((p) => p.id), ['hetzner', 'digitalocean', 'own']);
  assert.deepEqual(publicProviders({ includePreview: true }).map((p) => p.id), ['hetzner', 'digitalocean', 'own', 'scaleway']);
  for (const id of preview) assert.equal(providerOf(id).id, id, `${id} is still buildable by id`);
});

test('a provider that signs in with several values declares each one, and every registry string is em-dash free', () => {
  for (const p of Object.values(PROVIDERS)) {
    const strings = [...(p.tokenSteps || []), p.tokenNote || ''];
    for (const f of p.credentialFields || []) {
      assert.match(f.key, /^[a-zA-Z]+$/, `${p.id} field key`);
      assert.ok(f.label && typeof f.secret === 'boolean', `${p.id}.${f.key} has a label and says if it is secret`);
      strings.push(f.label, f.help || '', f.placeholder || '');
    }
    for (const t of strings) assert.ok(!t.includes('\u2014'), `${p.id}: em dash in "${t}"`);
    if (!['hetzner', 'digitalocean'].includes(p.id)) assert.ok((p.tokenSteps || []).length >= 3, `${p.id} carries its own how-to steps`);
  }
  assert.deepEqual(PROVIDERS.scaleway.credentialFields.map((f) => f.key), ['secretKey', 'projectId']);
});

test('Scaleway keeps the memory promise behind the three cards', () => {
  // Memory per machine as each provider listed it on 2026-10-14. A fallback is
  // never smaller.
  const gb = {
    'BASIC2-A2C-4G': 4, 'PLAY2-NANO': 4, 'BASIC2-A2C-8G': 8, 'BASIC2-A4C-8G': 8, 'PLAY2-MICRO': 8, 'BASIC2-A4C-16G': 16, 'PRO2-XS': 16,
  };
  const atLeast = { standard: 4, roomy: 8, large: 16 };
  for (const id of ['scaleway']) {
    for (const size of ['standard', 'roomy', 'large']) {
      for (const name of PROVIDERS[id].sizeChains[size]) {
        assert.equal(gb[name], atLeast[size], `${id} ${size}: ${name} is exactly the card's memory`);
      }
    }
  }
  assert.deepEqual(PROVIDERS.scaleway.locationPreference, ['fr-par-2'], 'the low-carbon option has one location');
});
