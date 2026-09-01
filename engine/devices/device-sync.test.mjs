// device-sync.test.mjs: the ONE writer of /state/ssh/member/authorized_keys.
//   node --test engine/devices/device-sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeDevice, listDevices, revokeDevice } from './roster.mjs';
import { syncKeys, supportLine } from './device-sync.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBEqBeSfd/bTMrQlFHEMSnBrPnMDvxDlnHBqLcxvXtOl laptop';
const KEY2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH9pQ0kEjKlXsGGvJ2WbNS0aBcDeFgHiJkLmNoPqRsTu desktop';
const SUPPORT = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkK crads-support';

const state = () => tmpDir('devsync-');
const keysAt = (dir) => readFileSync(join(dir, 'ssh', 'member', 'authorized_keys'), 'utf8');

function grant(dir, { expiresAt, key = SUPPORT }) {
  mkdirSync(join(dir, 'support'), { recursive: true });
  writeFileSync(join(dir, 'support', 'access.json'), JSON.stringify({
    grant: { granted_at: '2026-07-28T00:00:00.000Z', expires_at: expiresAt, hours: 24, key },
    events: [],
  }));
}

test('syncKeys: active devices become key lines, revoked ones do not', () => {
  const dir = state();
  writeDevice(dir, { slug: 'laptop', label: 'L', pubkey: KEY, added: '2026-07-01' });
  writeDevice(dir, { slug: 'old', label: 'O', pubkey: KEY2, added: '2026-06-01', status: 'revoked', revoked: '2026-07-02' });
  const r = syncKeys(dir);
  assert.equal(r.devices, 1);
  assert.equal(r.support, false);
  const body = keysAt(dir);
  assert.ok(body.includes(KEY), 'active key present');
  assert.ok(!body.includes(KEY2), 'revoked key absent');
  assert.ok(body.endsWith('\n'), 'trailing newline');
});

test('syncKeys: no devices at all writes an empty file rather than exploding', () => {
  const dir = state();
  const r = syncKeys(dir);
  assert.equal(r.devices, 0);
  assert.equal(keysAt(dir), '');
});

