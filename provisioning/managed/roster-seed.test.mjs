// roster-seed.test.mjs: the member box boots with its own key ON THE ROSTER.
//   node --test provisioning/managed/roster-seed.test.mjs
//
// Why this file exists. sshd on a member box reads TWO key sources: the host's
// /home/member/.ssh/authorized_keys (AuthorizedKeysFile, where the stamped key
// lands) and /state/ssh/member/authorized_keys (AuthorizedKeysCommand, derived
// from the device roster the app shows). The container cannot see the first.
// So unless cloud-init copies the stamped key INTO the roster at the one moment
// it is visible, the member's own laptop connects fine and appears nowhere:
// Devices lists nothing, Revoke cannot revoke it, and the cold tier is
// unreachable. Proven live on brainiac (2026-08-03), whose box was stamped from
// a working tree parked on a branch that predated the seed.
//
// Two duties, matching how it actually broke:
//   1. the template carries the seed at all
//   2. provision-pebble.sh REFUSES to stamp a member key without it, so a stale
//      checkout fails before the VM exists instead of on a live box
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDevices } from '../../engine/devices/roster.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, 'cloud-init.template.yaml');
const PROVISION = join(HERE, 'provision-pebble.sh');

test('the member cloud-init seeds the stamped key into the device roster', () => {
  const t = readFileSync(TEMPLATE, 'utf8');
  assert.match(t, /\/home\/member\/\.ssh\/authorized_keys/, 'reads the stamped host key');
  assert.match(t, /\/state\/devices/, 'writes a roster row');
  // The row must be the exact shape roster.mjs render() emits, or listDevices
  // reads a device with no label or no key and the page stays empty anyway.
  assert.match(t, /pubkeys:/, 'the row carries a pubkeys block-list');
  assert.match(t, /label:/, 'and a label');
  assert.match(t, /status:/, 'and a status');
  // Seeded BEFORE the roster becomes the only door, or the box locks itself out.
  const seedAt = t.indexOf('/state/devices');
  const onlyDoorAt = t.indexOf('AuthorizedKeysFile none');
  if (onlyDoorAt !== -1) assert.ok(seedAt < onlyDoorAt, 'the seed must precede making the roster the only door');
});

// --- the seed block, actually executed: WHOSE key ended up on the roster ------
//
// Finding 147 (live QA, 2026-08-16). The seed above is `head -n1` of the host
// authorized_keys, matched on key SHAPE, written as "This computer". On a pebble
// stamped BY A ROCK the member has no key yet, so fulfil-arrivals boots the box
// on the PLATFORM's enrolment key, and that is the key the seed found. Verified
// byte-for-byte on qa-member-four and qa-member-five: Crads-AI's own live shell
// access, on the member's Access page, labelled as their own laptop, with a
// Remove button, under a welcome email that says nobody can see inside the box.
//
// The string checks above cannot catch this: the template DID seed a roster row,
// it just seeded the wrong identity. So this half runs the shell cloud-init runs.
// Same shape as the rock's operator-seed.test.mjs, which has asserted the
// equivalent ("the platform key must never be written into the people registry as
// a person") since finding 98 and is the reason the rock never shipped this bug.
const MEMBER_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIdCgb5L27nNGtdmBbg+6xHvgB1o8gHHzslDSQlPqypI qa-member-five-box-2026';
const PLATFORM_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePlatformEnrolKeyForTestsOnly000000 crads-enrolment';
const SENTINEL = 'ssh-ed25519 AAAA-no-member-key-staged disabled';

