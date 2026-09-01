// live-cert.mjs — the wizard provisioning engine's first run against real metal.
//
//   HCLOUD_TOKEN=... node wizard/provision/live-cert.mjs create <name> <pubkey-file> <state-file>
//   HCLOUD_TOKEN=... node wizard/provision/live-cert.mjs destroy <state-file>
//
// Stands in for the wizard UI: same engine, same renderer, a throwaway box.
// The operator's own token plays the part of "the user's own token"; the cert
// is that the engine + rendered cloud-init produce a bootable, SSH-reachable,
// container-running mineral with no tunnel and no platform credentials aboard.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { provisionSelfHost, destroySelfHost } from './engine.mjs';
import { HetznerClient } from './hetzner.mjs';

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
          json: async () => JSON.parse(data || 'null'),
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
const token = process.env.HCLOUD_TOKEN;
if (!token) { console.error('HCLOUD_TOKEN required'); process.exit(2); }

function loadState(p) { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}; }
function saveState(p, s) { writeFileSync(p, JSON.stringify(s, null, 2) + '\n'); }

if (cmd === 'create') {
  const [boxName, pubkeyFile, stateFile] = args;
  const ownerPubKey = readFileSync(pubkeyFile, 'utf8').trim();
  const state = loadState(stateFile);
  try {
    const r = await provisionSelfHost({
      token, boxName, ownerPubKey, state,
      onStep: (step, detail) => console.log(`step: ${step}${detail ? ` (${detail})` : ''}`),
      overrides: { client: new HetznerClient(token, { fetchImpl: ipv4Fetch }) },
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
  const r = await destroySelfHost({ token, state, client: new HetznerClient(token, { fetchImpl: ipv4Fetch }) });
  saveState(stateFile, state);
  console.log(r.destroyed ? 'destroyed' : 'nothing to destroy');
} else {
  console.error('usage: live-cert.mjs create <name> <pubkey-file> <state-file> | destroy <state-file>');
  process.exit(2);
}
