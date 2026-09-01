// roster-cli.test.mjs: the command surface the panel verbs shell out to.
//   node --test engine/devices/roster-cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), 'roster-cli.mjs');
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBEqBeSfd/bTMrQlFHEMSnBrPnMDvxDlnHBqLcxvXtOl laptop';
const KEY2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH9pQ0kEjKlXsGGvJ2WbNS0aBcDeFgHiJkLmNoPqRsTu desktop';

const state = () => tmpDir('rcli-');
const cli = (dir, ...args) => execFileSync('node', [CLI, dir, ...args], { encoding: 'utf8' });
const keysAt = (dir) => readFileSync(join(dir, 'ssh', 'member', 'authorized_keys'), 'utf8');

test('add: writes the device, derives the keys, reports OK', () => {
  const dir = state();
  const out = cli(dir, 'add', 'laptop', 'Sam laptop', KEY);
  assert.match(out, /^OK: /m);
  assert.ok(keysAt(dir).includes(KEY));
  const { devices } = JSON.parse(cli(dir, 'list'));
  assert.equal(devices.length, 1);
  assert.equal(devices[0].label, 'Sam laptop');
  assert.equal(devices[0].status, 'active');
});

test('add: a duplicate slug is refused, and changes nothing', () => {
  const dir = state();
  cli(dir, 'add', 'laptop', 'One', KEY);
  assert.throws(() => cli(dir, 'add', 'laptop', 'Two', KEY2), /already/i);
  assert.equal(JSON.parse(cli(dir, 'list')).devices[0].label, 'One');
});

test('add: the same key under a different slug is refused (one row per key)', () => {
  const dir = state();
  cli(dir, 'add', 'laptop', 'One', KEY);
  assert.throws(() => cli(dir, 'add', 'other', 'Two', KEY), /already enrolled/i);
});

test('add: a non-ed25519 line is refused', () => {
  const dir = state();
  assert.throws(() => cli(dir, 'add', 'laptop', 'L', 'ssh-rsa AAAAB3Nz nope'), /ssh-ed25519/);
});

test('revoke: drops the key and stamps the yaml', () => {
  const dir = state();
  cli(dir, 'add', 'laptop', 'L', KEY);
  cli(dir, 'add', 'desktop', 'D', KEY2);
  cli(dir, 'revoke', 'laptop');
  const body = keysAt(dir);
  assert.ok(!body.includes(KEY), 'revoked key gone');
  assert.ok(body.includes(KEY2), 'other key kept');
  const d = JSON.parse(cli(dir, 'list')).devices.find((x) => x.slug === 'laptop');
  assert.equal(d.status, 'revoked');
  assert.match(d.revoked, /^\d{4}-\d{2}-\d{2}$/);
});

test('revoke: refuses to remove the LAST active device (lockout guard)', () => {
  const dir = state();
  cli(dir, 'add', 'laptop', 'L', KEY);
  assert.throws(() => cli(dir, 'revoke', 'laptop'), /last/i);
  assert.ok(keysAt(dir).includes(KEY), 'still reachable');
});

test('rename: label changes, key does not', () => {
  const dir = state();
  cli(dir, 'add', 'laptop', 'Old', KEY);
  cli(dir, 'rename', 'laptop', 'New');
  const [d] = JSON.parse(cli(dir, 'list')).devices;
  assert.equal(d.label, 'New');
  assert.equal(d.pubkey, KEY);
});

test('list: reports the support grant alongside the devices', () => {
  const dir = state();
  cli(dir, 'add', 'laptop', 'L', KEY);
  const before = JSON.parse(cli(dir, 'list'));
  assert.equal(before.support, null);
});

test('stamp: an unmatched fingerprint is a silent no-op, exit 0', () => {
  const dir = state();
  cli(dir, 'add', 'laptop', 'L', KEY);
  assert.doesNotThrow(() => cli(dir, 'stamp', 'SHA256:nope'));
  assert.equal(JSON.parse(cli(dir, 'list')).devices[0].last_seen, '');
});

test('a box whose key was installed before the roster existed can adopt it', () => {
  const dir = state();
  // simulate the pre-roster world: a key already in authorized_keys, no devices/
  mkdirSync(join(dir, 'ssh', 'member'), { recursive: true });
  writeFileSync(join(dir, 'ssh', 'member', 'authorized_keys'), KEY + '\n');
  const out = cli(dir, 'adopt');
  assert.match(out, /OK: /);
  const { devices } = JSON.parse(cli(dir, 'list'));
  assert.equal(devices.length, 1);
  assert.equal(devices[0].pubkey, KEY);
  // adopt runs on the box over keys already in authorized_keys, so it cannot
  // know whose machine holds one; the label says only what it actually knows
  assert.equal(devices[0].label, 'Adopted key');
  // adopting twice must not double-enrol
  cli(dir, 'adopt');
  assert.equal(JSON.parse(cli(dir, 'list')).devices.length, 1);
});

