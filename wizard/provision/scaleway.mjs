// scaleway.mjs: the low-carbon self-host provisioning client (2026-10-14).
//
// Same contract as hetzner.mjs and digitalocean.mjs (see providers.mjs for the
// ten methods), same custody: the person's OWN Scaleway API key, in-process for
// one wizard run, sent to exactly one host, api.scaleway.com. Nothing here
// phones any Crads service.
//
// THE ZONE LOCK. This is the wizard's low-carbon option, and the claim rests on
// one datacentre: fr-par-2 (Scaleway's DC5 near Paris, French grid about 44
// gCO2e/kWh). Every method builds in, reads from or deletes in fr-par-2 only;
// asking for any other zone is a ScalewayError (code 'zone_refused'), never a
// silent fallback. Amsterdam and Warsaw would undo the claim.
//
// CREDENTIALS. Scaleway authenticates with `X-Auth-Token: <secret key>`, and a
// server create needs a Project ID. The wizard hands every client ONE string,
// so a multi-value credential is JSON: '{"secretKey":"...","projectId":"..."}'.
// A bare secret key is accepted too, but the Project ID CANNOT be discovered
// from the secret key alone (researched 2026-10-14): the IAM call that returns
// an API key's default_project_id is keyed by the ACCESS key, not the secret,
// needs IAM read permission, and Scaleway documents that field as the Object
// Storage default only; the Account API's project list requires the
// organisation ID, which the secret key does not reveal either. So a bare key
// validates to { ok:false } naming the missing Project ID.
//
// Field names and shapes were read from Scaleway's published OpenAPI specs on
// 2026-10-14 (Instance v1, IAM v1alpha1, Block v1, Marketplace v2), the
// scaleway-cli create flow and the scaleway Terraform provider:
//   - products/servers answers { servers: { "<TYPE>": { hourly_price (EUR),
//     monthly_price (deprecated, 30-day), ncpus, ram (bytes), arch x86_64|arm64,
//     gpu, end_of_service, per_volume_constraint.l_ssd } } }, paginated (50 a
//     page by default, 100 at most; fr-par-2 sells over a hundred types).
//   - products/servers/availability answers { servers: { "<TYPE>":
//     { availability: available|scarce|shortage } } }.
//   - a server is created STOPPED: POST .../servers, then the cloud-init text
//     goes in with PATCH .../servers/{id}/user_data/cloud-init (any content
//     type; we send text/plain), then POST .../servers/{id}/action
//     { action:'poweron' } answers { task: { id, status, ... } }.
//   - server state is running|stopped|stopped in place|starting|stopping|locked.
//   - 'terminate' needs a RUNNING server, deletes local (l_ssd) volumes and the
//     dynamic IP, but only DETACHES block (sbs_volume) volumes, which then bill
//     until deleted through the Block API. A stopped server is removed with
//     DELETE .../servers/{id} instead. deleteServer() below does both and then
//     deletes the block volumes it found, so nothing is left billing.
//   - SSH keys live in IAM, project-scoped, and Scaleway's images install every
//     enabled key of the project into root's authorized_keys at EVERY boot.
//     There is no per-server key list on create, so `sshKeyIds` is accepted and
//     unused; ownership still rides the cloud-init (selfhost-cloudinit.mjs).

import { applyNetDefaults } from '../net-defaults.mjs';

const API = 'https://api.scaleway.com';
export const ZONE = 'fr-par-2';
export const LOCATION = { name: ZONE, city: 'Paris', country: 'FR' };
// Scaleway's own Terraform provider validates cloud_init to 0..127998
// characters; we hold the stricter byte count to the same number.
export const USER_DATA_LIMIT = 127998;
// Every type in the size chains is block-storage only, so every server gets
// one block (sbs_volume) root of this size, made from the image (decimal GB,
// as Scaleway sizes volumes; a multiple of 512 bytes as the API requires).
export const ROOT_VOLUME_GB = 80;
export const ROOT_VOLUME_BYTES = ROOT_VOLUME_GB * 1_000_000_000;
// Scaleway bills by the hour and quotes a month as 730 hours.
export const HOURS_PER_MONTH = 730;
export const IMAGE_LABEL = 'ubuntu_noble'; // Ubuntu 24.04 in the Marketplace
export const TAG = 'crads-ai';
// The block class an sbs_volume made through the Instance API lands in.
const ROOT_VOLUME_TYPE = 'sbs_5k';
// After a poweron the API can still answer 'stopped' for a moment.
const POWERON_GRACE_MS = 120_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_KEY_RE = /^SCW[A-Z0-9]{17}$/;

