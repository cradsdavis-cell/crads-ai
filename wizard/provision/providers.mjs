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
//
// Optional entry fields (2026-10-14, the third provider):
//   credentialFields  [{ key, label, secret, placeholder, help, optional }] for a
//                     provider that signs in with more than one value (Scaleway). The door
//                     shows one box per value and sends them as ONE JSON string
//                     in the usual `token` slot, so routes, the engine and the
//                     team flow carry it unchanged; the client parses it. Still
//                     in memory only, never written down.
//   tokenSteps        plain-text steps for the door's "how to get one" fold
//   tokenNote         the line under them (where the token goes, how to revoke)
//   ownServer         true for "a server you already have": no cloud account, no
//                     prices, no sizes; the door shows this mineral's key to put
//                     on the server instead, and provision-routes adds the
//                     mineral's name to the details so the client finds its key.
//   preview           true until the provider has passed a live build on a real
//                     account (wizard/provision/live-cert.mjs). A preview
//                     provider is buildable by id but is not listed to members
//                     unless CRADS_PROVIDER_PREVIEW=1 is set (operator testing).
import { HetznerClient } from './hetzner.mjs';
import { DigitalOceanClient } from './digitalocean.mjs';
import { ScalewayClient } from './scaleway.mjs';
import { OwnServerClient } from './own-server.mjs';

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
    blurb: 'German hosting, cheapest by some way. Builds in Helsinki by default, on one of Europe\u2019s cleanest grids. Also Germany, the US and Singapore.',
    // Arm first (Sam's ruling, 2026-10-13): the product images are multi-arch
    // (linux/amd64 + linux/arm64 under one :v2 index), and Hetzner's Arm
    // machines (cax) are the cheapest 8 GB it sells. hel1 sells all three Arm
    // sizes; nbg1 sells none of them today. The default location is the first
    // of `locationPreference` that sells the default machine on the day (see
    // defaultLocationFor), so a location running dry moves the default rather
    // than failing the build.
    defaults: { location: 'hel1', serverType: 'cax11' },
    locationPreference: ['hel1', 'fsn1', 'nbg1'],
    // Preference chains: the first type in the chain the chosen location
    // SELLS wins. Each chain holds one memory size (4 / 8 / 16 GB): Arm (cax,
    // EU only), then Intel shared (cx, EU, the cheapest x86 when it is in
    // stock), then AMD shared (cpx), which is all the US and Singapore sell.
    // A smaller machine is never substituted for a sold-out one.
    // Sizes moved down one step (Sam, 2026-10-15): Standard 4 GB, Roomy
    // 8 GB, Extra roomy (`large`) 16 GB; see the size cards in door.html.
    sizeChains: {
      standard: ['cax11', 'cx23', 'cpx21', 'cpx22'],
      roomy: ['cax21', 'cx33', 'cpx31', 'cpx32'],
      large: ['cax31', 'cx43', 'cpx41', 'cpx42'],
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
    defaults: { location: 'syd1', serverType: 's-2vcpu-4gb' },
    // Same machine SPECS as the Hetzner chains (4 / 8 / 16 GB), so "Small",
    // "Standard" and "Roomy" mean the same thing on either provider. The
    // memory-matched fallback exists for a region that sells the amd variant
    // only; a smaller machine is never substituted, because an assistant that
    // runs out of memory is worse than a dearer one.
    sizeChains: {
      standard: ['s-2vcpu-4gb', 's-2vcpu-4gb-amd'],
      roomy: ['s-4vcpu-8gb', 's-4vcpu-8gb-amd'],
      large: ['s-8vcpu-16gb', 's-8vcpu-16gb-amd'],
    },
    makeClient: (token, opts) => new DigitalOceanClient(token, opts),
  },
  own: {
    id: 'own',
    label: 'A server you already have',
    currency: '',
    symbol: '',
    console: '',
    tokenLabel: 'Your server',
    tokenHelpDocSlug: 'use-a-server-you-already-have',
    costsCopy: 'a Linux server you already have: rented anywhere (AWS, Google Cloud, Azure, any host) or a machine you own at home or in the office. You pay whoever runs it, or just the electricity',
    blurb: 'AWS, Google Cloud, Azure, or a machine you own. Ubuntu 24.04, 4 GB of memory or more, used for this alone.',
    // Sam's ruling (2026-10-15): "cover all the bases". One path for a server
    // made outside the app, rented or owned; see own-server.mjs. It takes over
    // the machine's firewall (SSH in on 22, nothing else), hence "for this
    // alone".
    // Proven end to end on 2026-10-15 on a stand-in Ubuntu 24.04 server
    // (check, setup through its own cloud-init, the member login answering
    // through the full chain, pin, registered; a second run is safe), so it
    // is listed. Not yet run on a real AWS, Google or Azure machine.
    ownServer: true,
    defaults: { location: 'own', serverType: 'own' },
    sizeChains: { standard: ['own'], roomy: ['own'], large: ['own'] },
    credentialFields: [
      { key: 'host', label: 'Server address', secret: false, placeholder: '203.0.113.10 or myserver.example.com', help: 'Its public IP address or hostname. A machine at home: its address on your network, or its Tailscale name.' },
      { key: 'user', label: 'Login name', secret: false, placeholder: 'ubuntu', help: 'A login with passwordless sudo: ubuntu on AWS; on Google Cloud, the last word of the key you added; on Azure, the user name you chose (azureuser unless you changed it); on your own machine, your own login.' },
    ],
    tokenSteps: [
      'Make (or pick) a server running Ubuntu 24.04 with at least 4 GB of memory, used for this alone: setup turns on a firewall that lets in SSH and nothing else.',
      'Press "Show my key" and add that key to the server for a login with passwordless sudo. In AWS, Google Cloud and Azure there is an SSH key box when you create the server; on your own machine, add it to that login\u2019s ~/.ssh/authorized_keys.',
      'Make sure the server accepts SSH on port 22 from this computer. Cloud servers: allow SSH in the server\u2019s firewall settings. At home: be on the same network, or use Tailscale.',
      'Type the server\u2019s address and the login name below, then press Check the server.',
    ],
    tokenNote: 'Nothing secret is asked for: no cloud password or key reaches this app. The app connects with this mineral\u2019s own key, which never leaves this computer.',
    makeClient: (token, opts) => new OwnServerClient(token, opts),
  },
  scaleway: {
    id: 'scaleway',
    label: 'Scaleway (low-carbon)',
    currency: 'EUR',
    symbol: '€',
    console: 'console.scaleway.com',
    tokenLabel: 'Your Scaleway secret key and Project ID',
    tokenHelpDocSlug: 'get-a-scaleway-api-key',
    costsCopy: 'a Scaleway server in Paris, about €24 to €58 a month for the sizes we recommend (including its 80 GB disk; the public IPv4 address is billed on top), billed to you by Scaleway in euros',
    blurb: 'French hosting on a low-carbon grid (about 44 gCO2e per kWh, more than ten times cleaner than New South Wales). One location: Paris.',
    // PARKED 2026-10-15 (Sam): stays preview, NOT to be listed. Live: a new
    // Scaleway account gets 0/0 quota for every server type in Paris even
    // after phone and ID verification; opening Paris needs a support request,
    // so a member would face four hurdles before a first build. The eco line
    // moved to Hetzner Helsinki (Finland's grid about 57 gCO2e/kWh in 2025)
    // instead. Kept, not deleted, in case Scaleway's new-account rules loosen.
    // Sam's ruling (2026-10-14): the eco option. LOCKED to fr-par-2 (DC5):
    // the claim is the French grid plus DC5's published PUE and Scaleway's
    // per-customer footprint report; Amsterdam (about 253 g) or Warsaw (about
    // 615 g) would undo it, so scaleway.mjs refuses every other zone. Chains
    // match on memory: the cheapest 8 GB machine is the 2 vCPU Arm BASIC2.
    preview: true,
    defaults: { location: 'fr-par-2', serverType: 'BASIC2-A2C-4G' },
    locationPreference: ['fr-par-2'],
    sizeChains: {
      standard: ['BASIC2-A2C-4G', 'PLAY2-NANO'],
      roomy: ['BASIC2-A2C-8G', 'BASIC2-A4C-8G', 'PLAY2-MICRO'],
      large: ['BASIC2-A4C-16G', 'PRO2-XS'],
    },
    credentialFields: [
      { key: 'secretKey', label: 'Secret key', secret: true, placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', help: 'The long key with dashes, shown once when you generate the API key. Not the access key that starts with SCW.' },
      { key: 'projectId', label: 'Project ID', secret: false, placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', help: 'In the Scaleway console: Project settings, then copy the Project ID.' },
    ],
    tokenSteps: [
      'Make a Scaleway account at console.scaleway.com if you do not have one, and add a payment method.',
      'Verify your phone number (the banner at the top of the console) and your ID (Organization, then Quotas, then "Verify ID"). Scaleway will not build servers in Paris for a new account until both are done, and the ID check can take a little while.',
      'Pick a Project in the top bar (Default Project is fine), open Project settings and copy the Project ID into the box below. A separate Project for your assistant keeps its server apart from anything else you run there.',
      'Open IAM from the organisation menu (top right), then API keys, then "Generate API key". The simplest bearer is yourself; give it no expiry or a date you will remember, and answer No to the Object Storage question.',
      'Copy the Secret key straight away (shown once) into the box below. Ignore the access key that starts with SCW.',
    ],
    tokenNote: 'These stay on this computer and are sent only to Scaleway\u2019s own API. The secret key is the key to your account, so treat it like a password; you can delete it any time from the same page.',
    makeClient: (token, opts) => new ScalewayClient(token, opts),
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
// the order the door shows the cards in. Preview providers (not yet proven on
// real metal) are left out unless the operator opts in.
export function publicProviders({ includePreview = process.env.CRADS_PROVIDER_PREVIEW === '1' } = {}) {
  return Object.values(PROVIDERS)
    .filter((p) => includePreview || !p.preview)
    .map(({ makeClient, ...rest }) => structuredClone(rest));
}
