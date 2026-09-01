// seen-drain.test.mjs — the local last-seen drain that outlived enrol-sync
// (self-host strip, 2026-09-01). The host's AuthorizedKeysCommand appends
// sightings to /state/devices/seen.log; this stamps the roster and truncates.
// Run: node --test engine/devices/seen-drain.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seenDrain } from './seen-drain.mjs';
import { writeDevice, listDevices, fingerprintOf } from './roster.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb0eXAmpleKeyMaterial0000000000000000000000000';

function boxWithDevice() {
  const stateDir = tmpDir('seen-');
  writeDevice(stateDir, {
    slug: 'laptop', label: 'Laptop', status: 'active',
    added: '2026-08-01', pubkey: KEY,
  });
  return stateDir;
}

test('drains seen.log: stamps the roster row and truncates the log', () => {
  const stateDir = boxWithDevice();
  const fp = fingerprintOf(KEY);
  const seen = join(stateDir, 'devices', 'seen.log');
  mkdirSync(join(stateDir, 'devices'), { recursive: true });
  writeFileSync(seen, [
    `2026-08-30T10:00:00Z ${fp}`,
    `2026-08-31T09:00:00Z ${fp}`,           // last write wins per fingerprint
    '2026-08-31T09:00:00Z not-a-fingerprint', // junk lines are ignored
    '',
  ].join('\n'));
  const r = seenDrain({ stateDir, log: () => {} });
  assert.equal(r.stamped, 1);
  const d = listDevices(stateDir).find((x) => x.slug === 'laptop');
  assert.equal(d.last_seen, '2026-08-31T09:00:00Z', 'the LATEST sighting lands');
  assert.equal(readFileSync(seen, 'utf8'), '', 'the log is truncated after the stamps land');
});

test('no seen.log means a quiet no-op, not an error', () => {
  const stateDir = boxWithDevice();
  const lines = [];
  const r = seenDrain({ stateDir, log: (m) => lines.push(m) });
  assert.equal(r.stamped, 0);
  assert.equal(lines.length, 0, 'a box whose template has no hook stays silent');
});

test('a sighting for an unknown key stamps nothing and still clears the log', () => {
  const stateDir = boxWithDevice();
  const seen = join(stateDir, 'devices', 'seen.log');
  writeFileSync(seen, '2026-08-31T09:00:00Z SHA256:doesnotmatchanyrosterrow\n');
  const r = seenDrain({ stateDir, log: () => {} });
  assert.equal(r.stamped, 0);
  assert.equal(readFileSync(seen, 'utf8'), '');
});

// THE SELF-HOST GUARANTEE: this module must never touch the network. It is the
// local remnant of a job whose every other leg phoned a service that no longer
// exists, and the one regression that matters is a fetch creeping back in.
test('seen-drain holds no network client at all', () => {
  const src = readFileSync(new URL('./seen-drain.mjs', import.meta.url), 'utf8');
  assert.ok(!/fetch\s*\(/.test(src), 'no fetch in the drain');
  assert.ok(!/directory\.crads-ai\.com/.test(src), 'no directory URL in the drain');
});