test('a live support grant survives a device sync (the two-writer race)', () => {
  const dir = state();
  writeDevice(dir, { slug: 'laptop', label: 'L', pubkey: KEY, added: '2026-07-01' });
  grant(dir, { expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  const r = syncKeys(dir);
  assert.equal(r.support, true);
  const body = keysAt(dir);
  assert.ok(body.includes(KEY), 'device key kept');
  assert.match(body, /expiry-time="\d{12}Z" ssh-ed25519 /, 'support line carries sshd expiry-time');
  assert.ok(body.includes(SUPPORT), 'support key kept');
});

test('an expired support grant is not written back', () => {
  const dir = state();
  writeDevice(dir, { slug: 'laptop', label: 'L', pubkey: KEY, added: '2026-07-01' });
  grant(dir, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const r = syncKeys(dir);
  assert.equal(r.support, false);
  assert.ok(!keysAt(dir).includes(SUPPORT));
  assert.equal(supportLine(dir), '');
});

test('syncKeys is idempotent: running twice leaves the same bytes', () => {
  const dir = state();
  writeDevice(dir, { slug: 'laptop', label: 'L', pubkey: KEY, added: '2026-07-01' });
  syncKeys(dir);
  const once = keysAt(dir);
  syncKeys(dir);
  assert.equal(keysAt(dir), once);
});

test('syncKeys gitignores the derived ssh dir without clobbering an existing ignore file', () => {
  const dir = state();
  writeFileSync(join(dir, '.gitignore'), '.claude-auth/\nsecrets/\n.kernel/\n');
  syncKeys(dir);
  const ig = readFileSync(join(dir, '.gitignore'), 'utf8');
  assert.ok(ig.includes('secrets/'), 'existing entries kept');
  assert.equal(ig.match(/^ssh\/$/gm).length, 1, 'ssh/ added exactly once');
  syncKeys(dir);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8').match(/^ssh\/$/gm).length, 1, 'still once');
});

test('a malformed access.json is ignored, not fatal', () => {
  const dir = state();
  writeDevice(dir, { slug: 'laptop', label: 'L', pubkey: KEY, added: '2026-07-01' });
  mkdirSync(join(dir, 'support'), { recursive: true });
  writeFileSync(join(dir, 'support', 'access.json'), '{not json');
  const r = syncKeys(dir);
  assert.equal(r.support, false);
  assert.ok(keysAt(dir).includes(KEY));
});

// ---- cross-module: the race this refactor exists to kill -------------------
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPPORT_CLI = resolve(HERE, '..', 'support', 'support-access.mjs');

test('granting support then syncing devices keeps BOTH (regression)', () => {
  const dir = state();
  writeDevice(dir, { slug: 'laptop', label: 'L', pubkey: KEY, added: '2026-07-01' });
  syncKeys(dir);
  execFileSync('node', [SUPPORT_CLI, dir, 'grant', '2'], { encoding: 'utf8' });
  let body = keysAt(dir);
  assert.ok(body.includes(KEY), 'device key survived the grant');
  assert.match(body, /expiry-time="\d{12}Z" /, 'grant line present');

  syncKeys(dir);                       // a later device change must not drop the grant
  body = keysAt(dir);
  assert.ok(body.includes(KEY), 'device key still there');
  assert.match(body, /expiry-time="\d{12}Z" /, 'grant still there after a roster sync');
});

test('revoking support leaves the device keys alone', () => {
  const dir = state();
  writeDevice(dir, { slug: 'laptop', label: 'L', pubkey: KEY, added: '2026-07-01' });
  execFileSync('node', [SUPPORT_CLI, dir, 'grant', '2'], { encoding: 'utf8' });
  execFileSync('node', [SUPPORT_CLI, dir, 'revoke'], { encoding: 'utf8' });
  const body = keysAt(dir);
  assert.ok(body.includes(KEY), 'device key kept');
  assert.ok(!/expiry-time=/.test(body), 'grant line gone');
});

// --- the org gate: one writer, two authorities ------------------------------
// Before this, org-sync.sh rewrote authorized_keys from the org's approved-key
// list every two minutes while this module rewrote it from the member's roster.
// Proven live 2026-08-04: devices-add locked the member out instantly, and 60s
// later org-sync restored access and dropped the new device. The direction that
// matters is revoke: a stolen laptop's key returned within two minutes.
import { orgDoorShut as gateShut, syncKeys as sync2 } from './device-sync.mjs';

function orgBox({ status = 'active', orgKeys = null } = {}) {
  const dir = tmpDir('gate-');
  mkdirSync(join(dir, 'devices'), { recursive: true });
  mkdirSync(join(dir, 'org-inbox', 'keys'), { recursive: true });
  writeFileSync(join(dir, 'org-inbox', 'MEMBERSHIP.yaml'), `status: "${status}"\n`);
  if (orgKeys !== null) writeFileSync(join(dir, 'org-inbox', 'keys', 'member.authorized_keys'), orgKeys);
  writeFileSync(join(dir, 'devices', 'laptop.yaml'),
    'label: "Laptop"\nstatus: "active"\nadded: "2026-08-01"\nrevoked: ""\nlast_seen: ""\nvaultkey: ""\n'
    + 'pubkeys:\n  - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTheTestOnly0 laptop\n');
  return dir;
}
const door = (dir) => {
  const p = join(dir, 'ssh', 'member', 'authorized_keys');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

// REFINED 2026-08-05. This test used to assert the org's list was a gate and
// NOTHING else. That was half right and it locked out every new member: their
// only device arrives as an org-approved key, so with an empty roster the door
// derived empty and never recovered. What actually has to hold is narrower --
// the org may ENROL a device once, and may never RE-add one the member removed,
// which is the mirroring race the gate rule was reaching for. See
// org-approved-adoption.test.mjs for the adoption contract in full.
test('an active membership: the org enrols a device once, the member keeps control', () => {
  const dir = orgBox({ status: 'active', orgKeys: 'ssh-ed25519 AAAAsomething org\n' });
  assert.equal(gateShut(dir), false);
  sync2(dir);
  assert.match(door(dir), /laptop$/m, 'the MEMBER decides which devices are enrolled');
  assert.match(door(dir), /AAAAsomething/, 'and an approved device gets in at all');

  // the half that must never regress: the member revokes it, the org file still
  // names it, and it stays gone.
  const row = listDevices(dir).find((d) => /AAAAsomething/.test(d.pubkey || ''));
  assert.ok(row, 'the approved key became a roster row the member can see and act on');
  revokeDevice(dir, row.slug, '2026-08-05');
  sync2(dir);
  assert.doesNotMatch(door(dir), /AAAAsomething/, "the org's list must not resurrect a revoked device");
});

test('a paused or left membership shuts the door regardless of the roster', () => {
  for (const status of ['paused', 'left', 'revoked']) {
    const dir = orgBox({ status, orgKeys: 'ssh-ed25519 AAAAsomething org\n' });
    assert.equal(gateShut(dir), true, `${status} must shut the door`);
    sync2(dir);
    assert.equal(door(dir), '', `${status}: no key may survive`);
  }
});

test('an EMPTY org key file is the org shutting the door', () => {
  // This is how pause/leave/revoke actually travel: push-member-key writes an
  // empty authorized_keys into the inbox.
  const dir = orgBox({ status: 'active', orgKeys: '' });
  assert.equal(gateShut(dir), true);
  sync2(dir);
  assert.equal(door(dir), '', 'the org shut it, so the roster does not reopen it');
});

test('an ABSENT org key file must NOT lock anyone out', () => {
  // A fresh box mid-enrolment has no org key file yet. Treating that as "shut"
  // would brick every new member before their first sync.
  const dir = orgBox({ status: 'active', orgKeys: null });
  assert.equal(gateShut(dir), false);
  sync2(dir);
  assert.match(door(dir), /laptop$/m);
});

test('a box with no org at all is unaffected', () => {
  // A personal pebble: no MEMBERSHIP.yaml, so nothing gates the member's roster.
  const dir = tmpDir('solo-');
  mkdirSync(join(dir, 'devices'), { recursive: true });
  writeFileSync(join(dir, 'devices', 'laptop.yaml'),
    'label: "Laptop"\nstatus: "active"\nadded: "2026-08-01"\nrevoked: ""\nlast_seen: ""\nvaultkey: ""\n'
    + 'pubkeys:\n  - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTheTestOnly0 laptop\n');
  assert.equal(gateShut(dir), false);
  sync2(dir);
  assert.match(door(dir), /laptop$/m);
});

test('a revoked device stays revoked (the whole point)', () => {
  const dir = orgBox({ status: 'active', orgKeys: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTheTestOnly0 laptop\n' });
  writeFileSync(join(dir, 'devices', 'laptop.yaml'),
    'label: "Laptop"\nstatus: "revoked"\nadded: "2026-08-01"\nrevoked: "2026-08-04"\nlast_seen: ""\nvaultkey: ""\n'
    + 'pubkeys:\n  - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTheTestOnly0 laptop\n');
  sync2(dir);
  assert.equal(door(dir), '', 'the org list still names it, and it must NOT come back');
});

// --- the first key: unlocking an admin-first invite without reopening the race ----
// D51 stamps an invited member's box with NO member pubkey, so cloud-init's roster
// seed correctly refuses the sentinel and <state>/devices/ comes up empty. The
// device is approved later and the rock pushes it into the inbox. Since e8263a6
// that file is a GATE and never a key source, so an empty roster derived an empty
// door and the invited member could never get in (found by audit 2026-08-05).
// Bootstrapping is allowed exactly once, and only into a roster with no rows.

const ORGKEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIQrStUvWxYz0123456789abcdefghijklmnop invited-laptop';
const SENTINEL = 'ssh-ed25519 AAAA-no-member-key-staged disabled';

function invitedBox({ orgKeys, devices = [] } = {}) {
  const dir = tmpDir('invite-');
  mkdirSync(join(dir, 'devices'), { recursive: true });
  mkdirSync(join(dir, 'org-inbox', 'keys'), { recursive: true });
  writeFileSync(join(dir, 'org-inbox', 'MEMBERSHIP.yaml'), 'status: "active"\n');
  if (orgKeys !== undefined) writeFileSync(join(dir, 'org-inbox', 'keys', 'member.authorized_keys'), orgKeys);
  for (const d of devices) writeDevice(dir, d);
  return dir;
}

test('first key: an empty roster adopts the org-approved key, so the invited member can get in', () => {
  const dir = invitedBox({ orgKeys: ORGKEY + '\n' });
  const r = syncKeys(dir);
  assert.equal(r.adopted, 1, 'exactly one key bootstrapped');
  assert.equal(r.devices, 1, 'and it is live in the derived door');
  assert.ok(keysAt(dir).includes(ORGKEY), 'the approved device can now authenticate');
});

test('a rock can approve a SECOND device for a member who already has one', () => {
  // Adoption is per-fingerprint, not "only into an empty roster". An earlier
  // attempt at this fix gated on the roster being wholly empty, which restored
  // first-run but silently removed the org's ability to add a replacement or
  // second machine for a member who already had one: their approval would be
  // read as a gate and adopted by nothing. Per-key adoption keeps both.
  const dir = invitedBox({
    orgKeys: ORGKEY + '\n',
    devices: [{ slug: 'mine', label: 'Mine', pubkey: KEY, added: '2026-08-01' }],
  });
  syncKeys(dir);
  const door = keysAt(dir);
  assert.ok(door.includes(KEY), "the member's own device still opens the box");
  assert.ok(door.includes(ORGKEY), 'and the newly approved one does too');
});

test('first key: the invite-pending sentinel is never adopted', () => {
  const dir = invitedBox({ orgKeys: SENTINEL + '\n' });
  const r = syncKeys(dir);
  assert.equal(r.adopted, 0, 'the sentinel is not a key');
  assert.equal(r.devices, 0);
});


// ------------------------------------- the operator door has TWO registries
//
// A rock's founder key is seeded at birth into BOTH
// /state/ssh/aios-op/authorized_keys and <brain>/people/founder.yaml. The
// device roster is a different registry and is empty on a newborn rock, so
// deriving the door from devices alone dropped the founder key — and with
// AuthorizedKeysFile none already applied and no root SSH on these boxes, that
// is a brick, not a degraded door. Proven live on test-rock-003-2 (96 bytes to
// 0) and hit by Sam on his own rock the same day.

function rockState(t, { devices = [], people = null } = {}) {
  mkdirSync(join(t, 'ssh', 'aios-op'), { recursive: true });
  mkdirSync(join(t, 'devices'), { recursive: true });
  writeFileSync(join(t, 'ownership.json'), JSON.stringify({ tier: 'rock' }));
  for (const d of devices) writeFileSync(join(t, 'devices', `${d.slug}.yaml`),
    `slug: "${d.slug}"\nlabel: "${d.slug}"\nstatus: "${d.status || 'active'}"\nadded: "2026-08-11"\nrevoked: ""\npubkeys:\n  - "${d.pubkey}"\n`);
  if (people) {
    mkdirSync(join(t, 'brain', 'people'), { recursive: true });
    writeFileSync(join(t, 'brain', 'people', 'founder.yaml'),
      `name: Founder (provisioning key)\nemail: ""\nrole: "admin"\nstatus: "${people.status || 'active'}"\nadded: "2026-08-11"\nrevoked: ""\npubkeys:\n  - "${people.pubkey}"\n`);
  }
  return join(t, 'ssh', 'aios-op', 'authorized_keys');
}

test('the founder key in the people registry still opens the door', () => {
  const t = tmpDir('ds-');
  const F = 'ssh-ed25519 AAAAfounder founder-provisioning';
  const path = rockState(t, { people: { pubkey: F } });
  writeFileSync(path, F + '\n');
  syncKeys(t);
  assert.match(readFileSync(path, 'utf8'), /AAAAfounder/,
    'an empty device roster must not evict the founder: that is the lockout');
});

test('a revoked founder stays revoked', () => {
  const t = tmpDir('ds-');
  const F = 'ssh-ed25519 AAAAfounder founder-provisioning';
  const D = 'ssh-ed25519 AAAAdevice a-real-device';
  const path = rockState(t, { devices: [{ slug: 'lap', pubkey: D }], people: { pubkey: F, status: 'revoked' } });
  writeFileSync(path, F + '\n');
  syncKeys(t);
  const got = readFileSync(path, 'utf8');
  assert.ok(!got.includes('AAAAfounder'), 'revoking must still mean something');
  assert.match(got, /AAAAdevice/, 'and the live device keeps its way in');
});

test('a key held by both registries is written once', () => {
  const t = tmpDir('ds-');
  const K = 'ssh-ed25519 AAAAsame the-same-key';
  const path = rockState(t, { devices: [{ slug: 'lap', pubkey: K }], people: { pubkey: K } });
  syncKeys(t);
  const n = readFileSync(path, 'utf8').split('\n').filter((l) => l.includes('AAAAsame')).length;
  assert.equal(n, 1, 'the union must be de-duplicated');
});

test('syncKeys REFUSES to empty a door that currently opens', () => {
  const t = tmpDir('ds-');
  const path = rockState(t);   // no devices, no people registry at all
  writeFileSync(path, 'ssh-ed25519 AAAAonly the-only-key-left\n');
  const r = syncKeys(t);
  assert.match(readFileSync(path, 'utf8'), /AAAAonly/,
    'zero-byte here is unrecoverable: no root SSH, and sshd reads nothing else');
  assert.match(String(r.refused || ''), /refused to empty/, 'and it says so rather than failing silently');
});

test('but a first write on a genuinely new box is still allowed', () => {
  const t = tmpDir('ds-');
  const path = rockState(t);
  const r = syncKeys(t);
  assert.equal(readFileSync(path, 'utf8'), '', 'nothing was open, so nothing is bricked');
  assert.ok(!r.refused);
});

test('syncKeys: the empty-door guard holds', () => {
  const dir = state();
  writeDevice(dir, { slug: 'laptop', label: 'L', pubkey: KEY, added: '2026-07-01' });
  syncKeys(dir);
  writeDevice(dir, { slug: 'laptop', label: 'L', pubkey: KEY, added: '2026-07-01', status: 'revoked', revoked: '2026-07-02' });
  const r = syncKeys(dir);
  assert.match(r.refused, /refused to empty the door/);
  assert.ok(keysAt(dir).includes(KEY));
});
