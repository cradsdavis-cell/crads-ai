// providers.test.mjs: the registry every provisioning surface reads.
//   node --test wizard/provision/providers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, providerOf, publicProviders, DEFAULT_PROVIDER, resolveSize, defaultLocationFor } from './providers.mjs';
import { HetznerClient } from './hetzner.mjs';
import { DigitalOceanClient } from './digitalocean.mjs';

const CONTRACT = ['validateToken', 'listLocations', 'listServerTypes', 'listAvailability', 'ensureSshKey', 'createServer', 'waitAction', 'getServer', 'deleteServer', 'deleteSshKey'];

test('every provider carries the fields the door and the docs read', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.equal(p.id, id);
    for (const k of ['label', 'currency', 'symbol', 'console', 'tokenLabel', 'tokenHelpDocSlug', 'costsCopy', 'blurb']) {
      assert.equal(typeof p[k], 'string', `${id}.${k}`);
      assert.ok(p[k].length, `${id}.${k} is empty`);
      assert.ok(!p[k].includes('\u2014'), `${id}.${k} carries an em dash`);
    }
    assert.ok(p.defaults.location && p.defaults.serverType, `${id} defaults`);
    assert.deepEqual(Object.keys(p.sizeChains), ['small', 'standard', 'roomy'], `${id} names the three size cards`);
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
  assert.deepEqual(a.map((p) => p.id), ['hetzner', 'digitalocean'], 'Hetzner leads');
  for (const p of a) assert.ok(!('makeClient' in p));
  a[0].sizeChains.small.push('x');
  assert.notDeepEqual(a[0].sizeChains.small, b[0].sizeChains.small, 'fresh objects every call');
  assert.ok(!JSON.stringify(a).includes('function'));
});

test('the two providers offer the same machine specs behind the three cards', () => {
  // "Standard" must mean the same thing whichever card is picked: 4 / 8 / 16 GB.
  // The chain names encode the memory on both providers (cx23 = 4 GB, s-2vcpu-4gb).
  // Hetzner's memory per type, as its API answered on 2026-10-13. Every type in
  // a Hetzner chain must carry the same memory: a fallback is never smaller.
  const gb = { cax11: 4, cax21: 8, cax31: 16, cx23: 4, cx33: 8, cx43: 16, cpx21: 4, cpx22: 4, cpx31: 8, cpx32: 8, cpx41: 16, cpx42: 16 };
  const doGb = (slug) => Number(slug.match(/-(\d+)gb/)[1]);
  const want = { small: 4, standard: 8, roomy: 16 };
  for (const size of ['small', 'standard', 'roomy']) {
    for (const name of PROVIDERS.hetzner.sizeChains[size]) assert.equal(gb[name], want[size], `hetzner ${size}: ${name}`);
    for (const slug of PROVIDERS.digitalocean.sizeChains[size]) assert.equal(doGb(slug), want[size], `${size}: ${slug}`);
  }
});

test('Hetzner leads with Arm and keeps an x86 fallback in every chain (2026-10-13)', () => {
  const H = PROVIDERS.hetzner;
  assert.equal(H.defaults.serverType, 'cax21');
  for (const size of ['small', 'standard', 'roomy']) {
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
  assert.equal(resolveSize(H, 'standard', 'hel1', LIVE).name, 'cax21');
  assert.equal(resolveSize(H, 'standard', 'nbg1', LIVE).name, 'cpx32', 'no Arm in nbg1 that day');
  assert.equal(resolveSize(H, 'standard', 'ash', LIVE).name, 'cpx31');
  assert.equal(resolveSize(H, 'standard', 'sin', LIVE).name, 'cpx32');
  assert.equal(resolveSize(H, 'roomy', 'fsn1', LIVE).name, 'cpx42', 'cax31 is hel1 only');
  assert.equal(resolveSize(H, 'roomy', 'nbg1', LIVE), null, 'nothing 16 GB in nbg1 that day');
  assert.equal(resolveSize(H, 'small', 'fsn1', LIVE).name, 'cax11');
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
