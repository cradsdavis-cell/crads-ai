// device-self-heal.test.mjs — the migration that closes the roster gap found on
// a live box (brainiac, 2026-08-03).
//
// The gap: boxes provisioned before the cloud-init roster seed carry the
// member's key ONLY in the host's /home/member/.ssh/authorized_keys. sshd reads
// that via AuthorizedKeysFile, entirely separately from the roster the app
// shows, so the member's own laptop connects fine and appears nowhere. Devices
// listed nothing on a box being actively used, Revoke could not revoke the one
// key that worked, and /vault/sync refused with "enrol it first (Devices)" —
// pointing at a control that does not exist on that page.
//
// The property this file guards: a device that is ALREADY authenticated ends up
// on the roster, and a device that is not authenticated never writes anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPanelServer } from './panel-server.mjs';
// the self-enrolled row is named after the machine running the test (2026-08-12),
// so these assertions ask the same function the server does rather than pinning
// one box's hostname and failing everywhere else
import { machineName, machineSlug } from './device-enrol.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HOST = 'jane01-box';
const MY_NAME = machineName();
const MY_SLUG = machineSlug();
const MEMBER = { host: HOST, org: 'jane01', kind: 'member' };

const sshBlob = () => randomBytes(32).toString('base64');
const deviceRow = (slug, blob, over = {}) => ({
  slug, label: slug, pubkey: `ssh-ed25519 ${blob} ${slug}`,
  fingerprint: `SHA256:${slug}`, added: '2026-07-28', status: 'active',
  revoked: '', last_seen: '', vaultkey: '', ...over,
});

// A bridge that speaks the two roster-cli commands this path issues. `reachable`
// models sshd: false means the key is refused, so every command fails before it
// can write — the real guard behind self-enrol not being an escalation.
function boxBridge(box, { reachable = true } = {}) {
  const ran = [];
  return {
    ran,
    targets: () => [MEMBER],
    stream: (host, command, o = {}) => {
      ran.push(command);
      const pebble = new EventEmitter();
      pebble.kill = () => {};
      const reply = (lines, code = 0) => setImmediate(() => {
        for (const l of [].concat(lines)) if (o.onStdout) o.onStdout(l);
        pebble.emit('close', code);
      });
      if (!reachable) { reply('Permission denied (publickey).', 255); return pebble; }
      let m;
      if (/roster-cli\.mjs \/state list$/.test(command)) {
        reply(JSON.stringify({ devices: box.devices, support: box.support || null }, null, 2));
      } else if ((m = command.match(/roster-cli\.mjs \/state add (\S+) '([^']*)' '([^']*)'$/))) {
        box.devices.push(deviceRow(m[1], m[3].split(/\s+/)[1], { label: m[2] }));
        reply(`OK: "${m[2]}" can now open this box.`);
      } else {
        reply(`RAN:${command}`);
      }
      return pebble;
    },
  };
}

// a member machine holding one ssh identity for this box
function machine(blob) {
  const sshDir = tmpDir('device-heal-');
  writeFileSync(join(sshDir, `${HOST}.key.pub`), `ssh-ed25519 ${blob} jane@her-laptop\n`);
  return sshDir;
}

const listen = (opts) => new Promise((resolve) => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html>x</html>', edition: 'member', ...opts });
  s.on('listening', () => resolve(s));
});
const jpost = (s, path, body) => fetch(`http://127.0.0.1:${s.address().port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

// ------------------------------------------------------- the live-box case
test('an empty roster on a box you are connected to enrols this computer', async () => {
  const blob = sshBlob();
  const box = { devices: [] };            // exactly brainiac: seed never ran
  const bridge = boxBridge(box);
  const s = await listen({ bridge, sshDir: machine(blob) });
  try {
    const r = await jpost(s, '/devices/self-heal', { host: HOST }).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.equal(r.enrolled, true);
    assert.equal(r.slug, MY_SLUG);
    assert.equal(box.devices.length, 1);
    assert.equal(box.devices[0].pubkey.split(/\s+/)[1], blob, 'the row carries THIS machine’s key');
    assert.equal(box.devices[0].label, MY_NAME, 'named after the machine, not "This computer"');
  } finally { s.close(); }
});

test('the roster line is rebuilt from type + blob, so a .pub comment can never break the add', async () => {
  const blob = sshBlob();
  const sshDir = tmpDir('device-heal-');
  // a comment roster-cli's PUBKEY_RE would refuse if it were forwarded verbatim
  writeFileSync(join(sshDir, `${HOST}.key.pub`), `ssh-ed25519 ${blob} jane's laptop (work!)\n`);
  const box = { devices: [] };
  const bridge = boxBridge(box);
  const s = await listen({ bridge, sshDir });
  try {
    const r = await jpost(s, '/devices/self-heal', { host: HOST }).then((x) => x.json());
    assert.equal(r.ok, true, r.reason);
    const add = bridge.ran.find((c) => / \/state add /.test(c));
    assert.ok(add.endsWith(`'ssh-ed25519 ${blob}'`), 'no comment rides along');
  } finally { s.close(); }
});