/** Run the template's own seed block against a fake host tree; return {root, rows}. */
function seedTree(hostKey) {
  const root = tmpDir('pebble-seed-');
  mkdirSync(join(root, 'home', 'member', '.ssh'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  if (hostKey !== null) writeFileSync(join(root, 'home', 'member', '.ssh', 'authorized_keys'), `${hostKey}\n`);

  // Lifted out of the template, never retyped, so the test cannot drift from
  // what ships. Absolute paths repointed at the fake tree.
  const t = readFileSync(TEMPLATE, 'utf8');
  const start = t.indexOf('    KEY="$(head -n1 /home/member');
  const end = t.indexOf('\n    fi', start) + '\n    fi'.length;
  assert.ok(start > 0 && end > start, 'found the seed block in the template');
  const script = t.slice(start, end)
    .replace(/\/home\/member/g, join(root, 'home', 'member'))
    .replace(/\/state\/devices/g, join(root, 'state', 'devices'))
    .replace(/\/state\/ssh/g, join(root, 'state', 'ssh'))
    .replace(/^\s*chown .*$/gm, ':');   // no chown in a test tree

  execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  // Read it back through the REAL parser, not a regex: a row the box writes but
  // listDevices cannot read is the failure mode this whole file exists for.
  return { root, rows: listDevices(join(root, 'state')) };
}

/** Just the roster rows, which is all most cases here care about. */
const runSeed = (hostKey) => seedTree(hostKey).rows;

test('a member-stamped pebble still seeds their own laptop as "This computer"', () => {
  const rows = runSeed(MEMBER_KEY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slug, 'this-computer');
  assert.equal(rows[0].label, 'This computer');
  assert.equal(rows[0].pubkey, MEMBER_KEY);
  assert.equal(rows[0].usable, true, 'and it can actually open the box');
});

test('147: a rock-stamped pebble never calls the PLATFORM key "This computer"', () => {
  const rows = runSeed(PLATFORM_KEY);
  assert.equal(rows.length, 1, 'the key is still on the roster, so it stays revocable');
  assert.ok(!rows.some((d) => d.slug === 'this-computer'),
    'the platform key must never be seeded as the member\'s own machine');
  assert.doesNotMatch(rows[0].label, /this computer/i,
    `the member reads this label on their Access page; got ${JSON.stringify(rows[0].label)}`);
  assert.match(rows[0].label, /Crads-AI/, 'it says whose key it is');
  assert.equal(rows[0].pubkey, PLATFORM_KEY, 'and it is the same key, only named honestly');
});

test('147: the platform row lands under the slug the handover already revokes', () => {
  // enrol-arrivals.mjs hands a claimed pebble over with `roster-cli revoke
  // crads-enrol` and then VERIFIES the key is gone. Against a row called
  // this-computer that command died on "no device crads-enrol", so every pebble
  // reported "⚠️ THE CRADS ENROLMENT KEY IS STILL ON THE BOX" and it was true.
  const [row] = runSeed(PLATFORM_KEY);
  assert.equal(row.slug, 'crads-enrol');
  // roster-cli's own SLUG_RE, or add/rename/revoke refuse the row by name.
  assert.match(row.slug, /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/);
});

test('the sentinel is still seeded as nothing at all (live-cert 2026-08-03)', () => {
  // The phantom-device lockout. Kept executed rather than string-checked because
  // the 147 fix edits the same block, and a `case` that fell through to a default
  // would happily give the sentinel a name.
  for (const junk of [SENTINEL, 'ssh-rsa AAAAB3NzaC1yc2EAAAA', '__MEMBER_PUBKEY__', '', null]) {
    assert.equal(runSeed(junk).length, 0, `${JSON.stringify(junk)} must not become a device`);
  }
});

test('147: the only-door switch fires for EITHER row, or the platform key becomes unrevokable', () => {
  // The switch keys off the seeded FILENAME. Renaming the row without teaching it
  // the new name would leave every rock-stamped pebble reading the host
  // authorized_keys forever, where nothing in the product can revoke anything:
  // the same unrevokable-key bug one repo over.
  const t = readFileSync(TEMPLATE, 'utf8');
  const block = t.slice(t.indexOf('if [ -s /state/devices/'));
  assert.match(block, /if \[ -s \/state\/devices\/this-computer\.yaml \] \|\| \[ -s \/state\/devices\/crads-enrol\.yaml \]/,
    'both filenames the seed can write must arm the roster-only door');
  assert.match(block, /sshd -t/, 'validated before it is trusted');
});

// Running the real script in a test is only safe because of the stop-block
// below. Learned the hard way on 2026-08-03: blanking HCLOUD_TOKEN in the pebble
// env does NOT disarm it, because lib.sh sources .env.local afterwards, and a
// "negative control" run stamped a live Hetzner VM + tunnel + DNS record before
// anyone noticed (torn down immediately, but it should have been impossible).
//
// So every spawn here pre-creates the run's own state file. `[ -f "$STATE" ] &&
// die "already provisioned"` sits AFTER the preflight and BEFORE the first API
// call, so the script has a hard stop it reaches no matter what the preflight
// does. A regression can now only produce a wrong assertion, never a VM.
const SLUG = 'roster-seed-selftest';
function stoppedRun(scriptPath, { stateDir, extraEnv = {} }) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `${SLUG}.env`), '# stop-block: this run must never reach the network\n');
  return spawnSync('bash', [scriptPath, SLUG], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMBER_PUBKEY: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTheTestOnly0 t',
      CF_TUNNEL_ROOT_DOMAIN: 'example.test', CF_ZONE_NAME: 'example.test',
      HCLOUD_TOKEN: 'never-used', CF_API_TOKEN: 'never-used',
      AIOS_STATE_DIR: stateDir,
      // These runs are about the ROSTER guard. The separate shipping-ref pin
      // (preflight_checkout_current) would refuse first whenever the repo is
      // mid-edit, which is exactly when this suite runs, so it is waived here.
      // Waiving it cannot mask the roster guard: that one is its own check and
      // reads none of this. The pin has its own suite, checkout-pin.test.mjs.
      AIOS_ALLOW_STALE_CHECKOUT: '1',
      ...extraEnv,
    },
  });
}

