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
//
// ONLY OUR OWN DROPLETS (2026-10-19, after a member who already had a droplet
// read the build as "trying to override" it). The person's account may hold
// droplets this app has nothing to do with, and nothing here may act on one.
// The rules: a create always makes a NEW droplet; every droplet the app makes
// carries a random run tag, minted for that one create and written into the
// build record; the lost-answer recovery looks for that run tag and nothing
// else; and a delete reads the droplet first and refuses unless it carries the
// record's run tag (a record from before this date: the old `aios-<name>`
// self-tag). No other droplet is listed, read, matched, renamed or deleted.

import { applyNetDefaults } from '../net-defaults.mjs';
import { RUN_TAG_RE, newRunTag } from './run-tag.mjs';

const API = 'https://api.digitalocean.com/v2';
export const USER_DATA_LIMIT = 64 * 1024;

// Region slugs carry their city in the prefix; the API's `name` is the display
// name ("Sydney 1"). The door shows "<city>, <country>" for every provider, so
// the country comes from this small table rather than a second request.
const COUNTRY = { nyc: 'US', sfo: 'US', atl: 'US', ams: 'NL', sgp: 'SG', lon: 'GB', fra: 'DE', tor: 'CA', blr: 'IN', syd: 'AU' };

// A run tag: what marks a droplet as made by one particular create (shared
// with the other cloud clients since 2026-10-19, run-tag.mjs).
export { RUN_TAG_RE, newRunTag };