test('a device already on the roster is left alone (idempotent, no duplicate rows)', async () => {
  const blob = sshBlob();
  const box = { devices: [deviceRow('laptop', blob)] };
  const bridge = boxBridge(box);
  const s = await listen({ bridge, sshDir: machine(blob) });
  try {
    const r = await jpost(s, '/devices/self-heal', { host: HOST }).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.equal(r.enrolled, false);
    assert.equal(r.slug, 'laptop');
    assert.equal(box.devices.length, 1);
    assert.ok(!bridge.ran.some((c) => / \/state add /.test(c)), 'nothing written');
  } finally { s.close(); }
});

test('a revoked row for this key is not resurrected silently as itself', async () => {
  // Revoke is meant to stick. A revoked row does not count as "mine", so the
  // heal enrols a NEW row rather than flipping the revoked one back to active:
  // the revocation stays in the history where the member can see it.
  const blob = sshBlob();
  const box = { devices: [deviceRow('laptop', blob, { status: 'revoked', revoked: '2026-08-01' })] };
  const s = await listen({ bridge: boxBridge(box), sshDir: machine(blob) });
  try {
    const r = await jpost(s, '/devices/self-heal', { host: HOST }).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.equal(r.slug, MY_SLUG);
    assert.equal(box.devices.find((d) => d.slug === 'laptop').status, 'revoked', 'the revocation stands');
  } finally { s.close(); }
});

test('the slug never collides with an existing row', async () => {
  const blob = sshBlob();
  const box = { devices: [deviceRow(MY_SLUG, sshBlob())] };   // someone else's, same machine name
  const s = await listen({ bridge: boxBridge(box), sshDir: machine(blob) });
  try {
    const r = await jpost(s, '/devices/self-heal', { host: HOST }).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.equal(r.slug, `${MY_SLUG}-2`);
    assert.equal(box.devices.length, 2);
  } finally { s.close(); }
});

// ------------------------------------------------------- it cannot mint access
test('a key sshd refuses writes nothing: the roster is never reachable from outside', async () => {
  const box = { devices: [] };
  const bridge = boxBridge(box, { reachable: false });
  const s = await listen({ bridge, sshDir: machine(sshBlob()) });
  try {
    const r = await jpost(s, '/devices/self-heal', { host: HOST }).then((x) => x.json());
    assert.equal(r.ok, false);
    assert.match(r.reason, /could not read the device roster/);
    assert.equal(box.devices.length, 0, 'no row appeared');
    assert.ok(!bridge.ran.some((c) => / \/state add /.test(c)), 'add was never even attempted');
  } finally { s.close(); }
});

test('a machine with no ssh identity for the box enrols nothing', async () => {
  const box = { devices: [] };
  const bridge = boxBridge(box);
  const sshDir = tmpDir('device-heal-');   // empty: no .key.pub
  const s = await listen({ bridge, sshDir });
  try {
    const r = await jpost(s, '/devices/self-heal', { host: HOST }).then((x) => x.json());
    assert.equal(r.ok, false);
    assert.match(r.reason, /no ssh identity/);
    assert.equal(box.devices.length, 0);
  } finally { s.close(); }
});

test('the route is member-edition only and host-validated', async () => {
  const box = { devices: [] };
  const org = await listen({ bridge: boxBridge(box), sshDir: machine(sshBlob()), edition: 'org' });
  try {
    const r = await jpost(org, '/devices/self-heal', { host: HOST });
    assert.notEqual(r.status, 200, 'the org/support edition has no self-enrol path');
  } finally { org.close(); }
  const s = await listen({ bridge: boxBridge(box), sshDir: machine(sshBlob()) });
  try {
    const r = await jpost(s, '/devices/self-heal', { host: 'not-a-target' });
    assert.equal(r.status, 400);
    assert.equal(box.devices.length, 0);
  } finally { s.close(); }
});
