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
// Prices are Hetzner's list prices as read on 2026-09-09, gross, rounded the
// way the door rounds them. They are INDICATIVE: any page that shows them
// says so (claims.mjs BILLING_SHOTS), and the wizard reads live prices when a
// person actually runs it. Tests never touch provisioning (harness/lib/
// live-guard.sh); nothing in this file can.

import { PROVIDERS, publicProviders } from '../provision/providers.mjs';
export { publicProviders };

export function fakeClient(calls, provider = 'hetzner') {
  return {
    validateToken: async () => ({ ok: true }),
    listLocations: async () => [{ name: 'nbg1', city: 'Nuremberg', country: 'DE' }],
    listServerTypes: async () => [
      { id: 1, name: 'cx33', cores: 4, memoryGb: 8, diskGb: 80, arch: 'x86' },
      { id: 2, name: 'cpx11', cores: 2, memoryGb: 2, diskGb: 40, arch: 'x86' },
    ],
    listAvailability: async () => ({ nbg1: [1], hel1: [1, 2] }),
    ensureSshKey: async () => 7,
    createServer: async (o) => { calls.push(['create', o.name, provider]); return { id: 42, ip: '203.0.113.9', actionId: 9 }; },
    waitAction: async () => ({ status: 'success' }),
    getServer: async () => ({ id: 42, name: 'aios-demo', status: 'running', ip: '203.0.113.9' }),
    deleteServer: async (id) => { calls.push(['delete', id, provider]); },
  };
}

// The door's catalogue world. cx (Intel shared) is sold in the EU datacentres
// only; cpx everywhere. That split is what the door's per-location filter
// exists for, so the fixture keeps it.
export const LOCATIONS = [
  { name: 'nbg1', city: 'Nuremberg', country: 'DE' },
  { name: 'fsn1', city: 'Falkenstein', country: 'DE' },
  { name: 'hel1', city: 'Helsinki', country: 'FI' },
  { name: 'ash', city: 'Ashburn, VA', country: 'US' },
  { name: 'hil', city: 'Hillsboro, OR', country: 'US' },
  { name: 'sin', city: 'Singapore', country: 'SG' },
];
const EU = ['nbg1', 'fsn1', 'hel1'];
const ALL = LOCATIONS.map((l) => l.name);
const priced = (locs, eur) => Object.fromEntries(locs.map((l) => [l, eur]));
export const SERVER_TYPES = [
  { id: 1, name: 'cx23', cores: 2, memoryGb: 4, diskGb: 40, arch: 'x86', locations: EU, prices: priced(EU, 4.75) },
  { id: 2, name: 'cx33', cores: 4, memoryGb: 8, diskGb: 80, arch: 'x86', locations: EU, prices: priced(EU, 7.72) },
  { id: 3, name: 'cx43', cores: 8, memoryGb: 16, diskGb: 160, arch: 'x86', locations: EU, prices: priced(EU, 14.27) },
  { id: 4, name: 'cpx21', cores: 3, memoryGb: 4, diskGb: 80, arch: 'x86', locations: ALL, prices: priced(ALL, 8.39) },
  { id: 5, name: 'cpx31', cores: 4, memoryGb: 8, diskGb: 160, arch: 'x86', locations: ALL, prices: priced(ALL, 15.59) },
  { id: 6, name: 'cpx41', cores: 8, memoryGb: 16, diskGb: 240, arch: 'x86', locations: ALL, prices: priced(ALL, 29.63) },
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

// What POST /provision/validate answers for a good token, shaped exactly as
// provision-routes.mjs shapes it (the provider's symbol, chains and defaults
// ride along). Fresh objects every call: the page mutates nothing, but a
// fixture that hands out shared state is a fixture that rots.
export function catalogue(provider = 'hetzner') {
  const P = PROVIDERS[provider] || PROVIDERS.hetzner;
  const dO = P.id === 'digitalocean';
  return {
    ok: true,
    provider: P.id, label: P.label, symbol: P.symbol, chains: structuredClone(P.sizeChains),
    locations: (dO ? DO_LOCATIONS : LOCATIONS).map((l) => ({ ...l })),
    server_types: (dO ? DO_SERVER_TYPES : SERVER_TYPES).map((t) => ({ ...t, locations: [...t.locations], prices: { ...t.prices } })),
    defaults: { location: P.defaults.location, server_type: P.defaults.serverType },
  };
}

// The engine's step names, in order, with the detail the real onStep carries
// (wizard/provision/engine.mjs). The door renders these lines verbatim, so a
// screenshot of the build screen shows what a person will actually read.
export const BUILD_STEPS = [
  'validate-token',
  'ensure-ssh-key',
  'create-server (cx33 @ nbg1)',
  'wait-running',
  'done (203.0.113.9)',
];