// The plain words for the two refusals a member can actually meet at create
// time. DigitalOcean's own text ("creating this/these droplet(s) will exceed
// your droplet limit") read, next to a droplet the person already had, as the
// app trying to replace it.
export const limitWords = (limit, count) => `${limit == null ? 'Your DigitalOcean account is at its droplet limit' : `Your DigitalOcean account allows ${limit} droplet${limit === 1 ? '' : 's'} and already has ${count}`}. The app makes a new droplet for your assistant and never changes or deletes the ones you already have, so DigitalOcean will not let it make another one. Ask DigitalOcean to raise your droplet limit (from your account settings in the DigitalOcean console), or choose Hetzner instead. Nothing has been changed.`;
const SCOPE_WORDS = 'DigitalOcean refused this token for that step. The app needs a token with read and write access (Full Access, or a custom token that can create droplets, SSH keys and tags). Make a new token with that access and check again. Nothing has been changed.';

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
    applyNetDefaults(); // a far API on a slow link outlasts node's 250 ms attempt window (trap 65)
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

  /**
   * Proves the token and that the account may create anything. Read-only.
   * Also reads the account's droplet limit and how many droplets it has (a
   * count only: GET /droplets?per_page=1 answers meta.total and at most one
   * droplet, which is never looked at), so a full account is told so in plain
   * words BEFORE anything is made. A count that cannot be read is not a
   * reason to stop: the create's own refusal is mapped to the same words.
   */
  async validateToken() {
    try {
      const d = await this.request('/account');
      const a = d.account || {};
      if (a.status && a.status !== 'active') {
        return { ok: false, reason: `the DigitalOcean account is ${a.status}${a.status_message ? `: ${a.status_message}` : ''}` };
      }
      const limit = Number.isInteger(a.droplet_limit) ? a.droplet_limit : null;
      if (limit != null) {
        let count = null;
        try { const t = (await this.request('/droplets?per_page=1')).meta?.total; count = Number.isInteger(t) ? t : null; } catch { count = null; }
        if (count != null && count >= limit) return { ok: false, plain: true, code: 'droplet_limit', reason: limitWords(limit, count) };
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
   * The Basic (shared CPU) droplets only, the `s-*` slugs: DigitalOcean sells
   * x86 only, and the wizard's three size cards resolve through them. Memory
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

  async createServer({ name, serverType, location, image = 'ubuntu-24-04-x64', sshKeyIds, userData, runTag = newRunTag() }) {
    if (Buffer.byteLength(String(userData || ''), 'utf8') > USER_DATA_LIMIT) {
      throw new DigitalOceanError(`cloud-init is over DigitalOcean's ${USER_DATA_LIMIT / 1024} KiB user_data limit`, { code: 'user_data_too_large' });
    }
    if (!RUN_TAG_RE.test(runTag)) throw new DigitalOceanError('internal: a run tag must look like crads-run-<16 hex>', { code: 'bad_run_tag' });
    // Two tags. The run tag is minted for THIS create alone, so a droplet that
    // carries it is this create's droplet by construction: that is how a lost
    // answer is found again (below) and what a delete checks for. The name tag
    // is only there so the person can find the droplet in their console.
    // (Until 2026-10-19 the name tag did both jobs, and any droplet tagged
    // `aios-<name>`, from an earlier run or another computer, would have been
    // adopted as this run's.)
    let d;
    try {
      d = await this.request('/droplets', {
        method: 'POST', retry: false,
        body: {
          name, region: location, size: serverType, image,
          ssh_keys: sshKeyIds, user_data: userData,
          ipv6: true, backups: false, monitoring: false, with_droplet_agent: false,
          tags: [name, runTag],
        },
      });
    } catch (e) {
      if (e.status === 422 && /droplet limit/i.test(e.message)) throw new DigitalOceanError(limitWords(), { status: 422, code: 'droplet_limit' });
      if (e.status === 403) throw new DigitalOceanError(SCOPE_WORDS, { status: 403, code: 'forbidden' });
      if (e.code !== 'network') throw e;
      // The request may have landed. Adopt by RUN tag if it did; only if
      // nothing carries it is it safe to say the create never happened. More
      // than one cannot be ours (a create is never retried), so that stops.
      const found = await this.request(`/droplets?tag_name=${encodeURIComponent(runTag)}&per_page=10`);
      const mine = found.droplets || [];
      if (!mine.length) throw e;
      if (mine.length > 1) throw new DigitalOceanError(`found ${mine.length} droplets tagged ${runTag}; expected at most one, so the app has not adopted any of them`, { code: 'run_tag_ambiguous' });
      return { id: mine[0].id, ip: publicIp(mine[0]), actionId: null, runTag };
    }
    const dr = d.droplet;
    const create = (d.links?.actions || []).find((a) => a.rel === 'create');
    return {
      id: dr.id,
      ip: publicIp(dr),          // usually null at create time; getServer() fills it once active
      actionId: create?.id ?? null,
      runTag,                    // the engine writes it into the build record; deleteServer checks it
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

  /** Optional (2026-10-14): which machine, where, so a delete can name its monthly price. */
  async describeServer(id) {
    const dr = (await this.request(`/droplets/${id}`)).droplet;
    return { serverType: dr.size_slug ?? dr.size?.slug ?? null, location: dr.region?.slug ?? null };
  }

  /**
   * destroy-and-retry; a droplet already gone (404) is the outcome wanted.
   * Reads the droplet first and deletes it ONLY if it carries the build
   * record's run tag. A record from before run tags (no `runTag`) falls back
   * to what the app made then: a droplet named `aios-...` tagged with its own
   * name. Anything else is refused, and nothing is changed.
   */
  async deleteServer(id, { runTag } = {}) {
    let dr;
    try {
      dr = (await this.request(`/droplets/${id}`)).droplet;
    } catch (e) {
      if (e.status === 404) return;
      throw e;
    }
    const tags = Array.isArray(dr?.tags) ? dr.tags : [];
    const ours = runTag
      ? tags.includes(runTag)
      : /^aios-/.test(String(dr?.name || '')) && tags.includes(dr.name);
    if (!ours) {
      throw new DigitalOceanError(`The droplet ${dr?.name ? `"${dr.name}" ` : ''}(id ${id}) does not carry the tag this app put on the droplet it made, so the app has not deleted it. Nothing has been changed. If it is one you no longer want, delete it yourself in the DigitalOcean console.`, { code: 'not_ours' });
    }
    try {
      await this.request(`/droplets/${id}`, { method: 'DELETE' });
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }

  /** Someone left a team (2026-10-11): their box's owner key goes too. Already gone is done. */
  async deleteSshKey(id) {
    try {
      await this.request(`/account/keys/${id}`, { method: 'DELETE' });
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
