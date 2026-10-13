// hetzner.mjs: the self-host provisioning client (2026-09-01 pivot).
//
// Talks to the USER'S OWN Hetzner project with the USER'S OWN token. The token
// lives in-process for the life of a wizard run and is sent to exactly one
// host: api.hetzner.cloud. Nothing here phones any Crads service; there is no
// Crads service left to phone. Ownership by construction: the only SSH key on
// the box from first boot is the user's (see selfhost-cloudinit.mjs).

import { applyNetDefaults } from '../net-defaults.mjs';

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
    applyNetDefaults(); // a far API on a slow link outlasts node's 250 ms attempt window (trap 65)
    this.api = api;
  }

  async request(path, { method = 'GET', body } = {}) {
    // Network blips retry; API errors never do. Reads and idempotent deletes
    // retry blind; a create retries too because a failed FETCH means the
    // request may or may not have landed, but Hetzner name-uniqueness turns a
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

  /**
   * Every server type the project can see, all pages, fetched ONCE per client
   * (the catalogue and the availability both read it, and a validate answer
   * asks for both). Hetzner answers 26 types today on one page; the loop is
   * there so a 51st type never silently drops off the end of page one.
   */
  serverTypesRaw() {
    if (!this._typesRaw) {
      this._typesRaw = (async () => {
        const all = [];
        for (let page = 1; page <= 20; page++) {
          const d = await this.request(`/server_types?per_page=50&page=${page}`);
          all.push(...(d.server_types || []));
          const next = d.meta?.pagination?.next_page;
          if (!next) break;
        }
        return all;
      })();
      // a failed read must not poison the next attempt
      this._typesRaw.catch(() => { this._typesRaw = null; });
    }
    return this._typesRaw;
  }

  async listServerTypes() {
    return (await this.serverTypesRaw())
      .filter((t) => !t.deprecated && !t.deprecation)
      .map((t) => ({
        id: t.id, name: t.name, cores: t.cores, memoryGb: t.memory, diskGb: t.disk, arch: t.architecture,
        // real money, per location, from Hetzner's own price list: the page
        // shows people euros a month, not SKU strings
        prices: Object.fromEntries((t.prices || []).map((p) => [p.location, Number(p.price_monthly?.gross ?? p.price_monthly?.net ?? 0)])),
      }));
  }

  /**
   * Which server types each location actually SELLS right now. Hetzner's
   * availability is per location, not global (the first real run picked cpx11
   * @ nbg1 and the create answered "unsupported location for server type",
   * 2026-09-01), so the form must only offer pairs that exist.
   *
   * Read from /server_types, where each type carries `locations: [{ name,
   * available, recommended, deprecation }]`. Until 2026-10-13 this read
   * /datacenters, which Hetzner REMOVED (it answers "deprecated_api_endpoint",
   * changelog 2026-06-02); the route swallowed the error and offered every type
   * everywhere, so the default (cx33 @ nbg1, sold nowhere that day) failed at
   * create-server. Map: location name -> array of available server type ids.
   */
  async listAvailability() {
    const byLocation = {};
    for (const t of await this.serverTypesRaw()) {
      if (t.deprecated || t.deprecation) continue;
      for (const l of t.locations || []) {
        if (!l?.name || l.available !== true || l.deprecation) continue;
        (byLocation[l.name] ||= []).push(t.id);
      }
    }
    return byLocation;
  }

  /** 'arm' or 'x86' for a server type name, from the same one read. */
  async architectureOf(serverType) {
    const t = (await this.serverTypesRaw()).find((x) => x.name === serverType || String(x.id) === String(serverType));
    return t?.architecture || null;
  }

  /**
   * A system image NAME (e.g. 'ubuntu-24.04') exists once per architecture,
   * each with its own id. An Arm server (cax) needs the arm build, so the
   * create sends the id that matches the server type rather than trusting a
   * name to resolve the right way. An id passed in is used as given.
   */
  async resolveImage(image, serverType) {
    if (typeof image === 'number' || /^\d+$/.test(String(image))) return Number(image);
    let arch = null;
    try { arch = await this.architectureOf(serverType); } catch (e) { if (e.status === 401) throw e; }
    // Unknown type, or the catalogue unreadable: send the name and let the
    // create answer in Hetzner's own words rather than guess an architecture.
    if (!arch) return image;
    const q = `/images?type=system&status=available&name=${encodeURIComponent(image)}&architecture=${encodeURIComponent(arch)}`;
    const d = await this.request(q);
    const hit = (d.images || []).find((i) => i.name === image && i.architecture === arch && !i.deprecated);
    if (!hit) throw new HetznerError(`Hetzner has no ${arch} build of ${image}`, { code: 'image_not_found' });
    return hit.id;
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
    const imageRef = await this.resolveImage(image, serverType);
    const d = await this.request('/servers', {
      method: 'POST',
      body: {
        name,
        server_type: serverType,
        location,
        image: imageRef,
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

  /** Someone left a team (2026-10-11): their box's owner key goes too. Already gone is done. */
  async deleteSshKey(id) {
    try {
      await this.request(`/ssh_keys/${id}`, { method: 'DELETE' });
    } catch (e) {
      if (e.code !== 'not_found' && e.status !== 404) throw e;
    }
  }
}
