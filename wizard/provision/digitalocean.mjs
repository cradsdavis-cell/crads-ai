// digitalocean.mjs: the second self-host provisioning client (2026-09-09).
//
// Same contract as hetzner.mjs (see providers.mjs for the nine methods), same
// custody: the person's OWN DigitalOcean token, in-process for one wizard run,
// sent to exactly one host, api.digitalocean.com. Nothing here phones any
// Crads service. Field names were read from DigitalOcean's published OpenAPI
// specification (github.com/digitalocean/openapi) on 2026-09-09: account
// status is active|warning|locked, sizes carry `memory` in MB and
// `price_monthly` in US dollars with the `regions` that sell them, a droplet
// create takes `ssh_keys` ids and `user_data` (64 KiB at most) and answers
// `droplet` plus `links.actions`, droplet status is new|active|off|archive,
// and an action is in-progress|completed|errored.

const API = 'https://api.digitalocean.com/v2';
export const USER_DATA_LIMIT = 64 * 1024;

// Region slugs carry their city in the prefix; the API's `name` is the display
// name ("Sydney 1"). The door shows "<city>, <country>" for every provider, so
// the country comes from this small table rather than a second request.
const COUNTRY = { nyc: 'US', sfo: 'US', atl: 'US', ams: 'NL', sgp: 'SG', lon: 'GB', fra: 'DE', tor: 'CA', blr: 'IN', syd: 'AU' };

export class DigitalOceanError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class DigitalOceanClient {
  constructor(token, { fetchImpl = globalThis.fetch, api = API } = {}) {
    if (!token || typeof token !== 'string') throw new DigitalOceanError('a DigitalOcean API token is required');
    this.token = token;
    this.fetch = fetchImpl;
    this.api = api;
    this.regionsCache = null;
  }

