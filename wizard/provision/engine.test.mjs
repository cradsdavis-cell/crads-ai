// engine.test.mjs — the self-host provisioning engine against a stubbed
// Hetzner API. Nothing here reaches the network; the fetch stub IS the API.
//   node --test wizard/provision/engine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HetznerClient } from './hetzner.mjs';
import { renderSelfHostCloudInit } from './selfhost-cloudinit.mjs';
import { provisionSelfHost, destroySelfHost } from './engine.mjs';

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF6zXyq1x2Qq0m7T3v9m4T8u5X6a7B8c9D0e1F2g3H4i owner@wizard';

function fakeHetzner(log = []) {
  let nextServer = 101;
  const routes = {
    'GET /server_types?per_page=1': () => ({ server_types: [] }),
    'POST /ssh_keys': (body) => ({ ssh_key: { id: 7, public_key: body.public_key } }),
    'POST /servers': (body) => {
      assert.match(body.name, /^aios-/);
      assert.ok(body.user_data.includes(PUB), 'owner key must be in cloud-init');
      return { server: { id: nextServer, public_net: { ipv4: { ip: '198.51.100.7' } } }, action: { id: 9001 + nextServer++ } };
    },
    'GET /actions/9102': () => ({ action: { id: 9102, status: 'success' } }),
    'GET /servers/101': () => ({ server: { id: 101, name: 'aios-test', status: 'running', public_net: { ipv4: { ip: '198.51.100.7' } } } }),
    'DELETE /servers/101': () => null,
  };
  const fetchImpl = async (url, opts = {}) => {
    const path = url.replace('https://api.hetzner.cloud/v1', '');
    const key = `${opts.method || 'GET'} ${path}`;
    log.push(key);
    const handler = routes[key];
    if (!handler) return { ok: false, status: 404, json: async () => ({ error: { code: 'not_found', message: `no stub for ${key}` } }) };
    const body = handler(opts.body ? JSON.parse(opts.body) : undefined);
    return { ok: true, status: 200, json: async () => body ?? {} };
  };
  return { fetchImpl, log };
}

test('cloud-init renders with no tunnel, no anchor, owner key present, all slots filled', () => {
  const y = renderSelfHostCloudInit({ boxName: 'test', ownerPubKey: PUB, image: 'ghcr.io/x/crads-pebble:v2' });
  assert.ok(y.includes(PUB));
  assert.ok(y.includes('ufw allow 22/tcp'), 'SSH must be open: there is no tunnel to come in through');
  assert.ok(!y.includes('cloudflared'), 'no tunnel machinery on a self-hosted box');
  assert.ok(!/__[A-Z_]+__/.test(y), 'no unfilled slots');
});

test('cloud-init renders from in-memory files alone (the packaged exe has no repo on disk)', () => {
  // The first real Windows run failed with ENOENT on the template path
  // (2026-09-01): inside the SEA exe import.meta.url is the exe itself. The
  // renderer therefore accepts every source in memory; this renders with
  // stand-ins and proves no disk read happens for them.
  const here = dirname(fileURLToPath(import.meta.url));
  const files = {
    template: readFileSync(join(here, '..', '..', 'provisioning', 'managed', 'cloud-init.template.yaml'), 'utf8'),
    hostUpdate: '#!/bin/sh\necho host-update stand-in\n',
    enterAios: '#!/bin/sh\necho enter stand-in\n',
  };
  const y = renderSelfHostCloudInit({ boxName: 'exe', ownerPubKey: PUB, image: 'ghcr.io/x/crads-pebble:v2', files });
  assert.ok(y.includes('/usr/local/bin/enter-aios'), 'host script block present from the in-memory source');
  assert.ok(!/__[A-Z_]+__/.test(y), 'no unfilled slots');
});

// --- CRLF can never reach the box ---------------------------------------------
// The Windows exe is built on windows-latest, where git checks out with
// core.autocrlf=true, and 539f2aa started baking these sources into the SEA
// blob. gz+b64 is opaque to every YAML parser on the way, so the CRs rode
// through and the box got `#!/bin/bash\r`: sshd runs the ForceCommand, bash
// looks for an interpreter called "/bin/bash\r" and answers "cannot execute:
// required file not found". The box boots healthy and locks every SSH out.
// Found live on test-mineral-4, 2026-09-01; both certs ran from Linux and could
// not have seen it. String-checking the rendered YAML would not catch this, so
// the blobs are decompressed and read.
function hostScriptsFrom(yaml) {
  const out = {};
  for (const m of yaml.matchAll(/- path: (\/usr\/local\/bin\/[a-z-]+)\n\s+permissions: '0755'\n\s+encoding: gz\+b64\n\s+content: (\S+)/g)) {
    out[m[1]] = gunzipSync(Buffer.from(m[2], 'base64')).toString('utf8');
  }
  return out;
}

