// Separating the door's two writers (2026-08-04) fixed revoke and broke first-run.
// It left the member's roster as the only key source, and a brand-new member has
// no roster: their one device arrives the admin-first way, as a public key the
// rock writes into the inbox after confirming the 6-char code. Read purely as a
// gate, that key opened nothing, so the door derived EMPTY and the member was
// locked out of their own box forever while the panel promised them it would
// "install on the next box sync (~2 min)". Every member a rock adds hit this.
//
// Found by redeeming a real invite, approving it, and never getting in. The unit
// tests all passed throughout: each half was correct on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { syncKeys } from './device-sync.mjs';
import { listDevices, revokeDevice } from './roster.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const KEY_A = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa nyla-box';
const KEY_B = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb second-laptop';

function box({ status = 'active', orgKeys = null } = {}) {
  const dir = tmpDir('adopt-');
  if (status !== null) {
    mkdirSync(join(dir, 'org-inbox'), { recursive: true });
    writeFileSync(join(dir, 'org-inbox', 'MEMBERSHIP.yaml'), `status: ${status}\n`);
  }
  if (orgKeys !== null) {
    mkdirSync(join(dir, 'org-inbox', 'keys'), { recursive: true });
    writeFileSync(join(dir, 'org-inbox', 'keys', 'member.authorized_keys'), orgKeys);
  }
  return dir;
}
const door = (d) => readFileSync(join(d, 'ssh', 'member', 'authorized_keys'), 'utf8');

test('a brand-new member gets in: the approved key opens the door', () => {
  const d = box({ orgKeys: KEY_A + '\n' });
  const r = syncKeys(d);                      // roster is empty, as it is on every fresh box
  assert.equal(r.adopted, 1);
  assert.equal(r.devices, 1, 'the door has a key');
  assert.match(door(d), /AAAAIAaaa/, 'and it is theirs');
  rmSync(d, { recursive: true, force: true });
});

test('revoke stays revoked: an adopted key is never re-adopted', () => {
  // A second approved key rides along so the door is never left empty. syncKeys
  // refuses to write an empty authorized_keys (these boxes carry no root SSH, so
  // a zero-byte door is unrecoverable), and that refusal would otherwise mask
  // the property under test. What matters here is narrower and sharper anyway:
  // the REVOKED key specifically does not come back, while the others stay.
  const d = box({ orgKeys: KEY_A + '\n' + KEY_B + '\n' });
  syncKeys(d);
  const stolen = listDevices(d).find((x) => x.pubkey === KEY_A);
  revokeDevice(d, stolen.slug, '2026-08-05');   // the member revokes a stolen laptop
  const r = syncKeys(d);                        // ...and the org file still names it
  assert.equal(r.adopted, 0, 'the org file must not resurrect it');
  assert.equal(r.devices, 1, 'only the key that was kept');
  assert.doesNotMatch(door(d), /AAAAIAaaa/, 'the door is shut on that key, and stays shut');
  assert.match(door(d), /AAAAIBbbb/, 'and the other machine still gets in');
  rmSync(d, { recursive: true, force: true });
});

test('adoption is idempotent: syncing twice does not duplicate a device', () => {
  const d = box({ orgKeys: KEY_A + '\n' });
  syncKeys(d); syncKeys(d); syncKeys(d);
  assert.equal(listDevices(d).length, 1);
  rmSync(d, { recursive: true, force: true });
});

test('a second approved device is adopted alongside the first', () => {
  const d = box({ orgKeys: KEY_A + '\n' });
  syncKeys(d);
  writeFileSync(join(d, 'org-inbox', 'keys', 'member.authorized_keys'), KEY_A + '\n' + KEY_B + '\n');
  const r = syncKeys(d);
  assert.equal(r.adopted, 1);
  assert.equal(r.devices, 2);
  rmSync(d, { recursive: true, force: true });
});

test('the org gate still wins: a paused member gains nothing', () => {
  const d = box({ status: 'paused', orgKeys: KEY_A + '\n' });
  const r = syncKeys(d);
  assert.equal(r.adopted, 0, 'a paused member must not gain a roster row');
  assert.equal(r.devices, 0);
  assert.equal(listDevices(d).length, 0);
  rmSync(d, { recursive: true, force: true });
});

test('an empty org key file still means the door is shut', () => {
  const d = box({ orgKeys: '' });
  const r = syncKeys(d);
  assert.equal(r.devices, 0);
  assert.equal(door(d).trim(), '');
  rmSync(d, { recursive: true, force: true });
});

