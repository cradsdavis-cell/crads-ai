// providers.mjs: the hosting providers the self-host wizard can build on
// (2026-09-09, second provider). A REGISTRY, not a second hard-wire: the
// engine, the door's routes and the door page all read this table, so adding
// a provider is one entry here plus one client module, and nothing else
// learns a new name.
//
// THE CLIENT CONTRACT. Every provider ships a class the engine drives through
// ten methods (deleteSshKey added 2026-10-11 for a team member leaving), all async, all against the person's OWN account with the
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
    costsCopy: 'a Hetzner cloud server, about €6 to €21 a month for the sizes we recommend (more in a location that only sells the dearer Intel and AMD machines), billed to you by Hetzner in euros',
    blurb: 'German hosting, cheapest by some way. Locations in Germany, Finland, the US and Singapore.',
    // Arm first (Sam's ruling, 2026-10-13): the product images are multi-arch
    // (linux/amd64 + linux/arm64 under one :v2 index), and Hetzner's Arm
    // machines (cax) are the cheapest 8 GB it sells. hel1 sells all three Arm
    // sizes; nbg1 sells none of them today. The default location is the first
    // of `locationPreference` that sells the default machine on the day (see
    // defaultLocationFor), so a location running dry moves the default rather
    // than failing the build.
    defaults: { location: 'hel1', serverType: 'cax21' },
    locationPreference: ['hel1', 'fsn1', 'nbg1'],
    // Preference chains: the first type in the chain the chosen location
    // SELLS wins. Each chain holds one memory size (4 / 8 / 16 GB): Arm (cax,
    // EU only), then Intel shared (cx, EU, the cheapest x86 when it is in
    // stock), then AMD shared (cpx), which is all the US and Singapore sell.
    // A smaller machine is never substituted for a sold-out one.
    sizeChains: {
      small: ['cax11', 'cx23', 'cpx21', 'cpx22'],
      standard: ['cax21', 'cx33', 'cpx31', 'cpx32'],
      roomy: ['cax31', 'cx43', 'cpx41', 'cpx42'],
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

const soldAt = (t, loc) => !!t && Array.isArray(t.locations) && t.locations.includes(loc);

/**
 * The first machine in a size's chain that `location` sells, from a catalogue
 * whose types carry `locations` (the validate answer's shape). null when the
 * location sells nothing in that chain.
 */
export function resolveSize(P, size, location, types) {
  const byName = Object.fromEntries((types || []).map((t) => [t.name, t]));
  for (const name of P.sizeChains[size] || []) if (soldAt(byName[name], location)) return byName[name];
  return null;
}

/**
 * The location the form opens on: the provider's default if it sells the
 * default machine today, else the first preferred location that does, else
 * the first that sells anything in the Standard chain, else the static
 * default (an unreadable catalogue never blocks the form).
 */
export function defaultLocationFor(P, types) {
  const order = [...new Set([P.defaults.location, ...(P.locationPreference || [])])];
  const def = (types || []).find((t) => t.name === P.defaults.serverType);
  for (const loc of order) if (soldAt(def, loc)) return loc;
  for (const loc of order) if (resolveSize(P, 'standard', loc, types)) return loc;
  return P.defaults.location;
}

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