export class ScalewayError extends Error {
  constructor(message, { status, code, serverId } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    if (serverId) this.serverId = serverId;
  }
}

/**
 * The one credential string, parsed. Never throws: a bad string comes back with
 * `error`, which validateToken reports as { ok:false } and every other method
 * throws, so the validate route always answers instead of hanging.
 */
export function parseCredentials(token) {
  const raw = String(token ?? '').trim();
  let secretKey; let projectId;
  if (raw.startsWith('{')) {
    let o;
    try { o = JSON.parse(raw); } catch { return { error: 'the Scaleway credentials are not valid JSON; paste the secret key, or {"secretKey":"...","projectId":"..."}' }; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: 'the Scaleway credentials must be an object with secretKey and projectId' };
    secretKey = String(o.secretKey ?? o.secret_key ?? '').trim();
    projectId = String(o.projectId ?? o.project_id ?? '').trim() || null;
    if (!secretKey) return { error: 'the Scaleway credentials have no secretKey' };
  } else {
    secretKey = raw;
    projectId = null;
  }
  if (ACCESS_KEY_RE.test(secretKey)) {
    return { error: 'that is the Scaleway ACCESS key (it starts with SCW); paste the SECRET key, the long one with dashes, shown once when the key was made' };
  }
  if (!UUID_RE.test(secretKey)) return { error: 'that does not look like a Scaleway secret key (36 characters: letters, digits and dashes)' };
  if (projectId && !UUID_RE.test(projectId)) return { error: 'that does not look like a Scaleway Project ID (36 characters: letters, digits and dashes)' };
  return { secretKey, projectId };
}

function refuseZone(zone, what) {
  if (zone !== undefined && zone !== null && zone !== ZONE) {
    throw new ScalewayError(`Scaleway is offered in ${ZONE} (Paris) only, the low-carbon zone; refusing to ${what} in ${zone}`, { code: 'zone_refused' });
  }
}

const round2 = (n) => Math.round(n * 100) / 100;
const normArch = (a) => (a === 'x86_64' || a === 'x86' ? 'x86' : a === 'arm64' || a === 'arm' ? 'arm' : null);
const keyBody = (k) => String(k || '').trim().split(/\s+/)[1];
const moneyOf = (m) => (m ? Number(m.units || 0) + Number(m.nanos || 0) / 1e9 : null);

export class ScalewayClient {
  constructor(token, { fetchImpl = globalThis.fetch, api = API, zone, sleep } = {}) {
    if (!token || typeof token !== 'string') throw new ScalewayError('a Scaleway API key is required');
    refuseZone(zone, 'open a client');
    const c = parseCredentials(token);
    // Not enumerable: a stray JSON.stringify(client) or console.log never
    // carries the secret.
    Object.defineProperty(this, 'secret', { value: c.secretKey || null, enumerable: false });
    this.projectId = c.projectId || null;
    this.credError = c.error || null;
    this.fetch = fetchImpl;
    applyNetDefaults(); // a far API on a slow link outlasts node's 250 ms attempt window (trap 65)
    this.api = api;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.poweringOn = new Map(); // server id -> when this client powered it on
    this._products = null;
  }

  creds() {
    if (this.credError) throw new ScalewayError(this.credError, { code: 'bad_credentials' });
  }

  requireProject() {
    this.creds();
    if (!this.projectId) {
      throw new ScalewayError('a Scaleway Project ID is needed as well as the secret key (console: Project settings)', { code: 'missing_project' });
    }
  }

  scrub(s) {
    return this.secret ? String(s).split(this.secret).join('[secret]') : String(s);
  }

