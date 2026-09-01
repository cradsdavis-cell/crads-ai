// vault-routes.test.mjs — the cold tier's member-side wiring (secret-store
// design, 2026-07-28): /vault/sync publishes this device's vault key onto its
// roster row, /vault/seal seals on THIS machine and hands the box an envelope,
// /vault/open opens locally, /vault/rewrap re-seals to the current roster.
//
// The property the whole file guards: the PLAINTEXT of a cold secret never
// appears in any command, any stdin, or anything the box stores — only the
// envelope travels, and only enrolled MEMBER devices can open it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync, readFileSync, unlinkSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPanelServer, VERBS, MEMBER_VERBS } from './panel-server.mjs';
import { mintVaultKeypair, ensureVaultKeypair, seal, open, vaultFingerprint } from './vault-crypto.mjs';
// a self-enrolled row is named after the machine running the test (2026-08-12),
// so ask the same function the server does rather than pinning one hostname.
// machine-name.mjs is the function's home; device-enrol.mjs only re-exported
// it and is deleted (self-host strip, 2026-09-01).
import { machineSlug } from './machine-name.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const MEMBER = { host: 'jane01-box', org: 'jane01', kind: 'member' };
const HOST = MEMBER.host;

// ---------------------------------------------------------------- fake box
// A stateful bridge: parses exactly the roster-cli / vault-cli commands the
// routes issue and serves them from in-memory box state, so the whole
// choreography runs without a box while staying honest about the wire shapes.
function boxBridge(box, targets = [MEMBER]) {
  const ran = [];
  return {
    ran,
    targets: () => targets,
    stream: (host, command, o = {}) => {
      ran.push({ host, command, stdin: o.stdin });
      const pebble = new EventEmitter();
      pebble.kill = () => {};
      const reply = (lines, code = 0) => setImmediate(() => {
        for (const l of [].concat(lines)) if (o.onStdout) o.onStdout(l);
        pebble.emit('close', code);
      });
      let m;
      if (/roster-cli\.mjs \/state list$/.test(command)) {
        reply(JSON.stringify({ devices: box.devices, support: box.support || null }, null, 2));
      } else if ((m = command.match(/roster-cli\.mjs \/state add (\S+) '([^']*)' '([^']*)'$/))) {
        box.devices.push(deviceRow(m[1], m[3].split(/\s+/)[1], { label: m[2] }));
        reply(`OK: "${m[2]}" can now open this box.`);
      } else if ((m = command.match(/roster-cli\.mjs \/state set-vaultkey (\S+) (\S+)$/))) {
        const d = box.devices.find((x) => x.slug === m[1]);
        if (!d) reply('ERROR: no such device', 1);
        else { d.vaultkey = m[2]; reply('OK: vault key recorded.'); }
      } else if (/vault-cli\.mjs \/state envelopes$/.test(command)) {
        reply(JSON.stringify({ secrets: box.secrets.map((s) => ({
          ...s, sealed_to: (s.envelope?.wraps || []).map((w) => w.fingerprint),
        })) }, null, 2));
      } else if ((m = command.match(/^base64 -d \| node \/app\/engine\/vault\/vault-cli\.mjs \/state put-cold (\S+)/))) {
        const envelope = JSON.parse(Buffer.from(String(o.stdin).trim(), 'base64').toString('utf8'));
        box.secrets = box.secrets.filter((s) => s.name !== m[1])
          .concat({ name: m[1], label: m[1], tier: 'cold', envelope });
        reply(`OK: saved "${m[1]}", sealed to your own computers.`);
      } else {
        reply(`RAN:${command}`);
      }
      return pebble;
    },
  };
}

const sshBlob = () => randomBytes(32).toString('base64');
const deviceRow = (slug, blob, over = {}) => ({
  slug, label: slug, pubkey: `ssh-ed25519 ${blob} ${slug}`,
  fingerprint: `SHA256:${slug}`, added: '2026-07-28', status: 'active',
  revoked: '', last_seen: '', vaultkey: '', ...over,
});

