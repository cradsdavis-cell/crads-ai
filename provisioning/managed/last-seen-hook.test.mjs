// last-seen-hook.test.mjs: a pebble's sshd tells the box WHICH machine knocked.
//   node --test provisioning/managed/last-seen-hook.test.mjs
//
// Why this file exists. The roster has carried a last_seen column since
// 2026-08-04 and seen-drain (the local remnant of enrol-sync, self-host strip
// 2026-09-01) drains sightings from exactly one place,
// /state/devices/seen.log, written by the host's AuthorizedKeysCommand. The ROCK
// template gained that appender (and the %f that names the key) on 2026-08-13.
// The PEBBLE template did not: its aios-state-keys was `exec cat` and nothing
// else, invoked with %u and no %f. They are two separate files with no shared
// source, so nothing noticed.
//
// The result was not a stale fact, it was a permanently absent one. No hook, no
// log, no drain, so no automated path ever wrote last_seen on a pebble and every
// machine on every pebble rendered "no record yet" forever, while the identical
// page on a rock showed real recency. A member with two laptops, one of them
// lost, opens Devices to decide which row to revoke and is shown two rows that
// look the same.
//
// So this file asserts the whole chain rather than the presence of a string:
// the template's own script is EXECUTED against a fake /state tree, and the log
// it writes is fed to the real seen-drain, which must stamp the real
// roster row. A hook that writes a line seen-drain cannot parse is the same
// outcome as no hook at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seenDrain } from '../../engine/devices/seen-drain.mjs';
import { writeDevice, listDevices, fingerprintOf } from '../../engine/devices/roster.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PEBBLE = join(HERE, 'cloud-init.template.yaml');
const ROCK = join(HERE, '..', 'rock', 'cloud-init.rock.template.yaml');

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIdCgb5L27nNGtdmBbg+6xHvgB1o8gHHzslDSQlPqypI lost@laptop';
const KEY2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH9pQ0kEjKlXsGGvJ2WbNS0aBcDeFgHiJkLmNoPqRsTu desk@home';

/**
 * Lift the aios-state-keys body out of a template's `content: |` block. Lifted,
 * never retyped, so the test cannot end up asserting a script that does not ship.
 */
function hookBody(templatePath) {
  const t = readFileSync(templatePath, 'utf8');
  const start = t.indexOf('  - path: /usr/local/bin/aios-state-keys');
  assert.ok(start > 0, `${templatePath} writes /usr/local/bin/aios-state-keys`);
  const open = t.indexOf('    content: |\n', start) + '    content: |\n'.length;
  // The block scalar ends at the first line indented less than its body.
  const lines = [];
  for (const line of t.slice(open).split('\n')) {
    if (line.trim() !== '' && !line.startsWith('      ')) break;
    lines.push(line.slice(6));
  }
  return `${lines.join('\n').replace(/\s+$/, '')}\n`;
}

