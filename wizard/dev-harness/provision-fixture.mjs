// provision-fixture.mjs: the fake Hetzner behind every provisioning surface
// that must never touch a real account: provision-routes.test.mjs (the door's
// routes against a fake client) and the dev-harness (the door PAGE against a
// stubbed /provision/*, for the docs screenshots and driven tests).
//
// Two shapes live here on purpose. `fakeClient()` is the nine-method client
// contract the engine drives (wizard/provision/hetzner.mjs is the real one),
// lifted verbatim from the routes test on 2026-09-09 so the harness and the
// test cannot drift apart on what a Hetzner answer looks like. `catalogue()`
// is the answer the door's "Check the token" step receives, built the way
// provision-routes.mjs builds it (each type stamped with the locations that
// sell it; prices per location in euros), populated enough that a screenshot
// of the size cards shows real-looking choices rather than one option.
//
// Prices are Hetzner's list prices as read on 2026-10-13, gross, rounded the
// way the door rounds them. They are INDICATIVE: any page that shows them
// says so (claims.mjs BILLING_SHOTS), and the wizard reads live prices when a
// person actually runs it. Tests never touch provisioning (harness/lib/
// live-guard.sh); nothing in this file can.

import { PROVIDERS, publicProviders, defaultLocationFor } from '../provision/providers.mjs';
export { publicProviders };

export function fakeClient(calls, provider = 'hetzner') {
  return {
    validateToken: async () => ({ ok: true }),
    listLocations: async () => [
      { name: 'nbg1', city: 'Nuremberg', country: 'DE' },
      { name: 'hel1', city: 'Helsinki', country: 'FI' },
    ],
    // The 2026-10-13 shape in miniature: the Arm machines are sold in hel1
    // and not nbg1, cx33 is sold nowhere, and cpx11 only in hel1. Standard is
    // the 4 GB chain since 2026-10-15 (cax11, else cpx22), Roomy the 8 GB.
    listServerTypes: async () => [
      { id: 1, name: 'cx33', cores: 4, memoryGb: 8, diskGb: 80, arch: 'x86' },
      { id: 2, name: 'cpx11', cores: 2, memoryGb: 2, diskGb: 40, arch: 'x86' },
      { id: 92, name: 'cax11', cores: 2, memoryGb: 4, diskGb: 40, arch: 'arm' },
      { id: 93, name: 'cax21', cores: 4, memoryGb: 8, diskGb: 80, arch: 'arm' },
      { id: 116, name: 'cpx22', cores: 2, memoryGb: 4, diskGb: 80, arch: 'x86' },
      { id: 117, name: 'cpx32', cores: 4, memoryGb: 8, diskGb: 160, arch: 'x86' },
    ],
    listAvailability: async () => ({ nbg1: [116, 117], hel1: [2, 92, 93, 116, 117] }),
    ensureSshKey: async () => 7,
    createServer: async (o) => { calls.push(['create', o.name, provider, o.serverType, o.location]); return { id: 42, ip: '203.0.113.9', actionId: 9 }; },
    waitAction: async () => ({ status: 'success' }),
    getServer: async () => ({ id: 42, name: 'aios-demo', status: 'running', ip: '203.0.113.9' }),
    deleteServer: async (id) => { calls.push(['delete', id, provider]); },
    deleteSshKey: async (id) => { calls.push(['delete-key', id, provider]); },
  };
}

// The door's catalogue world, as Hetzner sold it on 2026-10-13 (monthly gross
// euros, read live): Arm (cax) in the EU only and not every size everywhere,
// the cheap Intel cx line sold out everywhere (so absent: the validate answer
// drops a type sold nowhere), cpx22/32/42 in the EU and Singapore, and the
// older cpx21/31/41 only in the US. That patchwork is what the door's
// per-location filter exists for, so the fixture keeps it.
export const LOCATIONS = [
  { name: 'nbg1', city: 'Nuremberg', country: 'DE' },
  { name: 'fsn1', city: 'Falkenstein', country: 'DE' },
  { name: 'hel1', city: 'Helsinki', country: 'FI' },
  { name: 'ash', city: 'Ashburn, VA', country: 'US' },
  { name: 'hil', city: 'Hillsboro, OR', country: 'US' },
  { name: 'sin', city: 'Singapore', country: 'SG' },
];
const priced = (locs, eur) => Object.fromEntries(locs.map((l) => [l, eur]));
const US = ['ash', 'hil'];
export const SERVER_TYPES = [
  { id: 92, name: 'cax11', cores: 2, memoryGb: 4, diskGb: 40, arch: 'arm', locations: ['fsn1', 'hel1'], prices: priced(['fsn1', 'hel1'], 5.99) },
  { id: 93, name: 'cax21', cores: 4, memoryGb: 8, diskGb: 80, arch: 'arm', locations: ['fsn1', 'hel1'], prices: priced(['fsn1', 'hel1'], 10.49) },
  { id: 94, name: 'cax31', cores: 8, memoryGb: 16, diskGb: 160, arch: 'arm', locations: ['hel1'], prices: priced(['hel1'], 20.99) },
  { id: 116, name: 'cpx22', cores: 2, memoryGb: 4, diskGb: 80, arch: 'x86', locations: ['nbg1', 'fsn1', 'hel1', 'sin'], prices: { ...priced(['nbg1', 'fsn1', 'hel1'], 19.49), sin: 26.49 } },
  { id: 117, name: 'cpx32', cores: 4, memoryGb: 8, diskGb: 160, arch: 'x86', locations: ['nbg1', 'fsn1', 'hel1', 'sin'], prices: { ...priced(['nbg1', 'fsn1', 'hel1'], 35.49), sin: 48.99 } },
  { id: 118, name: 'cpx42', cores: 8, memoryGb: 16, diskGb: 320, arch: 'x86', locations: ['fsn1', 'hel1', 'sin'], prices: { ...priced(['fsn1', 'hel1'], 69.49), sin: 93.49 } },
  { id: 4, name: 'cpx21', cores: 3, memoryGb: 4, diskGb: 80, arch: 'x86', locations: US, prices: priced(US, 31.99) },
  { id: 5, name: 'cpx31', cores: 4, memoryGb: 8, diskGb: 160, arch: 'x86', locations: US, prices: priced(US, 62.49) },
  { id: 6, name: 'cpx41', cores: 8, memoryGb: 16, diskGb: 240, arch: 'x86', locations: US, prices: priced(US, 120.49) },
];