test('provision-pebble refuses a member key when the template has no roster seed', () => {
  // A stale checkout, reproduced: same script, template with the seed stripped.
  const dir = tmpDir('roster-seed-');
  copyFileSync(PROVISION, join(dir, 'provision-pebble.sh'));
  copyFileSync(join(HERE, 'lib.sh'), join(dir, 'lib.sh'));
  const stale = readFileSync(TEMPLATE, 'utf8')
    .split('\n').filter((l) => !l.includes('/state/devices')).join('\n');
  writeFileSync(join(dir, 'cloud-init.template.yaml'), stale);

  const r = stoppedRun(join(dir, 'provision-pebble.sh'), { stateDir: join(dir, 'state') });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.notEqual(r.status, 0, 'a stale template must not produce a box');
  assert.match(out, /device-roster seed|behind the shipping branch/,
    `expected the roster-seed preflight to fire; got:\n${out.slice(-800)}`);
  assert.doesNotMatch(out, /already provisioned/, 'the preflight must fire BEFORE the stop-block, not after');
});

test('the preflight does not fire on this checkout (a guard that always trips blocks every stamp)', () => {
  const dir = tmpDir('roster-seed-ok-');
  const r = stoppedRun(PROVISION, { stateDir: join(dir, 'state') });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.doesNotMatch(out, /device-roster seed/, `the preflight tripped on a good template:\n${out.slice(-800)}`);
  // got past the preflight and stopped at the stop-block, having created nothing
  assert.match(out, /already provisioned/, `expected the run to reach the stop-block; got:\n${out.slice(-800)}`);
});

// --- the door the roster derives is seeded at birth too (self-host, 2026-09-01)
//
// sshd is about to be told AuthorizedKeysFile none, after which member SSH reads
// ONLY /state/ssh/member/authorized_keys via AuthorizedKeysCommand. Its single
// writer, device-sync.mjs, lives in the container, which is not up yet. Until
// the self-host strip something always got there first: enrol-sync, or the
// device-sync call inside org-sync.sh. enrol-sync was deleted 2026-09-01, and
// org-sync exits at "not an org-managed box" long before that call, so an
// org-less box wrote the file NEVER. test-mineral-4 booted healthy, container
// running, image pulled, with member SSH shut and no root SSH to fix it from.
// The whole wizard sat on "waiting for it to wake up" until the deadline.
test('the seed also writes the member door, not just the roster row', () => {
  const { root } = seedTree(MEMBER_KEY);
  const door = join(root, 'state', 'ssh', 'member', 'authorized_keys');
  assert.ok(existsSync(door), 'cloud-init must seed /state/ssh/member/authorized_keys at birth');
  assert.equal(readFileSync(door, 'utf8').trim(), MEMBER_KEY,
    'and it must be the same key the roster row carries');
});

test('a key too junk for the roster is too junk for the door', () => {
  // Both writes live inside the one shape-match, so this can only break if
  // someone moves the door write out of it.
  for (const junk of [SENTINEL, '', null]) {
    const { root } = seedTree(junk);
    assert.ok(!existsSync(join(root, 'state', 'ssh', 'member', 'authorized_keys')),
      `${JSON.stringify(junk)} must not become the door`);
  }
});

test('the door is seeded BEFORE the roster becomes the only door', () => {
  // Written the wrong way round this is a total lockout: these boxes have no
  // root SSH, so the only way back in is rescue mode.
  const t = readFileSync(TEMPLATE, 'utf8');
  const doorAt = t.indexOf('/state/ssh/member/authorized_keys');
  const onlyDoorAt = t.indexOf('AuthorizedKeysFile none');
  assert.ok(doorAt > 0, 'the template seeds the door at all');
  assert.ok(doorAt < onlyDoorAt, 'the door seed must precede the roster-only switch');
});

test('the chown comes AFTER the door write, or device-sync can never update it', () => {
  // root writes both files; device-sync runs as the container's aios uid. Chown
  // before the write leaves a correct door that nothing can ever rewrite, so add
  // and revoke silently stop working: a correct-looking box that quietly cannot
  // change its own locks. The executed half of this file cannot catch it (the
  // harness stubs chown out), so the order is pinned here.
  const t = readFileSync(TEMPLATE, 'utf8');
  const write = t.indexOf('> /state/ssh/member/authorized_keys');
  const chown = t.indexOf('chown -R aios:aios /state/devices /state/ssh');
  assert.ok(write > 0, 'the door is written');
  assert.ok(chown > write, 'and handed to aios only once it exists');
});