/** Install the lifted script into a fake host tree and offer it a fingerprint. */
function offerKey(root, login, fingerprint) {
  const script = join(root, 'aios-state-keys');
  writeFileSync(script, hookBody(PEBBLE).replace(/\/state\//g, `${join(root, 'state')}/`));
  chmodSync(script, 0o755);
  // The two arguments sshd passes: %u then %f. A hook invoked with only %u is
  // the bug this file exists for, so the second is always passed here and the
  // sshd_config assertion below is what proves the box really sends it.
  //
  // stderr is dropped, and it is not hiding a failure. The size guard is
  // `wc -c < "$SEEN"`, and on the FIRST offer the log does not exist yet, so the
  // shell prints its own redirection notice before wc runs, which the `2>/dev/null`
  // on wc cannot suppress. Harmless (`|| echo 0` takes the branch to zero) and
  // byte-identical to the rock's shipped script, which is what the drift test at
  // the bottom of this file requires. Worth fixing in BOTH templates one day
  // (`[ -s "$SEEN" ] && [ "$(wc -c < "$SEEN")" -gt 65536 ]` is silent and two
  // bytes cheaper); it is not this fix's to change days before cohort one.
  return execFileSync('sh', [script, login, fingerprint], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function fakeHost() {
  const root = tmpDir('pebble-seen-');
  mkdirSync(join(root, 'state', 'ssh', 'member'), { recursive: true });
  writeFileSync(join(root, 'state', 'ssh', 'member', 'authorized_keys'), `${KEY}\n${KEY2}\n`);
  return root;
}

test('the pebble hook still serves the door, which is the thing it must never break', () => {
  // First duty, and the one whose failure locks everyone out of the box. The
  // appender is bolted onto a script whose job is to hand sshd the keys, so the
  // keys have to come out the far side unchanged and on stdout.
  const root = fakeHost();
  mkdirSync(join(root, 'state', 'devices'), { recursive: true });
  const out = offerKey(root, 'member', fingerprintOf(KEY));
  assert.ok(out.includes(KEY), 'the roster-derived authorized_keys is what sshd gets');
  assert.ok(out.includes(KEY2), 'every key, not just the one that knocked');
});

test('THE REGRESSION: the pebble hook writes a sighting seen-drain can drain', () => {
  const root = fakeHost();
  const stateDir = join(root, 'state');
  // A real roster row, written by the real writer, so the fingerprint the drain
  // matches on is derived the same way production derives it.
  writeDevice(stateDir, { slug: 'lost-laptop', label: 'Lost laptop', status: 'active', added: '2026-08-01', pubkey: KEY });
  writeDevice(stateDir, { slug: 'desk', label: 'Desk', status: 'active', added: '2026-08-01', pubkey: KEY2 });
  assert.equal(listDevices(stateDir).find((d) => d.slug === 'lost-laptop').last_seen, '',
    'both rows start blank, which is what a member sees today on every pebble');

  offerKey(root, 'member', fingerprintOf(KEY2));

  const seen = join(stateDir, 'devices', 'seen.log');
  assert.ok(existsSync(seen), 'the hook appends to /state/devices/seen.log');
  const [at, fp] = readFileSync(seen, 'utf8').trim().split(/\s+/);
  assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `an ISO instant seen-drain can compare; got ${JSON.stringify(at)}`);
  assert.equal(fp, fingerprintOf(KEY2), 'and the fingerprint of the key that actually knocked');
});

test('THE REGRESSION, end to end: the sighting reaches the row the member reads', () => {
  // The chain, not its halves. seen-drain keys on SHA256:<base64>, which
  // is what sshd's %f prints and what roster.mjs's fingerprintOf derives, and a
  // hook writing anything else would leave the page exactly as blank as no hook.
  // (Since the self-host strip the drain is purely local: no directory, no
  // opt-in secrets, no fetcher. It runs on every box unconditionally.)
  const root = fakeHost();
  const stateDir = join(root, 'state');
  writeDevice(stateDir, { slug: 'lost-laptop', label: 'Lost laptop', status: 'active', added: '2026-08-01', pubkey: KEY });
  writeDevice(stateDir, { slug: 'desk', label: 'Desk', status: 'active', added: '2026-08-01', pubkey: KEY2 });
  offerKey(root, 'member', fingerprintOf(KEY2));

  seenDrain({ stateDir, log: () => {} });

  const rows = listDevices(stateDir);
  const desk = rows.find((d) => d.slug === 'desk');
  const lost = rows.find((d) => d.slug === 'lost-laptop');
  assert.match(desk.last_seen, /^\d{4}-\d{2}-\d{2}T/, 'the machine that knocked now has a recency signal');
  assert.equal(lost.last_seen, '', 'and the one that did not is still honestly blank, which is the whole point');
});

test('the pebble sshd config passes %f, or the hook is handed nothing to log', () => {
  // The other half of the same bug and the easier one to lose in review: the
  // appender is inert without the fingerprint, and `AuthorizedKeysCommand
  // ... %u` looks perfectly correct on its own line.
  const t = readFileSync(PEBBLE, 'utf8');
  assert.match(t, /AuthorizedKeysCommand \/usr\/local\/bin\/aios-state-keys %u %f/,
    'the member Match block must pass the offered key fingerprint as well as the login');
  assert.doesNotMatch(t, /aios-state-keys %u$/m, 'and must not keep a %u-only invocation anywhere');
});

test('a box with no roster yet logs nothing, rather than creating a root-owned directory', () => {
  // /state/devices is created inside the container by roster.mjs, running as the
  // box user. If this root-owned host hook created it first, the container could
  // not write the roster into it. So the guard is on the directory EXISTING, and
  // a box before its first enrolment simply has nothing worth recording.
  const root = fakeHost();
  const out = offerKey(root, 'member', fingerprintOf(KEY));
  assert.ok(out.includes(KEY), 'the door still opens');
  assert.ok(!existsSync(join(root, 'state', 'devices')), 'and the hook did not conjure the directory');
});

test('a key offer with no fingerprint is served and not logged, never half-logged', () => {
  // An older sshd, or a config someone edits back to %u, must degrade to exactly
  // the old behaviour: keys out, no line. A blank fingerprint in seen.log would
  // be worse than none, because the drain would parse it and match nothing while
  // the file grew.
  const root = fakeHost();
  mkdirSync(join(root, 'state', 'devices'), { recursive: true });
  const script = join(root, 'aios-state-keys');
  writeFileSync(script, hookBody(PEBBLE).replace(/\/state\//g, `${join(root, 'state')}/`));
  chmodSync(script, 0o755);
  const out = execFileSync('sh', [script, 'member'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.ok(out.includes(KEY), 'the door opens with or without the fingerprint');
  assert.ok(!existsSync(join(root, 'state', 'devices', 'seen.log')), 'and nothing is logged');
});

test('the log self-truncates, so a box nobody drains cannot fill its own disk', () => {
  const root = fakeHost();
  const stateDir = join(root, 'state');
  mkdirSync(join(stateDir, 'devices'), { recursive: true });
  const seen = join(stateDir, 'devices', 'seen.log');
  writeFileSync(seen, 'x'.repeat(70000));
  offerKey(root, 'member', fingerprintOf(KEY));
  const after = readFileSync(seen, 'utf8');
  assert.ok(after.length < 200, `the oversized log is reset, not appended to; ${after.length} B left`);
  assert.ok(after.includes(fingerprintOf(KEY)), 'and the sighting that triggered the reset still lands');
});

// --- the reason it broke at all -----------------------------------------------
test('the rock and the pebble ship the SAME hook, because two copies is what broke this', () => {
  // No shared source, no generator, two files, and the rock's got the fix on
  // 2026-08-13 while the pebble's did not. Until one of them is spliced from the
  // other, this assertion is the thing that notices. Comments are excluded: the
  // rock can afford prose inside its block scalar and the pebble rides a 32 KiB
  // user-data cap, so their comments legitimately differ. The CODE must not.
  const code = (body) => body.split('\n').filter((l) => !/^\s*#/.test(l) || /^#!/.test(l)).join('\n').trim();
  assert.equal(code(hookBody(PEBBLE)), code(hookBody(ROCK)),
    'the pebble and rock aios-state-keys scripts have drifted apart again');
});

test('both templates invoke it with %u AND %f', () => {
  for (const [name, path] of [['pebble', PEBBLE], ['rock', ROCK]]) {
    assert.match(readFileSync(path, 'utf8'), /AuthorizedKeysCommand \/usr\/local\/bin\/aios-state-keys %u %f/,
      `the ${name} template must pass the fingerprint`);
  }
});