// a member machine: tmp sshDir carrying the ssh public half that matches the
// box's roster row for this device (what /vault/sync matches on)
function machine(blob) {
  const sshDir = tmpDir('vault-routes-');
  writeFileSync(join(sshDir, `${HOST}.key.pub`), `ssh-ed25519 ${blob} test\n`);
  return sshDir;
}

// createPanelServer has no edition option since the face collapse (2026-09-01):
// one server, one face, one verb table.
const listen = (opts) => new Promise((resolve) => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html>x</html>', ...opts });
  s.on('listening', () => resolve(s));
});
const jpost = (s, path, body) => fetch(`http://127.0.0.1:${s.address().port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

// ---------------------------------------------------------------- keypair
test('ensureVaultKeypair: mints 0600, reuses, self-heals a lost .pub, retires a corrupt key aside', () => {
  const sshDir = tmpDir('vault-keys-');
  const first = ensureVaultKeypair(HOST, sshDir);
  assert.equal(first.reused, false);
  assert.equal(statSync(first.vaultKeyPath).mode & 0o777, 0o600, 'private half is 0600');
  const again = ensureVaultKeypair(HOST, sshDir);
  assert.equal(again.reused, true);
  assert.equal(again.vaultPublicKey, first.vaultPublicKey, 'reuse never clobbers: envelopes stay openable');
  // lost .pub: derived back from the private half, key material unchanged
  unlinkSync(join(sshDir, `${HOST}.vault.pub`));
  const healed = ensureVaultKeypair(HOST, sshDir);
  assert.equal(healed.reused, true);
  assert.equal(healed.vaultPublicKey, first.vaultPublicKey, 'public half derived, not re-minted');
  // corrupt private half: retired aside (never deleted), fresh pair minted
  writeFileSync(join(sshDir, `${HOST}.vault.key`), 'not a key\n');
  unlinkSync(join(sshDir, `${HOST}.vault.pub`));
  const fresh = ensureVaultKeypair(HOST, sshDir);
  assert.equal(fresh.reused, false);
  assert.notEqual(fresh.vaultPublicKey, first.vaultPublicKey);
  assert.ok(readdirSync(sshDir).some((f) => f.startsWith(`${HOST}.vault.key.orphan-`)), 'corrupt key retired aside');
});

// ---------------------------------------------------------------- verb shape
test('devices-set-vaultkey: member verb, validated, key never argv-mangled', () => {
  const vk = mintVaultKeypair().publicKey;
  const spec = MEMBER_VERBS['devices-set-vaultkey'].build({ slug: 'laptop', vaultkey: vk });
  assert.match(spec.command, /roster-cli\.mjs \/state set-vaultkey laptop /);
  assert.ok(spec.command.endsWith(vk), 'the public half rides verbatim (it is public)');
  assert.ok(MEMBER_VERBS['devices-set-vaultkey'].mutating);
  // The old org table survives only as a builder library since the face
  // collapse; a member-device verb never belonged in it and still does not.
  assert.equal(VERBS['devices-set-vaultkey'], undefined, 'never grew a copy in the old org table');
  assert.throws(() => MEMBER_VERBS['devices-set-vaultkey'].build({ slug: 'laptop', vaultkey: 'short' }), /vaultkey/);
  assert.throws(() => MEMBER_VERBS['devices-set-vaultkey'].build({ slug: 'laptop', vaultkey: `${vk} extra` }), /vaultkey/);
  assert.throws(() => MEMBER_VERBS['devices-set-vaultkey'].build({ slug: '../x', vaultkey: vk }), /slug|short id/i);
});

// ---------------------------------------------------------------- sync
test('/vault/sync publishes this device’s key onto its own roster row, idempotently', async () => {
  const blob = sshBlob();
  const box = { devices: [deviceRow('laptop', blob)], secrets: [] };
  const sshDir = machine(blob);
  const s = await listen({ bridge: boxBridge(box), sshDir });
  try {
    const r1 = await jpost(s, '/vault/sync', { host: HOST }).then((r) => r.json());
    assert.equal(r1.ok, true);
    assert.equal(r1.published, true);
    assert.equal(r1.slug, 'laptop');
    assert.equal(r1.devices, undefined, 'roster rows are the devices-list verb’s to serve');
    const localPub = readFileSync(join(sshDir, `${HOST}.vault.pub`), 'utf8').trim();
    assert.equal(box.devices[0].vaultkey, localPub, 'the roster row now carries the local public half');
    const r2 = await jpost(s, '/vault/sync', { host: HOST }).then((r) => r.json());
    assert.equal(r2.published, false, 'second sync is a no-op');
  } finally { s.close(); }
});

test('/vault/sync enrols a machine that authenticated but was never on the roster', async () => {
  // The legacy-box case (brainiac, 2026-08-03): the key lives in the host's
  // authorized_keys, which the container cannot see, so the roster does not
  // know a device that is connected right now. This used to refuse and send
  // the member to a Devices control that does not exist. Full coverage of the
  // enrolment itself lives in device-self-heal.test.mjs.
  const box = { devices: [deviceRow('laptop', sshBlob())], secrets: [] };
  const sshDir = machine(sshBlob());   // different key material than any row
  const s = await listen({ bridge: boxBridge(box), sshDir });
  try {
    const r = await jpost(s, '/vault/sync', { host: HOST }).then((r) => r.json());
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.slug, machineSlug());
    assert.equal(r.published, true, 'and its vault key lands on the row it just got');
    assert.equal(box.devices.length, 2);
  } finally { s.close(); }
});

test('/vault/sync refuses a machine with no ssh identity for the box', async () => {
  const box = { devices: [deviceRow('laptop', sshBlob())], secrets: [] };
  const sshDir = tmpDir('vault-routes-');   // no <host>.key.pub
  const s = await listen({ bridge: boxBridge(box), sshDir });
  try {
    const r = await jpost(s, '/vault/sync', { host: HOST }).then((r) => r.json());
    assert.equal(r.ok, false);
    assert.match(r.reason, /no ssh identity/);
    assert.equal(box.devices.length, 1, 'nothing enrolled');
  } finally { s.close(); }
});

// ---------------------------------------------------------------- seal + open
test('/vault/seal: plaintext never leaves this machine; both devices open; the box cannot', async () => {
  const SECRET = 'sk-live-EXTREMELY-secret-9137';
  const blob = sshBlob();
  const other = mintVaultKeypair();   // a second enrolled machine, key held by the test
  const box = { devices: [deviceRow('laptop', blob), deviceRow('phone', sshBlob(), { vaultkey: other.publicKey })], secrets: [] };
  const sshDir = machine(blob);
  const bridge = boxBridge(box);
  const s = await listen({ bridge, sshDir });
  try {
    const r = await jpost(s, '/vault/seal', { host: HOST, name: 'bank-login', label: 'Bank', value: SECRET });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.sealedTo, 2);

    // THE property: plaintext (raw or base64) in no command, no stdin, no stored byte
    const b64secret = Buffer.from(SECRET).toString('base64');
    for (const { command, stdin } of bridge.ran) {
      assert.ok(!command.includes(SECRET) && !command.includes(b64secret), 'plaintext never in a command');
      assert.ok(!(stdin || '').includes(SECRET) && !(stdin || '').includes(b64secret), 'plaintext never on stdin');
    }
    assert.ok(!JSON.stringify(box.secrets).includes(SECRET), 'the box stores an envelope, not the value');

    // both enrolled machines open it; this one via the route, the other via its private half
    const stored = box.secrets.find((x) => x.name === 'bank-login');
    assert.equal(open(stored.envelope, other.privateKey), SECRET, 'the second device opens it');
    const got = await jpost(s, '/vault/open', { host: HOST, name: 'bank-login' }).then((r2) => r2.json());
    assert.equal(got.ok, true);
    assert.equal(got.value, SECRET, 'this device opens it through the route');
  } finally { s.close(); }
});

test('support entries are never sealing targets, even if one somehow carries a vault key', async () => {
  const blob = sshBlob();
  const strayKey = mintVaultKeypair();
  const box = {
    devices: [
      deviceRow('laptop', blob),
      // hostile future-shape: a support-kind row WITH a vault key must be excluded
      deviceRow('crads-support', sshBlob(), { kind: 'support', vaultkey: strayKey.publicKey }),
    ],
    secrets: [],
    support: { active: true, expires_at: '2026-08-01T00:00:00Z' },
  };
  const sshDir = machine(blob);
  const s = await listen({ bridge: boxBridge(box), sshDir });
  try {
    const body = await jpost(s, '/vault/seal', { host: HOST, name: 'bank-login', value: 'v' }).then((r) => r.json());
    assert.equal(body.ok, true);
    assert.equal(body.sealedTo, 1, 'only the member device');
    const wraps = box.secrets[0].envelope.wraps;
    assert.equal(wraps.length, 1);
    assert.ok(!wraps.some((w) => w.fingerprint === 'SHA256:crads-support'), 'no wrap for support');
    assert.throws(() => open(box.secrets[0].envelope, strayKey.privateKey), /cannot open/, 'support key opens nothing');
  } finally { s.close(); }
});

test('/vault/seal on a legacy box enrols this computer first, then seals to it', async () => {
  // Was: refuse, because the machine's key was not on the roster. On a box
  // provisioned before the roster seed that is EVERY device, which made the
  // cold tier permanently unreachable there. Now the seal path enrols the
  // authenticated device on the way through, so the member gets a secret they
  // can actually reopen.
  const blob = sshBlob();
  const box = { devices: [deviceRow('laptop', sshBlob())], secrets: [] };
  const s = await listen({ bridge: boxBridge(box), sshDir: machine(blob) });
  try {
    const r = await jpost(s, '/vault/seal', { host: HOST, name: 'x-token', value: 'v' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.sealedTo, 1, 'sealed to the computer that just enrolled, not to the stranger row');
    const mine = box.devices.find((d) => d.pubkey.split(/\s+/)[1] === blob);
    assert.ok(mine, 'this computer is on the roster now');
    assert.ok(mine.vaultkey, 'and carries the vault key the envelope was sealed to');
  } finally { s.close(); }
});

test('/vault/seal still refuses a machine with no ssh identity for the box', async () => {
  const box = { devices: [deviceRow('laptop', sshBlob())], secrets: [] };
  const s = await listen({ bridge: boxBridge(box), sshDir: tmpDir('vault-routes-') });
  try {
    const r = await jpost(s, '/vault/seal', { host: HOST, name: 'x-token', value: 'v' });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.match(body.reason, /no ssh identity/);
    assert.equal(box.secrets.length, 0);
  } finally { s.close(); }
});

// ---------------------------------------------------------------- rewrap
test('/vault/rewrap after a revoke drops the revoked device’s wrap for good', async () => {
  const blob = sshBlob();
  const other = mintVaultKeypair();
  const box = { devices: [deviceRow('laptop', blob), deviceRow('phone', sshBlob(), { vaultkey: other.publicKey })], secrets: [] };
  const sshDir = machine(blob);
  const s = await listen({ bridge: boxBridge(box), sshDir });
  try {
    await jpost(s, '/vault/seal', { host: HOST, name: 'bank-login', value: 'the-value' });
    assert.equal(box.secrets[0].envelope.wraps.length, 2);
    // the box-side revoke already happened; the roster no longer lists the phone
    box.devices = box.devices.filter((d) => d.slug !== 'phone');
    const w = await jpost(s, '/vault/rewrap', { host: HOST }).then((r) => r.json());
    assert.equal(w.ok, true);
    assert.deepEqual(w.resealed, ['bank-login']);
    assert.equal(w.stale.length, 0);
    const env = box.secrets.find((x) => x.name === 'bank-login').envelope;
    assert.equal(env.wraps.length, 1, 'one wrap left');
    assert.throws(() => open(env, other.privateKey), /cannot open/, 'the revoked machine is locked out');
    const got = await jpost(s, '/vault/open', { host: HOST, name: 'bank-login' }).then((r) => r.json());
    assert.equal(got.value, 'the-value', 'the surviving machine still opens it');
  } finally { s.close(); }
});

test('/vault/rewrap reports what this machine cannot open as stale, never silently skips', async () => {
  const blob = sshBlob();
  const stranger = mintVaultKeypair();  // an envelope sealed before this machine existed
  const box = {
    devices: [deviceRow('laptop', blob)],
    secrets: [{ name: 'old-secret', label: 'Old', tier: 'cold', envelope: seal('old-value', [{ fingerprint: 'SHA256:gone', vaultkey: stranger.publicKey }]) }],
  };
  const sshDir = machine(blob);
  const s = await listen({ bridge: boxBridge(box), sshDir });
  try {
    const w = await jpost(s, '/vault/rewrap', { host: HOST }).then((r) => r.json());
    assert.equal(w.ok, true);
    assert.equal(w.resealed.length, 0);
    assert.equal(w.stale.length, 1);
    assert.equal(w.stale[0].name, 'old-secret');
    assert.match(w.stale[0].reason, /older computer/);
    assert.equal(open(box.secrets[0].envelope, stranger.privateKey), 'old-value', 'the untouched envelope survives');
  } finally { s.close(); }
});

// ---------------------------------------------------------------- guards
test('vault routes: configured hosts only (both alias shapes), open refuses hot entries', async () => {
  // The per-face kind wall (org vaults rocks, member vaults pebbles) died with
  // the face collapse (2026-09-01): one server serves every configured target,
  // `<slug>-box` and legacy `<org>-rock` alike. The guard that remains is the
  // one that always mattered: a host outside this app's target list is refused
  // before any command is built, and the refusal names both admitted shapes.
  const blob = sshBlob();
  const box = { devices: [deviceRow('laptop', blob)], secrets: [{ name: 'gmail-token', label: 'Gmail', tier: 'hot' }] };
  const sshDir = machine(blob);
  const s = await listen({ bridge: boxBridge(box), sshDir });
  try {
    const stray = await jpost(s, '/vault/sync', { host: 'evil-rock' });
    assert.equal(stray.status, 400, 'a well-shaped alias that is not configured is still refused');
    assert.match(await stray.text(), /host must be a configured <slug>-box \(or legacy <org>-rock\) target/);
    assert.equal((await jpost(s, '/vault/sync', { host: 'not-configured-box' })).status, 400);
    const hot = await jpost(s, '/vault/open', { host: HOST, name: 'gmail-token' });
    assert.equal(hot.status, 400);
    assert.match((await hot.json()).reason, /not sealed/);
    const missing = await jpost(s, '/vault/open', { host: HOST, name: 'nope' });
    assert.equal(missing.status, 404);
  } finally { s.close(); }
});

test('a configured legacy -rock alias vaults through the same routes', async () => {
  // A hosted-era install keeps its `<org>-rock` Host blocks; its cold secrets
  // must stay reachable after the collapse. Same choreography, rock alias.
  const rock = { host: 'acme-rock', org: 'acme', kind: 'rock' };
  const blob = sshBlob();
  const sshDir = tmpDir('vault-routes-');
  writeFileSync(join(sshDir, `${rock.host}.key.pub`), `ssh-ed25519 ${blob} test\n`);
  const box = { devices: [deviceRow('laptop', blob)], secrets: [] };
  const s = await listen({ bridge: boxBridge(box, [rock]), sshDir });
  try {
    const r = await jpost(s, '/vault/sync', { host: rock.host }).then((x) => x.json());
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.published, true, 'the rock roster row carries this machine’s vault key');
  } finally { s.close(); }
});