test('adopt: an expiring support line is never adopted as a device', () => {
  const dir = state();
  mkdirSync(join(dir, 'ssh', 'member'), { recursive: true });
  writeFileSync(join(dir, 'ssh', 'member', 'authorized_keys'),
    KEY + '\nexpiry-time="209901010000Z" ' + KEY2 + '\n');
  cli(dir, 'adopt');
  const { devices } = JSON.parse(cli(dir, 'list'));
  assert.equal(devices.length, 1, 'only the plain key became a device');
  assert.equal(devices[0].pubkey, KEY);
});

test('set-vaultkey publishes the public half so cold secrets can be sealed here', () => {
  const dir = state();
  cli(dir, 'add', 'laptop', 'L', KEY);
  const vk = 'MCowBQYDK2VuAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=';
  assert.match(cli(dir, 'set-vaultkey', 'laptop', vk), /OK: /);
  assert.equal(JSON.parse(cli(dir, 'list')).devices[0].vaultkey, vk);
  assert.throws(() => cli(dir, 'set-vaultkey', 'laptop', 'nope'), /vault key/i);
});

test('seen: stamps last_seen for a roster slug, refuses unknown slugs', () => {
  const dir = state();
  cli(dir, 'add', 'laptop', 'Sam laptop', KEY);
  assert.equal(JSON.parse(cli(dir, 'list')).devices[0].last_seen, '');
  const out = cli(dir, 'seen', 'laptop');
  assert.match(out, /^OK: seen\./m);
  const after = JSON.parse(cli(dir, 'list')).devices[0].last_seen;
  assert.ok(after && !Number.isNaN(Date.parse(after)), 'ISO timestamp written');
  assert.throws(() => cli(dir, 'seen', 'nope'), /unknown device/i);
});

// ---- live-cert 2026-08-03: the lockout guard must not be fooled by a phantom --
// A box stamped invite-pending was seeded with a sentinel device row
// ("ssh-ed25519 AAAA-no-member-key-staged disabled") that read as active. The
// guard counted it, so revoking the ONLY working device was permitted. Verified
// on a real pebble: the revoke succeeded and SSH went to Permission denied, on a
// box with no root SSH. Both ends are fixed; this pins the guard end.
test('revoking the only REAL device is refused even when a sentinel row exists', () => {
  const dir = state();
  cli(dir, 'add', 'laptop', 'My laptop', KEY);
  // hand-write the phantom exactly as the old cloud-init seed did
  mkdirSync(join(dir, 'devices'), { recursive: true });
  writeFileSync(join(dir, 'devices', 'this-computer.yaml'),
    'label: "This computer"\nstatus: "active"\nadded: "2026-08-03"\nrevoked: ""\nlast_seen: ""\nvaultkey: ""\npubkeys:\n  - ssh-ed25519 AAAA-no-member-key-staged disabled\n');
  assert.throws(() => cli(dir, 'revoke', 'laptop'), /lock you out/,
    'the sentinel is not a device that can open the box, so laptop is still the last one');
});

test('with two REAL devices, revoking one is still allowed', () => {
  const dir = state();
  cli(dir, 'add', 'laptop', 'My laptop', KEY);
  cli(dir, 'add', 'desktop', 'My desktop', KEY2);
  const out = cli(dir, 'revoke', 'laptop');
  assert.match(out, /can no longer open this box/);
});

// ---- QA finding 146, 2026-08-17: a device must be able to say whose it is ----
// The roster has carried an `account` column since account-bound access, and
// `add` had no way to set it, so the only lane that ever wrote one was
// enrol-sync's own writeDevice. Every device installed through the CLI, which is
// both the panel's add verb and the invite lane's handover, landed unattributed,
// and revokeWithCascade cuts on exactly that field.
test('add --account: the address that enrolled this machine is recorded', () => {
  const dir = state();
  cli(dir, 'add', 'laptop', 'Sam laptop', KEY, '--account', 'Sam@Example.COM');
  const [d] = JSON.parse(cli(dir, 'list')).devices;
  assert.equal(d.account, 'sam@example.com', 'normalised the way grants.mjs compares it');
  assert.equal(d.pubkey, KEY, 'the flag must not be swallowed into the key');
});

test('add --account=<email>: the joined form works too', () => {
  const dir = state();
  cli(dir, 'add', 'laptop', 'L', KEY, '--account=harriet@example.com');
  assert.equal(JSON.parse(cli(dir, 'list')).devices[0].account, 'harriet@example.com');
});

test('add: no --account still means no account, and says so honestly', () => {
  const dir = state();
  cli(dir, 'add', 'laptop', 'L', KEY);
  assert.equal(JSON.parse(cli(dir, 'list')).devices[0].account, '',
    'a lane that does not know whose machine this is must not guess one');
});

test('add: a value that is not an address is refused rather than stored as noise', () => {
  const dir = state();
  assert.throws(() => cli(dir, 'add', 'laptop', 'L', KEY, '--account', 'not an address'), /address/i);
  assert.throws(() => cli(dir, 'add', 'laptop2', 'L', KEY, '--account'), /address/i);
});
