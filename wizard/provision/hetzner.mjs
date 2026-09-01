// hetzner.mjs — the self-host provisioning client (2026-09-01 pivot).
//
// Talks to the USER'S OWN Hetzner project with the USER'S OWN token. The token
// lives in-process for the life of a wizard run and is sent to exactly one
// host: api.hetzner.cloud. Nothing here phones any Crads service; there is no
// Crads service left to phone. Ownership by construction: the only SSH key on
// the box from first boot is the user's (see selfhost-cloudinit.mjs).

const API = 'https://api.hetzner.cloud/v1';

export class HetznerError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class HetznerClient {
  constructor(token, { fetchImpl = globalThis.fetch, api = API } = {}) {
    if (!token || typeof token !== 'string') throw new HetznerError('a Hetzner API token is required');
    this.token = token;
    this.fetch = fetchImpl;
    this.api = api;
  }

  async request(path, { method = 'GET', body } = {}) {
    // Network blips retry; API errors never do. Reads and idempotent deletes
    // retry blind; a create retries too because a failed FETCH means the
    // request may or may not have landed — but Hetzner name-uniqueness turns a
    // duplicate server create into a 409, which surfaces as an API error
    // rather than silent double metal. (Live-cert finding, 2026-09-01: the
    // wizard runs on residential networks; one dropped socket must not fail a run.)
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
        if (attempt >= 3) throw new HetznerError(`network failure talking to Hetzner: ${e.cause?.code || e.message}`, { code: 'network' });
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    let data = null;
    try { data = await res.json(); } catch { /* DELETE returns empty bodies */ }
    if (!res.ok) {
      const err = data?.error || {};
      throw new HetznerError(err.message || `Hetzner API ${res.status} on ${method} ${path}`, {
        status: res.status,
        code: err.code,
      });
    }
    return data;
  }

  /** Cheapest possible read; proves the token without touching anything. */
  async validateToken() {
    try {
      await this.request('/server_types?per_page=1');
      return { ok: true };
    } catch (e) {
      if (e.status === 401) return { ok: false, reason: 'unauthorized' };
      return { ok: false, reason: e.message };
    }
  }

  async listLocations() {
    const d = await this.request('/locations?per_page=50');
    return d.locations.map((l) => ({ name: l.name, city: l.city, country: l.country }));
  }

  async listServerTypes() {
    const d = await this.request('/server_types?per_page=50');
    return d.server_types
      .filter((t) => !t.deprecated)
      .map((t) => ({
        id: t.id, name: t.name, cores: t.cores, memoryGb: t.memory, diskGb: t.disk, arch: t.architecture,
        // real money, per location, from Hetzner's own price list: the page
        // shows people euros a month, not SKU strings
        prices: Object.fromEntries((t.prices || []).map((p) => [p.location, Number(p.price_monthly?.gross ?? p.price_monthly?.net ?? 0)])),
      }));
  }

  /**
   * Which server types each location actually SELLS. Hetzner's availability is
   * per datacentre, not global (the first real run picked cpx11 @ nbg1 and the
   * create answered "unsupported location for server type", 2026-09-01), so
   * the form must only offer pairs that exist. Map: location name -> Set-like
   * array of available server_type ids, unioned across the location's DCs.
   */
  async listAvailability() {
    const d = await this.request('/datacenters?per_page=50');
    const byLocation = {};
    for (const dc of d.datacenters || []) {
      const loc = dc.location?.name;
      if (!loc) continue;
      const ids = (dc.server_types?.available || []);
      byLocation[loc] = [...new Set([...(byLocation[loc] || []), ...ids])];
    }
    return byLocation;
  }

  /**
   * Make sure the user's public key exists in THEIR project and return its id.
   * A duplicate upload answers 409 uniqueness_error; that is the happy path on
   * a re-run, so it resolves by fingerprint lookup instead of failing.
   */
  async ensureSshKey(name, publicKey) {
    try {
      const d = await this.request('/ssh_keys', { method: 'POST', body: { name, public_key: publicKey } });
      return d.ssh_key.id;
    } catch (e) {
      if (e.code !== 'uniqueness_error') throw e;
      const d = await this.request('/ssh_keys?per_page=50');
      const match = d.ssh_keys.find((k) => k.public_key.trim().split(/\s+/)[1] === publicKey.trim().split(/\s+/)[1]);
      if (!match) throw new HetznerError('an SSH key with this name exists but its content differs; rename or remove it in the Hetzner console', { code: 'key_conflict' });
      return match.id;
    }
  }

  async createServer({ name, serverType, location, image = 'ubuntu-24.04', sshKeyIds, userData }) {
    const d = await this.request('/servers', {
      method: 'POST',
      body: {
        name,
        server_type: serverType,
        location,
        image,
        ssh_keys: sshKeyIds,
        user_data: userData,
        public_net: { enable_ipv4: true, enable_ipv6: true },
      },
    });
    return {
      id: d.server.id,
      ip: d.server.public_net?.ipv4?.ip ?? null,
      actionId: d.action?.id ?? null,
      rootPasswordUnused: null, // ssh_keys present ⇒ Hetzner sets no root password
    };
  }

  async waitAction(actionId, { timeoutMs = 300_000, pollMs = 3_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const d = await this.request(`/actions/${actionId}`);
      const a = d.action;
      if (a.status === 'success') return a;
      if (a.status === 'error') throw new HetznerError(a.error?.message || 'action failed', { code: a.error?.code });
      if (Date.now() > deadline) throw new HetznerError(`action ${actionId} still ${a.status} after ${timeoutMs}ms`, { code: 'timeout' });
      await sleep(pollMs);
    }
  }

  async getServer(id) {
    const d = await this.request(`/servers/${id}`);
    return { id: d.server.id, name: d.server.name, status: d.server.status, ip: d.server.public_net?.ipv4?.ip ?? null };
  }

  /** The retry-from-a-half-created-state path. Only ever the user's own metal. */
  async deleteServer(id) {
    await this.request(`/servers/${id}`, { method: 'DELETE' });
  }
}
