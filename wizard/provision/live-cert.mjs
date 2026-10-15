// live-cert.mjs — the wizard provisioning engine's first run against real metal.
//
//   HCLOUD_TOKEN=... node wizard/provision/live-cert.mjs create <name> <pubkey-file> <state-file>
//   HCLOUD_TOKEN=... node wizard/provision/live-cert.mjs destroy <state-file>
//   PROVIDER=digitalocean DO_TOKEN=... node wizard/provision/live-cert.mjs create|destroy ...   (2026-09-09)
//   PROVIDER=scaleway SCW_SECRET_KEY=... SCW_PROJECT_ID=... ...
// A provider that signs in with several values gets them as the same JSON
// string the door builds from its credential boxes.
//
//   PROVIDER=... node wizard/provision/live-cert.mjs probe <pubkey-file>   (2026-10-14)
// The no-spend half of a cert: everything a build does EXCEPT ordering a
// server. Signs in, reads the real locations, machines, prices and stock,
// resolves the default machine the door would offer, finds the Ubuntu image
// where the client looks one up, and adds then removes an SSH key. Nothing it
// does is billed. Sam's ruling: no money spent on testing (2026-10-14).
//
// Stands in for the wizard UI: same engine, same renderer, a throwaway box.
// The operator's own token plays the part of "the user's own token"; the cert
// is that the engine + rendered cloud-init produce a bootable, SSH-reachable,
// container-running mineral with no tunnel and no platform credentials aboard.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { provisionSelfHost, destroySelfHost } from './engine.mjs';
import { providerOf, defaultLocationFor, resolveSize } from './providers.mjs';

// This VPS has no IPv6 route and undici's fetch times out rather than falling
// back (live-cert finding #4, 2026-09-01), while plain node https over IPv4 is
// instant. The engine takes any fetch-shaped function, so the cert runs on one
// built from node:https pinned to family 4. User machines keep global fetch.
function ipv4Fetch(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpsRequest(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers, family: 4, timeout: 20000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: { get: (k) => { const v = res.headers[String(k).toLowerCase()]; return v == null ? null : String(v); } },
          json: async () => JSON.parse(data || 'null'),
          text: async () => data,
        }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const [, , cmd, ...args] = process.argv;
const P = providerOf(process.env.PROVIDER || 'hetzner');
// One env var per value; several values travel as the door's JSON string.
const CREDS = {
  hetzner: { token: 'HCLOUD_TOKEN' },
  digitalocean: { token: 'DO_TOKEN' },
  scaleway: { secretKey: 'SCW_SECRET_KEY', projectId: 'SCW_PROJECT_ID' },
}[P.id];
const missing = Object.values(CREDS).filter((v) => !process.env[v]);
if (missing.length) { console.error(`${missing.join(', ')} required`); process.exit(2); }
const token = CREDS.token ? process.env[CREDS.token]
  : JSON.stringify(Object.fromEntries(Object.entries(CREDS).map(([k, v]) => [k, process.env[v]])));
const client = () => P.makeClient(token, { fetchImpl: ipv4Fetch });

function loadState(p) { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}; }
function saveState(p, s) { writeFileSync(p, JSON.stringify(s, null, 2) + '\n'); }

if (cmd === 'probe') {
  const [pubkeyFile] = args;
  if (!pubkeyFile) { console.error('usage: live-cert.mjs probe <pubkey-file>'); process.exit(2); }
  const c = client();
  const ok = (label, v) => console.log(`PASS ${label}${v === undefined ? '' : `: ${v}`}`);
  const fail = (label, e) => { console.log(`FAIL ${label}: ${e && e.message ? e.message : e}`); process.exitCode = 1; };
  const step = async (label, fn) => { try { return await fn(); } catch (e) { fail(label, e); return undefined; } };
  const v = await step('validate', () => c.validateToken());
  if (!v || !v.ok) { fail('validate', (v && v.reason) || 'refused'); process.exit(1); }
  ok('validate');
  const locs = (await step('locations', () => c.listLocations())) || [];
  if (locs.length) ok('locations', locs.map((l) => `${l.name} (${l.city})`).join(', '));
  const types = (await step('machines', () => c.listServerTypes())) || [];
  if (types.length) ok('machines', `${types.length} listed`);
  const avail = (await step('availability', () => c.listAvailability())) || {};
  ok('availability', `${Object.keys(avail).length} locations`);
  const withLocs = types.map((t) => ({ ...t, locations: Object.entries(avail).filter(([, ids]) => ids.includes(t.id)).map(([l]) => l) }));
  const loc = defaultLocationFor(P, withLocs);
  for (const size of ['standard', 'roomy', 'large']) {
    const m = resolveSize(P, size, loc, withLocs);
    if (m) ok(`${size} @ ${loc}`, `${m.name}, ${m.cores} cpu, ${m.memoryGb} GB, ${P.symbol}${m.prices && m.prices[loc] != null ? m.prices[loc] : '?'} a month`);
    else fail(`${size} @ ${loc}`, 'no machine in the chain is sold there today');
  }
  if (typeof c.resolveImage === 'function') {
    const std = resolveSize(P, 'standard', loc, withLocs);
    const img = await step('image', () => c.resolveImage('ubuntu-24.04', std && std.name));
    if (img) ok('image', typeof img === 'object' ? (img.id || img.name || JSON.stringify(img)) : img);
  }
  const pub = readFileSync(pubkeyFile, 'utf8').trim();
  const keyId = await step('ssh key add', () => c.ensureSshKey(`crads-probe-${Date.now()}`, pub));
  if (keyId != null) {
    ok('ssh key add', keyId);
    const again = await step('ssh key add (re-run adopts)', () => c.ensureSshKey(`crads-probe-again-${Date.now()}`, pub));
    if (again != null) (String(again) === String(keyId) ? ok('ssh key re-run adopts', again) : fail('ssh key re-run adopts', `got a second key ${again}`));
    try { await c.deleteSshKey(keyId); ok('ssh key remove'); } catch (e) { fail('ssh key remove', e); }
  }
  console.log(process.exitCode ? 'PROBE: problems above' : 'PROBE: clean (no server was ordered)');
} else if (cmd === 'create') {
  const [boxName, pubkeyFile, stateFile] = args;
  const ownerPubKey = readFileSync(pubkeyFile, 'utf8').trim();
  const state = loadState(stateFile);
  try {
    const r = await provisionSelfHost({
      token, boxName, ownerPubKey, state, provider: P.id,
      onStep: (step, detail) => console.log(`step: ${step}${detail ? ` (${detail})` : ''}`),
      overrides: { client: client() },
    });
    saveState(stateFile, state);
    console.log(`OK server=${r.serverId} ip=${r.ip}`);
  } catch (e) {
    saveState(stateFile, state); // resumable; the half-created id is in here
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  }
} else if (cmd === 'destroy') {
  const [stateFile] = args;
  const state = loadState(stateFile);
  const r = await destroySelfHost({ token, state, provider: P.id, client: client() });
  saveState(stateFile, state);
  console.log(r.destroyed ? 'destroyed' : 'nothing to destroy');
} else {
  console.error('usage: live-cert.mjs probe <pubkey-file> | create <name> <pubkey-file> <state-file> | destroy <state-file>');
  process.exit(2);
}