  async request(path, { method = 'GET', body, text, retry = true, withHeaders = false } = {}) {
    this.creds();
    // Reads, deletes and the idempotent user_data PATCH retry a dropped
    // socket. A CREATE and a POWERON do not: Scaleway does not make server
    // names unique, so a lost create answer retried is two servers on the
    // person's bill. createServer() recovers a lost answer by name instead.
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await this.fetch(`${this.api}${path}`, {
          method,
          headers: {
            'X-Auth-Token': this.secret,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(text !== undefined ? { 'Content-Type': 'text/plain' } : {}),
          },
          body: body ? JSON.stringify(body) : text,
        });
        break;
      } catch (e) {
        if (!retry || attempt >= 3) throw new ScalewayError(this.scrub(`network failure talking to Scaleway: ${e.cause?.code || e.message}`), { code: 'network' });
        await this.sleep(1500 * attempt);
      }
    }
    let data = null;
    try { data = await res.json(); } catch { /* 204 on DELETE and PATCH user_data has no body */ }
    if (!res.ok) {
      // A new Scaleway account may build nothing in Paris: every fr-par
      // server quota starts at 0 until the account's ID document is accepted
      // (live, 2026-10-14: "quota(s) exceeded for this resource" on the first
      // create, with Organization > Quotas reading 0/0 for every type in PAR).
      // Said in words a person can act on, not Scaleway's.
      if (data?.type === 'quotas_exceeded' || /quota\(?s?\)? exceeded/i.test(String(data?.message || ''))) {
        throw new ScalewayError('Scaleway has not opened Paris to your account yet. New accounts must verify an ID document first: in the Scaleway console open Organization, then Quotas, and press "Verify ID". Once Scaleway accepts it, press Retry.', {
          status: res.status,
          code: 'quota',
        });
      }
      // Scaleway errors are { type, message, ... }; `type` is the code
      // (denied_authentication, permission_denied, not_found, ...).
      throw new ScalewayError(this.scrub(data?.message || `Scaleway API ${res.status} on ${method} ${path.split('?')[0]}`), {
        status: res.status,
        code: data?.type,
      });
    }
    if (withHeaders) return { data, total: Number(res.headers?.get?.('x-total-count')) || null };
    return data;
  }

  /** A map-shaped paginated read ({ servers: { NAME: {...} } }), all pages. */
  async pagedMap(path, key) {
    const out = {};
    for (let page = 1; page <= 20; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const { data, total } = await this.request(`${path}${sep}per_page=100&page=${page}`, { withHeaders: true });
      const chunk = data?.[key] || {};
      Object.assign(out, chunk);
      const n = Object.keys(chunk).length;
      if (n < 100 || (total && Object.keys(out).length >= total)) break;
    }
    return out;
  }

  /**
   * Proves the key, the Project ID and both permissions a build needs, reading
   * only. 401/403 answer 'unauthorized' (with a `detail` saying which part).
   */
  async validateToken() {
    if (this.credError) return { ok: false, reason: this.credError };
    if (!this.projectId) {
      return { ok: false, reason: 'missing project ID: Scaleway needs the Project ID as well as the secret key, and cannot work it out from the key alone (console: Project settings)' };
    }
    const p = encodeURIComponent(this.projectId);
    try {
      await this.request(`/instance/v1/zones/${ZONE}/servers?project=${p}&per_page=1`);
    } catch (e) {
      if (e.status === 401) return { ok: false, reason: 'unauthorized' };
      if (e.status === 403) return { ok: false, reason: 'unauthorized', detail: 'the key cannot read Instances in that Project (it needs InstancesFullAccess there)' };
      return { ok: false, reason: e.message };
    }
    try {
      await this.request(`/iam/v1alpha1/ssh-keys?project_id=${p}&page_size=1`);
    } catch (e) {
      if (e.status === 401) return { ok: false, reason: 'unauthorized' };
      if (e.status === 403) return { ok: false, reason: 'unauthorized', detail: 'the key cannot read SSH keys in that Project (it needs SSHKeysFullAccess there)' };
      return { ok: false, reason: e.message };
    }
    // A wrong Project ID can still pass the two reads above for an
    // organisation-wide key (an empty list is a fine answer). When the key may
    // read projects, check the ID names a real one; a 403 here only means the
    // key was not given ProjectReadOnly, which a build does not need.
    try {
      await this.request(`/account/v3/projects/${p}`);
    } catch (e) {
      if (e.status === 404) return { ok: false, reason: 'no Scaleway Project has that ID; copy it from Project settings in the console' };
      if (e.status === 401) return { ok: false, reason: 'unauthorized' };
    }
    return { ok: true };
  }

  async listLocations() {
    return [{ ...LOCATION }];
  }

  productsRaw() {
    if (!this._products) {
      this._products = this.pagedMap(`/instance/v1/zones/${ZONE}/products/servers`, 'servers');
      this._products.catch(() => { this._products = null; }); // a failed read must not poison the next
    }
    return this._products;
  }

  /** Monthly price of the block root every server gets, or null if unreadable. */
  async rootVolumeMonthly() {
    if (this._rootVolMonthly !== undefined) return this._rootVolMonthly;
    try {
      const d = await this.request(`/block/v1/zones/${ZONE}/volume-types?page_size=100`);
      const types = d?.volume_types || [];
      const t = types.find((v) => v.type === ROOT_VOLUME_TYPE) || null;
      const perGbHour = moneyOf(t?.pricing); // the API prices block per GB per hour
      this._rootVolMonthly = perGbHour == null ? null : round2(perGbHour * ROOT_VOLUME_GB * HOURS_PER_MONTH);
    } catch (e) {
      if (e.status === 401) throw e;
      this._rootVolMonthly = null;
    }
    return this._rootVolMonthly;
  }

  /**
   * Every buildable type sold in fr-par-2: no GPU, no Windows-licence types,
   * nothing at end of service. `prices` is the month of what a build actually
   * creates: the server (hourly x 730) plus its 80 GB block root, because
   * Hetzner and DigitalOcean quote a disk inside their price and the page
   * compares like with like. `priceParts` keeps the two apart. Not included:
   * the public IPv4, which Scaleway bills separately while the server runs.
   */
  async listServerTypes(location) {
    refuseZone(location, 'list machines');
    const raw = await this.productsRaw();
    const vol = await this.rootVolumeMonthly();
    return Object.entries(raw)
      .filter(([name, t]) => !t.end_of_service && !(Number(t.gpu) > 0) && !/-WIN$/i.test(name))
      .map(([name, t]) => {
        const server = t.hourly_price != null ? round2(Number(t.hourly_price) * HOURS_PER_MONTH) : round2(Number(t.monthly_price || 0));
        const localMax = Number(t.per_volume_constraint?.l_ssd?.max_size || 0);
        return {
          id: name, name, cores: t.ncpus, memoryGb: Math.round(Number(t.ram || 0) / 2 ** 30),
          // the block root we create, whatever local disk the type could carry
          diskGb: ROOT_VOLUME_GB, rootVolume: 'block', localDiskGb: localMax ? Math.round(localMax / 1e9) : 0,
          arch: normArch(t.arch),
          prices: { [ZONE]: round2(server + (vol || 0)) },
          priceParts: { server, rootVolume: vol },
        };
      });
  }

  /**
   * fr-par-2 -> the types it can build today. 'scarce' still builds;
   * 'shortage' does not. If the availability read fails (anything but a bad
   * key), every listed type is offered rather than a dead form.
   */
  async listAvailability(location) {
    refuseZone(location, 'list availability');
    let listed = null;
    try { listed = Object.keys(await this.productsRaw()); } catch (e) { if (e.status === 401 || e.status === 403) throw e; }
    try {
      const avail = await this.pagedMap(`/instance/v1/zones/${ZONE}/products/servers/availability`, 'servers');
      const ok = Object.entries(avail).filter(([, a]) => a?.availability !== 'shortage').map(([n]) => n);
      return { [ZONE]: listed ? ok.filter((n) => listed.includes(n)) : ok };
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw e;
      return { [ZONE]: listed || [] };
    }
  }

  async archOf(serverType) {
    try {
      const t = (await this.productsRaw())[serverType];
      return normArch(t?.arch);
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw e;
      return null;
    }
  }

  /**
   * Ubuntu 24.04 for this machine. The Marketplace keeps one local image per
   * architecture and per volume kind, each listing the commercial types it
   * boots; a block root needs the instance_sbs one, and an Arm type needs the
   * arm64 build. A UUID passed in is used as given.
   */
  async resolveImage(image, serverType) {
    if (image && UUID_RE.test(String(image))) return String(image);
    const label = !image || /^ubuntu-?24\.04$/.test(String(image)) ? IMAGE_LABEL : String(image);
    const arch = await this.archOf(serverType);
    const d = await this.request(`/marketplace/v2/local-images?image_label=${encodeURIComponent(label)}&zone=${ZONE}&type=instance_sbs&page_size=100`);
    const type = String(serverType).toUpperCase();
    const hit = (d?.local_images || []).find((li) => li.type === 'instance_sbs'
      && (!li.zone || li.zone === ZONE)
      && (li.compatible_commercial_types || []).includes(type)
      && (!arch || normArch(li.arch) === arch));
    if (!hit) throw new ScalewayError(`Scaleway has no ${arch ? `${arch} ` : ''}${label} image for ${serverType} in ${ZONE}`, { code: 'image_not_found' });
    return hit.id;
  }

  async listSshKeys(projectId) {
    const all = [];
    for (let page = 1; page <= 20; page++) {
      const q = projectId ? `project_id=${encodeURIComponent(projectId)}&` : '';
      const d = await this.request(`/iam/v1alpha1/ssh-keys?${q}page_size=100&page=${page}`);
      const chunk = d?.ssh_keys || [];
      all.push(...chunk);
      if (chunk.length < 100 || (d.total_count && all.length >= d.total_count)) break;
    }
    return all;
  }

  /**
   * Make sure the person's public key is an SSH key of THEIR project and return
   * its id. Looked up by key body first (the re-run path); a disabled match is
   * re-enabled, since Scaleway only installs enabled keys.
   */
  async ensureSshKey(name, publicKey) {
    this.requireProject();
    const body = keyBody(publicKey);
    const enable = async (k) => {
      if (k.disabled) await this.request(`/iam/v1alpha1/ssh-keys/${encodeURIComponent(k.id)}`, { method: 'PATCH', body: { disabled: false } });
      return k.id;
    };
    const mine = (await this.listSshKeys(this.projectId)).find((k) => keyBody(k.public_key) === body);
    if (mine) return enable(mine);
    try {
      const k = await this.request('/iam/v1alpha1/ssh-keys', { method: 'POST', body: { name, public_key: publicKey, project_id: this.projectId } });
      return k.id;
    } catch (e) {
      if (e.status !== 409 && !/already exist/i.test(e.message)) throw e;
      // A race, or the same key in another project of the organisation.
      const again = (await this.listSshKeys(this.projectId)).find((k) => keyBody(k.public_key) === body);
      if (again) return enable(again);
      throw new ScalewayError('Scaleway refused the SSH key: the same key is already in another Project of this organisation, and Scaleway only puts a Project\'s own keys on its servers; remove it there in the console, or use that Project', { code: 'key_conflict', status: e.status });
    }
  }

  /** A box being removed from a team: its owner key goes too. Already gone is done. */
  async deleteSshKey(id) {
    try {
      await this.request(`/iam/v1alpha1/ssh-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }

  /** The newest of OUR servers carrying this exact name, or null. */
  async findByName(name) {
    const d = await this.request(`/instance/v1/zones/${ZONE}/servers?project=${encodeURIComponent(this.projectId)}&name=${encodeURIComponent(name)}&per_page=50`);
    const hits = (d?.servers || []).filter((s) => s.name === name && (s.tags || []).includes(TAG));
    hits.sort((a, b) => String(b.creation_date || '').localeCompare(String(a.creation_date || '')));
    return hits[0] || null;
  }

  async createServer({ name, serverType, location, sshKeyIds, userData, image } = {}) {
    refuseZone(location, 'build a server');
    this.requireProject();
    if (!name || !serverType) throw new ScalewayError('a server name and type are required', { code: 'bad_request' });
    const ud = String(userData || '');
    if (Buffer.byteLength(ud, 'utf8') > USER_DATA_LIMIT) {
      throw new ScalewayError(`cloud-init is over Scaleway's ${USER_DATA_LIMIT}-byte user data limit`, { code: 'user_data_too_large' });
    }
    const imageId = await this.resolveImage(image, serverType);
    let server;
    try {
      const d = await this.request(`/instance/v1/zones/${ZONE}/servers`, {
        method: 'POST', retry: false,
        body: {
          name,
          project: this.projectId,
          commercial_type: serverType,
          image: imageId,
          volumes: { 0: { volume_type: 'sbs_volume', size: ROOT_VOLUME_BYTES } },
          dynamic_ip_required: true,
          tags: [TAG, name],
        },
      });
      server = d.server;
    } catch (e) {
      if (e.code !== 'network') throw e;
      // The request may have landed. Adopt by name if it did; only if nothing
      // carries the name is it safe to say the create never happened.
      server = await this.findByName(name);
      if (!server) throw e;
    }
    return this.finishCreate(server, ud);
  }

  /**
   * cloud-init in, then power on. A failure here leaves a real server behind,
   * so the error carries its id for the wizard's destroy-and-retry.
   */
  async finishCreate(server, userData) {
    const id = server.id;
    let actionId = null;
    try {
      if (server.state === 'stopped' || server.state === 'stopped in place' || !server.state) {
        await this.request(`/instance/v1/zones/${ZONE}/servers/${encodeURIComponent(id)}/user_data/cloud-init`, { method: 'PATCH', text: userData });
        actionId = await this.powerOn(id);
      }
    } catch (e) {
      if (e instanceof ScalewayError) {
        e.serverId = id;
        e.message = `${e.message} (server ${id} was created and must be removed before a retry)`;
        throw e;
      }
      throw new ScalewayError(`${this.scrub(e.message)} (server ${id} was created and must be removed before a retry)`, { serverId: id });
    }
    return { id, ip: publicIpv4(server), actionId, rootPasswordUnused: null };
  }

  async powerOn(id) {
    try {
      const d = await this.request(`/instance/v1/zones/${ZONE}/servers/${encodeURIComponent(id)}/action`, { method: 'POST', retry: false, body: { action: 'poweron' } });
      this.poweringOn.set(id, Date.now());
      return d?.task?.id ?? null;
    } catch (e) {
      if (e.code !== 'network') throw e;
      // Did it land? A server already starting means yes; never send a second.
      const s = (await this.request(`/instance/v1/zones/${ZONE}/servers/${encodeURIComponent(id)}`)).server;
      if (s.state === 'starting' || s.state === 'running') { this.poweringOn.set(id, Date.now()); return null; }
      throw e;
    }
  }

  /**
   * Polls the poweron task. The task fields are marked deprecated in the
   * spec and the task endpoint is not in the published v1 spec, so a 404 here
   * is not a failure: it answers 'unverified' and the engine's getServer()
   * polling, which runs next anyway, decides.
   */
  async waitAction(taskId, { timeoutMs = 300_000, pollMs = 3_000, sleep = this.sleep, zone } = {}) {
    refuseZone(zone, 'wait on a task');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let t;
      try {
        t = (await this.request(`/instance/v1/zones/${ZONE}/tasks/${encodeURIComponent(taskId)}`)).task;
      } catch (e) {
        if (e.status === 404) return { id: taskId, status: 'unverified' };
        throw e;
      }
      if (t.status === 'success') return t;
      if (t.status === 'failure') throw new ScalewayError(`Scaleway task ${taskId} (${t.description || 'poweron'}) failed`, { code: 'action_failed' });
      if (Date.now() > deadline) throw new ScalewayError(`task ${taskId} still ${t.status} after ${timeoutMs}ms`, { code: 'timeout' });
      await sleep(pollMs);
    }
  }

  async getServer(id, { zone } = {}) {
    refuseZone(zone, 'read a server');
    const s = (await this.request(`/instance/v1/zones/${ZONE}/servers/${encodeURIComponent(id)}`)).server;
    return { id: s.id, name: s.name, status: this.statusOf(s), ip: publicIpv4(s) };
  }

  /** Optional (2026-10-14): which machine, where, so a delete can name its monthly price. */
  async describeServer(id) {
    const s = (await this.request(`/instance/v1/zones/${ZONE}/servers/${encodeURIComponent(id)}`)).server;
    return { serverType: s.commercial_type ?? null, location: s.zone ?? ZONE };
  }

  // The engine's vocabulary: running | starting | off | unknown.
  statusOf(s) {
    if (s.state === 'running') return 'running';
    if (s.state === 'starting') return 'starting';
    if (s.state === 'stopped' || s.state === 'stopped in place' || s.state === 'stopping') {
      const since = this.poweringOn.get(s.id);
      if (s.state === 'stopped' && since && Date.now() - since < POWERON_GRACE_MS) return 'starting';
      return 'off';
    }
    return 'unknown';
  }

  /**
   * destroy-and-retry, and leaving nothing billing behind. A running server is
   * terminated (Scaleway refuses to DELETE a running one); a stopped one, which
   * terminate refuses, is DELETEd. Either way the block root survives as a
   * detached volume, so it is deleted through the Block API once the server is
   * gone. Gone (404) at any step is the outcome wanted.
   *
   * IPs: the build asks for a DYNAMIC IPv4, which Scaleway releases with the
   * server. A flexible (non-dynamic) IP on the server was not made by this
   * client, so it is NOT deleted (that would lose someone's address for good);
   * its ids come back in `keptFlexibleIps` so a caller can say so.
   */
  async deleteServer(id, { timeoutMs = 300_000, pollMs = 3_000, sleep = this.sleep, zone } = {}) {
    refuseZone(zone, 'delete a server');
    const path = `/instance/v1/zones/${ZONE}/servers/${encodeURIComponent(id)}`;
    const read = async () => {
      try { return (await this.request(path)).server; } catch (e) { if (e.status === 404) return null; throw e; }
    };
    const deadline = Date.now() + timeoutMs;
    let s = await read();
    if (!s) return { keptFlexibleIps: [] };
    const vols = Object.values(s.volumes || {});
    const blockIds = vols.filter((v) => v.volume_type === 'sbs_volume').map((v) => v.id);
    const localIds = vols.filter((v) => v.volume_type === 'l_ssd').map((v) => v.id);
    const keptFlexibleIps = (s.public_ips || []).filter((ip) => ip.dynamic === false && ip.id).map((ip) => ip.id);

    // Wait out a transition, then remove it the way its state allows.
    while (s && !['running', 'stopped', 'stopped in place'].includes(s.state)) {
      if (Date.now() > deadline) throw new ScalewayError(`server ${id} stayed '${s.state}' too long to delete`, { code: 'timeout' });
      await sleep(pollMs);
      s = await read();
    }
    if (s) {
      try {
        if (s.state === 'running') await this.request(`${path}/action`, { method: 'POST', body: { action: 'terminate' } });
        else await this.request(path, { method: 'DELETE' });
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      // terminate is asynchronous: wait for the server itself to be gone
      while (await read()) {
        if (Date.now() > deadline) throw new ScalewayError(`server ${id} not gone after ${timeoutMs}ms`, { code: 'timeout' });
        await sleep(pollMs);
      }
    }

    for (const v of blockIds) await this.deleteBlockVolume(v, { deadline, pollMs, sleep });
    for (const v of localIds) await this.deleteQuietly(`/instance/v1/zones/${ZONE}/volumes/${encodeURIComponent(v)}`);
    return { keptFlexibleIps };
  }

  async deleteQuietly(path) {
    try { await this.request(path, { method: 'DELETE' }); } catch (e) { if (e.status !== 404) throw e; }
  }

  /** A block volume deletes only once detached ('available'); wait for that. */
  async deleteBlockVolume(volId, { deadline, pollMs, sleep }) {
    const path = `/block/v1/zones/${ZONE}/volumes/${encodeURIComponent(volId)}`;
    for (;;) {
      let v;
      try { v = await this.request(path); } catch (e) { if (e.status === 404) return; throw e; }
      if (v.status === 'available' || v.status === 'error') {
        try { await this.request(path, { method: 'DELETE' }); return; } catch (e) { if (e.status === 404) return; throw e; }
      }
      if (Date.now() > deadline) throw new ScalewayError(`the server is gone but its disk ${volId} is still '${v.status}'; delete it in the Scaleway console (Block Storage) to stop it billing`, { code: 'volume_cleanup' });
      await sleep(pollMs);
    }
  }
}

function publicIpv4(server) {
  const v4 = (server?.public_ips || []).find((ip) => ip.family === 'inet' && ip.address);
  return v4?.address ?? server?.public_ip?.address ?? null;
}
