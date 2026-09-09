// providers.test.mjs: the registry every provisioning surface reads.
//   node --test wizard/provision/providers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, providerOf, publicProviders, DEFAULT_PROVIDER } from './providers.mjs';
import { HetznerClient } from './hetzner.mjs';
import { DigitalOceanClient } from './digitalocean.mjs';

const CONTRACT = ['validateToken', 'listLocations', 'listServerTypes', 'listAvailability', 'ensureSshKey', 'createServer', 'waitAction', 'getServer', 'deleteServer'];

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
  const gb = { cx23: 4, cx33: 8, cx43: 16, cpx21: 4, cpx22: 4, cpx31: 8, cpx32: 8, cpx41: 16, cpx42: 16 };
  const doGb = (slug) => Number(slug.match(/-(\d+)gb/)[1]);
  for (const size of ['small', 'standard', 'roomy']) {
    const want = gb[PROVIDERS.hetzner.sizeChains[size][0]];
    for (const slug of PROVIDERS.digitalocean.sizeChains[size]) assert.equal(doGb(slug), want, `${size}: ${slug}`);
  }
});