test('a support grant line in the org file never becomes a device', () => {
  const d = box({ orgKeys: 'expiry-time="202608051200Z" ' + KEY_B + '\n' + KEY_A + '\n' });
  const r = syncKeys(d);
  assert.equal(r.adopted, 1, 'only the bare key is a device');
  assert.equal(listDevices(d).length, 1);
  assert.match(listDevices(d)[0].pubkey, /AAAAIAaaa/);
  rmSync(d, { recursive: true, force: true });
});

test('a solo pebble with no rock is untouched by any of this', () => {
  const d = box({ status: null });             // no org-inbox at all
  const r = syncKeys(d);
  assert.equal(r.adopted, 0);
  assert.equal(r.devices, 0);
  rmSync(d, { recursive: true, force: true });
});

test('garbage in the org file is ignored, not written to the door', () => {
  const d = box({ orgKeys: '# a comment\nnot-a-key at all\nssh-rsa AAAAB3Nz wrong-type\n' + KEY_A + '\n' });
  const r = syncKeys(d);
  assert.equal(r.adopted, 1);
  assert.equal(door(d).split('\n').filter(Boolean).length, 1);
  rmSync(d, { recursive: true, force: true });
});

test('a key whose fingerprint carries slashes still enrols', () => {
  // The roster row is a FILE. A base64 fingerprint contains '/' and ':' about
  // half the time, which threw ENOENT out of writeDevice and killed the whole
  // door sync, not just the adoption. Caught by an unrelated pre-existing test.
  const d = box({ orgKeys: '' });
  const keys = [];
  for (let i = 0; i < 40; i++) {
    const blob = Buffer.from('device-' + i + '-'.padEnd(40, String(i))).toString('base64');
    keys.push('ssh-ed25519 ' + blob + ' laptop-' + i);
  }
  writeFileSync(join(d, 'org-inbox', 'keys', 'member.authorized_keys'), keys.join('\n') + '\n');
  const r = syncKeys(d);
  assert.equal(r.adopted, 40, 'every key enrols, whatever its fingerprint hashes to');
  assert.equal(r.devices, 40);
  for (const dev of listDevices(d)) {
    assert.match(dev.slug, /^[a-z0-9-]+$/, 'every roster slug is filesystem-safe: ' + dev.slug);
  }
  rmSync(d, { recursive: true, force: true });
});

// ---- QA finding 146's third lane, 2026-08-17 -------------------------------
// A rock-approved device landed with account "", so revokeWithCascade
// (engine/box/grants.mjs) could never cut it and it counted `unattributed`
// forever. This lane is the one that looked like it "genuinely cannot know whose
// key it is", and that was never true: the rock pushes the member's address down
// beside the keys, in the SAME commit, as identity/holder_email. Observed on the
// live qa-r2-gmail rock 2026-08-17, whose own orchestrator/push-member-key.mjs
// writes it at lines 108-109, so this reads a file that exists today rather than
// one a future change would have to add.
const withHolder = (d, email) => {
  mkdirSync(join(d, 'org-inbox', 'identity'), { recursive: true });
  writeFileSync(join(d, 'org-inbox', 'identity', 'holder_email'), `${email}\n`);
  return d;
};

test('an approved key is attributed to the address the rock pushed down with it', () => {
  const d = withHolder(box({ orgKeys: KEY_A + '\n' }), 'Nyla@Example.COM');
  assert.equal(syncKeys(d).adopted, 1);
  const [row] = listDevices(d);
  assert.equal(row.account, 'nyla@example.com',
    'normalised the way grants.mjs compares it, or the cascade misses on case');
  rmSync(d, { recursive: true, force: true });
});

test('no pushed address means no account: the row stays honestly blank', () => {
  // Every rock provisioned before push-member-key wrote that file, and any box
  // whose member has not been approved yet. Guessing here would attribute a key
  // to whoever the box currently reports as holder, which is a different fact.
  const d = box({ orgKeys: KEY_A + '\n' });
  assert.equal(syncKeys(d).adopted, 1);
  assert.equal(listDevices(d)[0].account, '');
  rmSync(d, { recursive: true, force: true });
});

test('a junk holder_email is ignored rather than stored as an account', () => {
  const d = withHolder(box({ orgKeys: KEY_A + '\n' }), 'not an address');
  assert.equal(syncKeys(d).adopted, 1);
  assert.equal(listDevices(d)[0].account, '',
    'a value that cannot be an address must not become one the cascade compares on');
  rmSync(d, { recursive: true, force: true });
});
