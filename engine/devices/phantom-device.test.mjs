// phantom-device.test.mjs — a row that cannot open the box must not be shown as
// a computer that can. Run: node --test engine/devices/phantom-device.test.mjs
//
// Why this file exists. A box stamped invite-pending was seeded with a SENTINEL
// device row whose "key" is the literal string
// "ssh-ed25519 AAAA-no-member-key-staged disabled". Two earlier fixes addressed
// it: cloud-init stopped writing the row (2026-08-03) and roster-cli's revoke
// guard stopped counting it as usable. Neither helps the FLEET THAT ALREADY
// EXISTS, and neither touches the DISPLAY.
//
// Found live on 2026-08-04 on a pebble stamped that same day: the member's
// Network page listed TWO devices, both labelled "This computer", both ACTIVE,
// each with Rename and Revoke — one of them a phantom that has never connected
// and never can. That page is the security surface whose own copy says "If a
// laptop is lost or stolen, revoke it here", and it cannot tell you which row
// is your laptop. So the roster itself now says which rows are real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listDevices } from './roster.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const REAL = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKemV6Rj8CstqNwgpZ6lezNtcj/LEIKgpjoe+zINwPA+';
const SENTINEL = 'ssh-ed25519 AAAA-no-member-key-staged disabled';

function boxWith(rows) {
  const d = tmpDir('roster-');
  mkdirSync(join(d, 'devices'), { recursive: true });
  for (const [slug, key, extra = ''] of rows) {
    writeFileSync(join(d, 'devices', `${slug}.yaml`),
      `label: "This computer"\nstatus: "active"\nadded: "2026-08-04"\nrevoked: ""\nlast_seen: ""\nvaultkey: ""\n${extra}pubkeys:\n  - ${key}\n`);
  }
  return d;
}

test('a sentinel row is reported as unusable, a real one as usable', () => {
  const rows = listDevices(boxWith([['this-computer', SENTINEL], ['this-computer-2', REAL]]));
  const byslug = Object.fromEntries(rows.map((r) => [r.slug, r]));
  assert.equal(byslug['this-computer'].usable, false, 'the sentinel cannot open the box');
  assert.equal(byslug['this-computer-2'].usable, true, 'the real key can');
});

test('a revoked device with a real key is not usable either', () => {
  const d = tmpDir('roster-');
  mkdirSync(join(d, 'devices'), { recursive: true });
  writeFileSync(join(d, 'devices', 'old.yaml'),
    `label: "Old laptop"\nstatus: "revoked"\nadded: "2026-01-01"\nrevoked: "2026-08-04"\nlast_seen: ""\nvaultkey: ""\npubkeys:\n  - ${REAL}\n`);
  assert.equal(listDevices(d)[0].usable, false);
});

test('an empty roster stays empty', () => {
  assert.deepEqual(listDevices(tmpDir('roster-')), []);
});

test('usable is present on every row, so a consumer can always ask', () => {
  for (const r of listDevices(boxWith([['a', REAL], ['b', SENTINEL]]))) {
    assert.equal(typeof r.usable, 'boolean', `${r.slug} must carry usable`);
  }
});

// ---------------------------------------------------------------------------
// The member's page must consume the flag, and must stay safe against a box
// whose engine is older than it (that box sends no `usable` at all, and must
// keep listing the devices it does have).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join as pjoin } from 'node:path';
const MEMBER = readFileSync(pjoin(dirname(fileURLToPath(import.meta.url)), '..', '..', 'wizard', 'panel', 'member.html'), 'utf8');

test('the Network page hides rows that cannot open the box', () => {
  const filter = MEMBER.match(/var live = \(data\.devices \|\| \[\]\)\.filter\([^;]+;/);
  assert.ok(filter, 'the device filter must still exist');
  assert.match(filter[0], /usable !== false/, 'must drop explicit phantoms but tolerate an older engine');
  assert.doesNotMatch(filter[0], /usable === true/, 'an older engine sends no flag and must not be blanked');
});

