// device-enrol.test.mjs: RETIREMENT PINS for the asking device's leg of T9.
//
// The staged-enrolment relay (mint a key, bind an account token to it, park
// the request at the central directory, poll for the mineral's verdict) left
// with the self-host pivot (2026-09-01): the directory it relayed through no
// longer exists, and the crads account that signed the ask is gone with it.
// Device admission is LOCAL now: a computer that already opens the mineral
// approves the new one over SSH (device-routes.mjs), no third party involved.
// The panel's /account/devices + /account/enrol-device answer 410 tombstones
// (pinned in not-let-in.test.mjs) so an old page gets a sentence, not a hang.
//
// What survives from this file is the machine-naming floor, which was never
// account-shaped and now lives in machine-name.mjs.
// Run: node --test wizard/panel/device-enrol.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineName, machineSlug } from './machine-name.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('device-enrol.mjs is RETIRED (2026-09-01): the module stays gone', () => {
  assert.ok(!existsSync(join(HERE, 'device-enrol.mjs')), 'device-enrol.mjs must not return to the tree');
});

test('no production module imports the dead enrol relay', () => {
  // machine-name.mjs mentions it in its own history comment, which is fine:
  // what must never come back is an import. Test files are excluded because
  // this file names the module in its pins.
  const offenders = readdirSync(HERE)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .filter((f) => /from '\.\/device-enrol\.mjs'|import\('\.\/device-enrol\.mjs'\)/
      .test(readFileSync(join(HERE, f), 'utf8')));
  assert.deepEqual(offenders, [], `these still import device-enrol.mjs: ${offenders.join(', ')}`);
});

test('the local device-add path is what replaced it, and it is wired', () => {
  // The retirement is only safe because the replacement exists: device-routes
  // carries the offer/complete legs an already-connected machine uses to let a
  // new one in, and panel-server mounts it. If either half vanishes, the
  // retirement pin above stops being a simplification and becomes a locked door.
  assert.ok(existsSync(join(HERE, 'device-routes.mjs')), 'device-routes.mjs is the surviving admission path');
  const door = readFileSync(join(HERE, 'door-server.mjs'), 'utf8');
  assert.match(door, /from '\.\/device-routes\.mjs'/, 'and the door mounts it');
  const server = readFileSync(join(HERE, 'panel-server.mjs'), 'utf8');
  assert.match(server, /from '\.\/machine-name\.mjs'/, 'machineName is imported from its own module, not the dead relay');
});

// ------------------------------------------------- what this machine is called
//
// The surviving subject (2026-08-12): Sam's rock listed "This computer" and
// "Win32" and nothing could say whether that was one machine or two. "Win32"
// is navigator.platform, which shipped app builds still send, so the junk
// filter is the migration and has to hold until those builds are gone. The
// function moved to machine-name.mjs; the behaviour is unchanged.

test('a platform family is not a machine name: navigator.platform is refused', () => {
  const own = machineName();
  for (const junk of ['Win32', 'MacIntel', 'Linux x86_64', 'iPhone', 'computer', 'This computer']) {
    assert.equal(machineName(junk), own, `${junk} must not become a machine name`);
  }
});

test('a real name a human chose still rides', () => {
  assert.equal(machineName('Sam laptop'), 'Sam laptop');
  assert.equal(machineSlug('Sam laptop'), 'sam-laptop');
});

test('the machine name falls back to this machine, never to empty', () => {
  const n = machineName('');
  assert.ok(n && n.length, 'always something');
  assert.ok(n.length <= 60, 'and it fits a roster label');
  assert.ok(!n.includes('.'), 'first hostname label only, no FQDN tail');
  assert.match(machineSlug(''), /^[a-z0-9][a-z0-9-]{0,23}$/, 'a slug the roster will accept');
});
