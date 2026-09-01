// roster.test.mjs: the device roster's parse + mutate layer.
//   node --test engine/devices/roster.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listDevices, writeDevice, revokeDevice, renameDevice, stampLastSeen, fingerprintOf, setVaultKey } from './roster.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBEqBeSfd/bTMrQlFHEMSnBrPnMDvxDlnHBqLcxvXtOl laptop';
const KEY2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH9pQ0kEjKlXsGGvJ2WbNS0aBcDeFgHiJkLmNoPqRsTu desktop';

function fixture() {
  const dir = tmpDir('roster-');
  mkdirSync(join(dir, 'devices'), { recursive: true });
  return dir;
}

test('listDevices: missing devices dir is empty, not an error', () => {
  const dir = tmpDir('roster-empty-');
  assert.deepEqual(listDevices(dir), []);
});

test('writeDevice then listDevices round-trips every field', () => {
  const dir = fixture();
  writeDevice(dir, { slug: 'laptop', label: 'Sam laptop', pubkey: KEY, added: '2026-07-28' });
  const [d] = listDevices(dir);
  assert.equal(d.slug, 'laptop');
  assert.equal(d.label, 'Sam laptop');
  assert.equal(d.pubkey, KEY);
  assert.equal(d.added, '2026-07-28');
  assert.equal(d.status, 'active');
  assert.equal(d.revoked, '');
  assert.equal(d.last_seen, '');
  assert.equal(d.fingerprint, fingerprintOf(KEY));
});

test('listDevices: underscore-prefixed files are templates and are skipped', () => {
  const dir = fixture();
  writeDevice(dir, { slug: 'laptop', label: 'L', pubkey: KEY, added: '2026-07-28' });
  writeFileSync(join(dir, 'devices', '_schema.yaml'), 'label: "template"\n');
  assert.deepEqual(listDevices(dir).map((d) => d.slug), ['laptop']);
});

test('revokeDevice: flips status and stamps the date; unknown slug throws', () => {
  const dir = fixture();
  writeDevice(dir, { slug: 'laptop', label: 'L', pubkey: KEY, added: '2026-07-01' });
  const d = revokeDevice(dir, 'laptop', '2026-07-28');
  assert.equal(d.status, 'revoked');
  assert.equal(d.revoked, '2026-07-28');
  assert.equal(listDevices(dir)[0].status, 'revoked');
  assert.throws(() => revokeDevice(dir, 'nope', '2026-07-28'), /no device nope/);
});

test('renameDevice: changes the label, leaves the key alone', () => {
  const dir = fixture();
  writeDevice(dir, { slug: 'laptop', label: 'Old', pubkey: KEY, added: '2026-07-01' });
  renameDevice(dir, 'laptop', 'New name');
  const [d] = listDevices(dir);
  assert.equal(d.label, 'New name');
  assert.equal(d.pubkey, KEY);
});

test('stampLastSeen: matches by fingerprint, returns false when nothing matches', () => {
  const dir = fixture();
  writeDevice(dir, { slug: 'laptop', label: 'L', pubkey: KEY, added: '2026-07-01' });
  assert.equal(stampLastSeen(dir, fingerprintOf(KEY), '2026-07-28T03:00:00.000Z'), true);
  assert.equal(listDevices(dir)[0].last_seen, '2026-07-28T03:00:00.000Z');
  assert.equal(stampLastSeen(dir, fingerprintOf(KEY2), '2026-07-28T03:00:00.000Z'), false);
});

test('fingerprintOf: the ssh-keygen -lf shape, stable per key', () => {
  const f = fingerprintOf(KEY);
  assert.match(f, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(f, fingerprintOf(KEY));
  assert.notEqual(f, fingerprintOf(KEY2));
});

test('a hand-edited yaml with a quoted label and stray spacing still parses', () => {
  const dir = fixture();
  writeFileSync(join(dir, 'devices', 'hand.yaml'), [
    'label: "Hand written"',
    'status:   "active"',
    'added: "2026-07-02"',
    'revoked: ""',
    'last_seen: ""',
    'pubkeys:',
    `  - "${KEY}"`,
    '',
  ].join('\n'));
  const [d] = listDevices(dir);
  assert.equal(d.label, 'Hand written');
  assert.equal(d.pubkey, KEY);
  assert.equal(d.status, 'active');
});

test('vaultkey: absent on legacy rows, settable, and round-trips', () => {
  const dir = fixture();
  writeDevice(dir, { slug: 'laptop', label: 'L', pubkey: KEY, added: '2026-07-01' });
  assert.equal(listDevices(dir)[0].vaultkey, '', 'legacy rows have no vault key');
  const vk = 'MCowBQYDK2VuAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=';
  setVaultKey(dir, 'laptop', vk);
  const [d] = listDevices(dir);
  assert.equal(d.vaultkey, vk);
  assert.equal(d.pubkey, KEY, 'the ssh key is untouched');
  assert.equal(d.label, 'L');
});

test('vaultkey survives a revoke and a rename (no field loss on mutation)', () => {
  const dir = fixture();
  writeDevice(dir, { slug: 'laptop', label: 'L', pubkey: KEY, added: '2026-07-01' });
  writeDevice(dir, { slug: 'other', label: 'O', pubkey: KEY2, added: '2026-07-01' });
  const vk = 'MCowBQYDK2VuAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=';
  setVaultKey(dir, 'laptop', vk);
  renameDevice(dir, 'laptop', 'Renamed');
  assert.equal(listDevices(dir).find((d) => d.slug === 'laptop').vaultkey, vk);
  revokeDevice(dir, 'laptop', '2026-07-28');
  assert.equal(listDevices(dir).find((d) => d.slug === 'laptop').vaultkey, vk);
});

// ---- QA finding 148, 2026-08-17: a revoke with no date is not an audit trail ---
// `today` was a parameter every caller had to remember, and two of the three
// production callers did not: grants.mjs's cascade omitted it and enrol-sync's
// staged-web-revoke leg bypassed this function entirely with a raw writeDevice.
// Both produced status "revoked", revoked "". The parameter now defaults, so
// forgetting it gives the right answer instead of a blank.
test('revokeDevice: with no date given, it stamps today rather than nothing', () => {
  const dir = fixture();
  writeDevice(dir, { slug: 'laptop', label: 'L', pubkey: KEY, added: '2026-07-01' });
  const d = revokeDevice(dir, 'laptop');
  assert.equal(d.status, 'revoked');
  assert.equal(d.revoked, new Date().toISOString().slice(0, 10));
  assert.equal(listDevices(dir)[0].revoked, d.revoked, 'and it is on disk, not just in the return');
});
