// providers.mjs: the hosting providers the self-host wizard can build on
// (2026-09-09, second provider). A REGISTRY, not a second hard-wire: the
// engine, the door's routes and the door page all read this table, so adding
// a provider is one entry here plus one client module, and nothing else
// learns a new name.
//
// THE CLIENT CONTRACT. Every provider ships a class the engine drives through
// nine methods, all async, all against the person's OWN account with the
// person's OWN token (hetzner.mjs is the reference implementation,
// digitalocean.mjs the second):
//
//   validateToken()                 -> { ok, reason? }   reason 'unauthorized' on a bad token
//   listLocations()                 -> [{ name, city, country }]      name = the API's slug
//   listServerTypes()               -> [{ id, name, cores, memoryGb, diskGb, arch, prices: { <location>: monthly } }]
//   listAvailability()              -> { <location>: [<server type id>] }
//   ensureSshKey(name, publicKey)   -> key id, idempotent on a re-run
//   createServer({ name, serverType, location, sshKeyIds, userData }) -> { id, ip, actionId }
//   waitAction(actionId)            -> the finished action, or throws
//   getServer(id)                   -> { id, name, status, ip }   status 'running' when it is up
//   deleteServer(id)                -> nothing; a server already gone is not an error
//
// Prices are whatever the provider's own price list says, in the provider's
// own currency; `symbol` is how the page writes it. Nothing here is a price
// Crads-AI charges: there is nothing to charge.
import { HetznerClient } from './hetzner.mjs';
import { DigitalOceanClient } from './digitalocean.mjs';

export const PROVIDERS = {
  hetzner: {
    id: 'hetzner',
    label: 'Hetzner',
    currency: 'EUR',
    symbol: '€',
    console: 'console.hetzner.com',
    tokenLabel: 'Your Hetzner API token',
    tokenHelpDocSlug: 'get-a-hetzner-api-token',
    costsCopy: 'a Hetzner cloud server, roughly €4 to €30 a month depending on the size you pick, billed to you by Hetzner in euros',
    blurb: 'German hosting, cheapest by some way. Locations in Germany, Finland, the US and Singapore.',
    defaults: { location: 'nbg1', serverType: 'cx33' },
    // Preference chains, amd64 only (the product images are amd64): the first
    // type in the chain the chosen location sells wins. cx is Intel shared
    // (EU locations); cpx covers the rest of the world.
    sizeChains: {
      small: ['cx23', 'cpx21', 'cpx22'],
      standard: ['cx33', 'cpx31', 'cpx32'],
      roomy: ['cx43', 'cpx41', 'cpx42'],
    },
    makeClient: (token, opts) => new HetznerClient(token, opts),
  },
  digitalocean: {
    id: 'digitalocean',
    label: 'DigitalOcean',
    currency: 'USD',
    symbol: '$',
    console: 'cloud.digitalocean.com',
    tokenLabel: 'Your DigitalOcean API token',
    tokenHelpDocSlug: 'get-a-digitalocean-api-token',
    costsCopy: 'a DigitalOcean droplet, roughly $24 to $96 a month depending on the size you pick, billed to you by DigitalOcean in US dollars',
    blurb: 'Dearer than Hetzner at the same size, but it has a Sydney location, and locations across the US, Europe and Asia.',
    // Sydney first: the one location Hetzner cannot offer an Australian.
    defaults: { location: 'syd1', serverType: 's-4vcpu-8gb' },
    // Same machine SPECS as the Hetzner chains (4 / 8 / 16 GB), so "Small",
    // "Standard" and "Roomy" mean the same thing on either provider. The
    // memory-matched fallback exists for a region that sells the amd variant
    // only; a smaller machine is never substituted, because an assistant that
    // runs out of memory is worse than a dearer one.
    sizeChains: {
      small: ['s-2vcpu-4gb', 's-2vcpu-4gb-amd'],
      standard: ['s-4vcpu-8gb', 's-4vcpu-8gb-amd'],
      roomy: ['s-8vcpu-16gb', 's-8vcpu-16gb-amd'],
    },
    makeClient: (token, opts) => new DigitalOceanClient(token, opts),
  },
};

export const DEFAULT_PROVIDER = 'hetzner';

export function providerOf(id) {
  const p = PROVIDERS[id || DEFAULT_PROVIDER];
  if (!p) throw new Error(`unknown provider: ${id}`);
  return p;
}

// The registry as a page can receive it: no functions, fresh objects. Order is
// the order the door shows the cards in.
export function publicProviders() {
  return Object.values(PROVIDERS).map(({ makeClient, ...rest }) => structuredClone(rest));
}