  async request(path, { method = 'GET', body, retry = true } = {}) {
    // Reads and deletes retry a dropped socket, as the Hetzner client does.
    // A CREATE does not: DigitalOcean does not make droplet names unique, so
    // a create whose answer was lost and then retried is two droplets on the
    // person's bill. createServer() below recovers the lost answer by tag
    // instead of by retrying.
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await this.fetch(`${this.api}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        break;
      } catch (e) {
        if (!retry || attempt >= 3) throw new DigitalOceanError(`network failure talking to DigitalOcean: ${e.cause?.code || e.message}`, { code: 'network' });
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    let data = null;
    try { data = await res.json(); } catch { /* 204 on DELETE has no body */ }
    if (!res.ok) {
      // DigitalOcean errors are { id, message, request_id }; `id` is the code.
      throw new DigitalOceanError(data?.message || `DigitalOcean API ${res.status} on ${method} ${path}`, {
        status: res.status,
        code: data?.id,
      });
    }
    return data;
  }

  /** Proves the token and that the account may create anything. Read-only. */
  async validateToken() {
    try {
      const d = await this.request('/account');
      const a = d.account || {};
      if (a.status && a.status !== 'active') {
        return { ok: false, reason: `the DigitalOcean account is ${a.status}${a.status_message ? `: ${a.status_message}` : ''}` };
      }
      return { ok: true };
    } catch (e) {
      if (e.status === 401) return { ok: false, reason: 'unauthorized' };
      return { ok: false, reason: e.message };
    }
  }

  async regions() {
    if (!this.regionsCache) {
      const d = await this.request('/regions?per_page=200');
      this.regionsCache = (d.regions || []).filter((r) => r.available !== false);
    }
    return this.regionsCache;
  }

  async listLocations() {
    return (await this.regions()).map((r) => ({
      name: r.slug,
      city: String(r.name || r.slug).replace(/\s*\d+$/, ''),
      country: COUNTRY[String(r.slug).slice(0, 3)] || '',
    }));
  }

  /**
   * The Basic (shared CPU) droplets only, the `s-*` slugs: the product images
   * are amd64 and the wizard's three size cards resolve through them. Memory
   * comes back in megabytes; the page thinks in gigabytes.
   */
  async listServerTypes() {
    const d = await this.request('/sizes?per_page=200');
    return (d.sizes || [])
      .filter((s) => s.available !== false && /^s-/.test(s.slug))
      .map((s) => ({
        id: s.slug, name: s.slug, cores: s.vcpus, memoryGb: Math.round((s.memory || 0) / 1024), diskGb: s.disk, arch: 'x86',
        // One list price everywhere, in US dollars: DigitalOcean does not
        // price per region, but the door reads prices per location, so the
        // same number is stamped on every region that sells the size.
        prices: Object.fromEntries((s.regions || []).map((r) => [r, Number(s.price_monthly || 0)])),
      }));
  }

  /** location -> the size slugs it sells (the API's own `sizes` per region). */
  async listAvailability() {
    const out = {};
    for (const r of await this.regions()) out[r.slug] = [...(r.sizes || [])];
    return out;
  }

  /**
   * DigitalOcean refuses a public key it already holds with a 422 ("SSH Key is
   * already in use on your account"). A re-run hits exactly that, so a 422
   * resolves by listing the keys and matching on the key body.
   */
  async ensureSshKey(name, publicKey) {
    const keyBody = (k) => String(k || '').trim().split(/\s+/)[1];
    try {
      const d = await this.request('/account/keys', { method: 'POST', body: { name, public_key: publicKey } });
      return d.ssh_key.id;
    } catch (e) {
      if (e.status !== 422) throw e;
      const d = await this.request('/account/keys?per_page=200');
      const match = (d.ssh_keys || []).find((k) => keyBody(k.public_key) === keyBody(publicKey));
      if (!match) throw new DigitalOceanError('DigitalOcean refused the SSH key and no matching key is on the account; remove any stale key named like it in the DigitalOcean console', { code: 'key_conflict' });
      return match.id;
    }
  }

  async createServer({ name, serverType, location, image = 'ubuntu-24-04-x64', sshKeyIds, userData }) {
    if (Buffer.byteLength(String(userData || ''), 'utf8') > USER_DATA_LIMIT) {
      throw new DigitalOceanError(`cloud-init is over DigitalOcean's ${USER_DATA_LIMIT / 1024} KiB user_data limit`, { code: 'user_data_too_large' });
    }
    // The tag is how a lost create answer is found again (below); one tag per
    // box name, so a re-run after a dropped socket adopts rather than doubles.
    const tag = name;
    let d;
    try {
      d = await this.request('/droplets', {
        method: 'POST', retry: false,
        body: {
          name, region: location, size: serverType, image,
          ssh_keys: sshKeyIds, user_data: userData,
          ipv6: true, backups: false, monitoring: false, with_droplet_agent: false,
          tags: [tag],
        },
      });
    } catch (e) {
      if (e.code !== 'network') throw e;
      // The request may have landed. Adopt by tag if it did; only if nothing
      // carries the tag is it safe to say the create never happened.
      const found = await this.request(`/droplets?tag_name=${encodeURIComponent(tag)}&per_page=10`);
      const dr = (found.droplets || [])[0];
      if (!dr) throw e;
      return { id: dr.id, ip: publicIp(dr), actionId: null };
    }
    const dr = d.droplet;
    const create = (d.links?.actions || []).find((a) => a.rel === 'create');
    return {
      id: dr.id,
      ip: publicIp(dr),          // usually null at create time; getServer() fills it once active
      actionId: create?.id ?? null,
      rootPasswordUnused: null,
    };
  }

  async waitAction(actionId, { timeoutMs = 300_000, pollMs = 3_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const d = await this.request(`/actions/${actionId}`);
      const a = d.action;
      if (a.status === 'completed') return a;
      if (a.status === 'errored') throw new DigitalOceanError(`droplet create action ${actionId} errored`, { code: 'action_errored' });
      if (Date.now() > deadline) throw new DigitalOceanError(`action ${actionId} still ${a.status} after ${timeoutMs}ms`, { code: 'timeout' });
      await sleep(pollMs);
    }
  }

  async getServer(id) {
    const d = await this.request(`/droplets/${id}`);
    const dr = d.droplet;
    // The engine's vocabulary: running | starting | off | unknown.
    const status = dr.status === 'active' ? 'running' : dr.status === 'new' ? 'starting' : dr.status === 'off' ? 'off' : 'unknown';
    return { id: dr.id, name: dr.name, status, ip: publicIp(dr) };
  }

  /** destroy-and-retry; a droplet already gone (404) is the outcome wanted. */
  async deleteServer(id) {
    try {
      await this.request(`/droplets/${id}`, { method: 'DELETE' });
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
}

function publicIp(droplet) {
  const v4 = droplet?.networks?.v4 || [];
  const pub = v4.find((n) => n.type === 'public');
  return pub?.ip_address ?? null;
}