// DigitalOcean's world (2026-09-09): one US-dollar list price everywhere, and
// the Sydney location Hetzner cannot offer. Slugs are DigitalOcean's own.
export const DO_LOCATIONS = [
  { name: 'syd1', city: 'Sydney', country: 'AU' },
  { name: 'sgp1', city: 'Singapore', country: 'SG' },
  { name: 'lon1', city: 'London', country: 'GB' },
  { name: 'fra1', city: 'Frankfurt', country: 'DE' },
  { name: 'nyc3', city: 'New York', country: 'US' },
  { name: 'sfo3', city: 'San Francisco', country: 'US' },
];
const DO_ALL = DO_LOCATIONS.map((l) => l.name);
export const DO_SERVER_TYPES = [
  { id: 's-2vcpu-4gb', name: 's-2vcpu-4gb', cores: 2, memoryGb: 4, diskGb: 80, arch: 'x86', locations: DO_ALL, prices: priced(DO_ALL, 24) },
  { id: 's-4vcpu-8gb', name: 's-4vcpu-8gb', cores: 4, memoryGb: 8, diskGb: 160, arch: 'x86', locations: DO_ALL, prices: priced(DO_ALL, 48) },
  { id: 's-8vcpu-16gb', name: 's-8vcpu-16gb', cores: 8, memoryGb: 16, diskGb: 320, arch: 'x86', locations: DO_ALL, prices: priced(DO_ALL, 96) },
];

// The third provider (2026-10-14), as its own list read that day: Scaleway in
// euros with the 80 GB disk included, Paris only.
const WORLDS = {
  scaleway: {
    locations: [{ name: 'fr-par-2', city: 'Paris', country: 'FR' }],
    types: [
      { id: 'BASIC2-A2C-4G', name: 'BASIC2-A2C-4G', cores: 2, memoryGb: 4, diskGb: 80, arch: 'arm', locations: ['fr-par-2'], prices: { 'fr-par-2': 24.38 } },
      { id: 'BASIC2-A2C-8G', name: 'BASIC2-A2C-8G', cores: 2, memoryGb: 8, diskGb: 80, arch: 'arm', locations: ['fr-par-2'], prices: { 'fr-par-2': 32.78 } },
      { id: 'BASIC2-A4C-16G', name: 'BASIC2-A4C-16G', cores: 4, memoryGb: 16, diskGb: 80, arch: 'arm', locations: ['fr-par-2'], prices: { 'fr-par-2': 57.89 } },
    ],
  },
};

// What POST /provision/validate answers for a good token, shaped exactly as
// provision-routes.mjs shapes it (the provider's symbol, chains and defaults
// ride along). Fresh objects every call: the page mutates nothing, but a
// fixture that hands out shared state is a fixture that rots.
export function catalogue(provider = 'hetzner') {
  const P = PROVIDERS[provider] || PROVIDERS.hetzner;
  const dO = P.id === 'digitalocean';
  const world = WORLDS[P.id] || (dO ? { locations: DO_LOCATIONS, types: DO_SERVER_TYPES } : { locations: LOCATIONS, types: SERVER_TYPES });
  const types = world.types.map((t) => ({ ...t, locations: [...t.locations], prices: { ...t.prices } }));
  return {
    ok: true,
    provider: P.id, label: P.label, symbol: P.symbol, chains: structuredClone(P.sizeChains),
    locations: world.locations.map((l) => ({ ...l })),
    server_types: types,
    defaults: { location: defaultLocationFor(P, types), server_type: P.defaults.serverType },
  };
}

// The engine's step names, in order, with the detail the real onStep carries
// (wizard/provision/engine.mjs). The door renders these lines verbatim, so a
// screenshot of the build screen shows what a person will actually read.
// What build-box.mjs's stepWords() turns the engine's step ids into (13 Oct 2026).
export const BUILD_STEPS = [
  'Checking your hosting token',
  'Adding this computer\u2019s key to your hosting account',
  'Creating your server',
  'Waiting for the server to switch on',
  'Server switched on, at 203.0.113.9',
];