test('CRLF sources render to LF on the box (the Windows-built exe, 2026-09-01)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const disk = (...p) => readFileSync(join(here, '..', '..', ...p), 'utf8');
  // Exactly what a windows-latest checkout hands the SEA build.
  const crlf = (t) => t.replace(/\r?\n/g, '\r\n');
  const files = {
    template: crlf(disk('provisioning', 'managed', 'cloud-init.template.yaml')),
    hostUpdate: crlf(disk('provisioning', 'host', 'aios-host-update')),
    enterAios: crlf(disk('provisioning', 'host', 'enter-aios')),
  };
  const y = renderSelfHostCloudInit({ boxName: 'winbox', ownerPubKey: PUB, image: 'ghcr.io/x/crads-pebble:v2', files });

  assert.ok(!y.includes('\r'), 'the rendered user-data carries no CR');
  const scripts = hostScriptsFrom(y);
  assert.equal(Object.keys(scripts).length, 2, 'both host scripts decompressed');
  for (const [path, body] of Object.entries(scripts)) {
    assert.ok(!body.includes('\r'), `${path} must reach the box with no CR`);
    assert.match(body.split('\n')[0], /^#!\/bin\/bash$/, `${path} shebang must be executable`);
  }
});

test('cloud-init refuses a non-key, a bad name, a non-ghcr image', () => {
  assert.throws(() => renderSelfHostCloudInit({ boxName: 'Bad Name', ownerPubKey: PUB, image: 'ghcr.io/x/y' }));
  assert.throws(() => renderSelfHostCloudInit({ boxName: 'ok', ownerPubKey: 'not a key', image: 'ghcr.io/x/y' }));
  assert.throws(() => renderSelfHostCloudInit({ boxName: 'ok', ownerPubKey: PUB, image: 'docker.io/x/y' }));
});

test('full run: validate → key → create → running; token never lands in state', async () => {
  const { fetchImpl, log } = fakeHetzner();
  const client = new HetznerClient('tok-secret', { fetchImpl });
  const state = {};
  const steps = [];
  const r = await provisionSelfHost({
    token: 'tok-secret', boxName: 'test', ownerPubKey: PUB, state,
    onStep: (s) => steps.push(s), overrides: { client, image: 'ghcr.io/x/crads-pebble:v2' },
  });
  assert.equal(r.ip, '198.51.100.7');
  assert.deepEqual(steps, ['validate-token', 'ensure-ssh-key', 'create-server', 'wait-running', 'done']);
  assert.ok(!JSON.stringify(state).includes('tok-secret'), 'the token must never be persisted');
  assert.ok(log.includes('POST /servers'));
});

test('resume: a completed step never re-runs', async () => {
  const { fetchImpl, log } = fakeHetzner();
  const client = new HetznerClient('tok', { fetchImpl });
  const state = { tokenValidated: true, sshKeyId: 7, serverId: 101, serverIp: '198.51.100.7', serverRunning: true };
  await provisionSelfHost({ token: 'tok', boxName: 'test', ownerPubKey: PUB, state, overrides: { client } });
  assert.ok(!log.includes('POST /servers'), 'no second server on resume');
  assert.ok(!log.includes('POST /ssh_keys'));
});

test('destroy-and-retry clears server state and only server state', async () => {
  const { fetchImpl } = fakeHetzner();
  const client = new HetznerClient('tok', { fetchImpl });
  const state = { tokenValidated: true, sshKeyId: 7, serverId: 101, serverIp: 'x', serverRunning: false };
  const r = await destroySelfHost({ token: 'tok', state, client });
  assert.equal(r.destroyed, true);
  assert.equal(state.serverId, undefined);
  assert.equal(state.sshKeyId, 7, 'the uploaded key survives; it is idempotent to reuse');
});

test('a 401 comes back as a legible token message', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: { code: 'unauthorized', message: 'unable to authenticate' } }) });
  const client = new HetznerClient('bad', { fetchImpl });
  await assert.rejects(
    provisionSelfHost({ token: 'bad', boxName: 'test', ownerPubKey: PUB, state: {}, overrides: { client } }),
    /Hetzner rejected the token/,
  );
});
