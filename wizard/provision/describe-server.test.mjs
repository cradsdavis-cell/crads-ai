// describe-server.test.mjs: the optional describeServer on each client
// (2026-10-14), which lets "Delete the old server" after a move to this computer
// name the machine's monthly price for a server built before the build record
// kept its type. Each against a one-route fake of the provider's own answer.
//   node --test wizard/provision/describe-server.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HetznerClient } from './hetzner.mjs';
import { DigitalOceanClient } from './digitalocean.mjs';

const answer = (body) => async (url) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body), url });

test('Hetzner: server_type and the datacenter’s location', async () => {
  const c = new HetznerClient('t', { fetchImpl: answer({ server: { id: 7, server_type: { name: 'cax11' }, datacenter: { location: { name: 'hel1' } } } }) });
  assert.deepEqual(await c.describeServer(7), { serverType: 'cax11', location: 'hel1' });
});

test('DigitalOcean: size slug and region', async () => {
  const c = new DigitalOceanClient('t', { fetchImpl: answer({ droplet: { id: 9, size_slug: 's-4vcpu-8gb', region: { slug: 'syd1' } } }) });
  assert.deepEqual(await c.describeServer(9), { serverType: 's-4vcpu-8gb', location: 'syd1' });
});
