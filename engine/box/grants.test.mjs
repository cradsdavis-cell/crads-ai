// The rules that stop the access model becoming something else by accident.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { grant, activate, revoke, claim, listGrants, whoCanOpen, readOwnership, EMAIL_RE } from './grants.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const box = (own = {}) => {
  const d = tmpDir('grants-');
  writeFileSync(join(d, 'ownership.json'), JSON.stringify({
    owner: 'member', managed_by: 'org', machinery_by: 'crads-ai', tier: 'pebble',
    anchor: 'crads-ai', holder_email: 'holder@example.com', grants: [], ...own,
  }, null, 2));
  return d;
};

test('a new grant is PENDING, not access', () => {
  const d = box();
  grant(d, 'Harriet@Example.com');
  const [g] = listGrants(d);
  assert.equal(g.email, 'harriet@example.com', 'the address is normalised on the way in');
  assert.equal(g.status, 'pending');
  assert.deepEqual(whoCanOpen(d).map((x) => x.email), ['holder@example.com'],
    'a pending grant opens nothing until the mailbox is proven');
});

test('proving the mailbox is what turns intent into access', () => {
  const d = box();
  grant(d, 'harriet@example.com');
  activate(d, 'harriet@example.com');
  assert.deepEqual(whoCanOpen(d).map((x) => x.email).sort(),
    ['harriet@example.com', 'holder@example.com']);
});

test('granting the same address twice updates the role, never doubles the row', () => {
  const d = box();
  grant(d, 'harriet@example.com', 'member');
  grant(d, 'harriet@example.com', 'admin');
  assert.equal(listGrants(d).length, 1, 'two rows for one address is a revoke that half works');
  assert.equal(listGrants(d)[0].role, 'admin');
});

test('the holder cannot be granted: ownership is not something a grant confers', () => {
  const d = box();
  assert.throws(() => grant(d, 'HOLDER@example.com'), /already holds this mineral/);
  assert.equal(listGrants(d).length, 0);
});

test('revoke returns the row so the caller can cascade its machines', () => {
  const d = box();
  grant(d, 'harriet@example.com');
  activate(d, 'harriet@example.com');
  const removed = revoke(d, 'harriet@example.com');
  assert.equal(removed.email, 'harriet@example.com');
  assert.equal(listGrants(d).length, 0);
  assert.deepEqual(whoCanOpen(d).map((x) => x.email), ['holder@example.com']);
});

test('revoking someone who was never granted says so rather than passing silently', () => {
  assert.throws(() => revoke(box(), 'nobody@example.com'), /has no grant/);
});

test('a grant NEVER touches managed_by: management is not access', () => {
  const d = box();
  const before = readOwnership(d).managed_by;
  grant(d, 'harriet@example.com');
  activate(d, 'harriet@example.com');
  revoke(d, 'harriet@example.com');
  const after = readOwnership(d);
  assert.equal(after.managed_by, before, 'a rock manages its members and must never gain read access this way');
  assert.equal(after.owner, 'member');
  assert.equal(after.holder_email, 'holder@example.com');
});

test('addresses that could escape a shell or a sed are refused, plus-addressing is not', () => {
  const d = box();
  for (const bad of ['a|b@x.com', 'a&b@x.com', 'a b@x.com', 'a"b@x.com', "a'b@x.com", 'no-at-sign', 'a@b']) {
    assert.throws(() => grant(d, bad), /does not look right/, `${bad} must be refused`);
  }
  assert.ok(EMAIL_RE.test('cradsdavis+qa11aug@gmail.com'), 'plus-addressing is legitimate and in real use here');
  grant(d, 'cradsdavis+qa11aug@gmail.com');
  assert.equal(listGrants(d).length, 1);
});

test('a bad role is refused before anything is written', () => {
  const d = box();
  assert.throws(() => grant(d, 'harriet@example.com', 'owner'), /role must be one of/);
  assert.equal(listGrants(d).length, 0, 'nothing is written when the call is refused');
});

test('ownership.json survives a write: it is replaced, never truncated in place', () => {
  const d = box();
  grant(d, 'harriet@example.com');
  const raw = readFileSync(join(d, 'ownership.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw), 'the file a box reads on every boot must always parse');
  assert.match(raw, /\n$/, 'trailing newline, like every other record the box writes');
});

test('a box with no grants key at all is read as having none, not as broken', () => {
  const d = tmpDir('grants-old-');
  writeFileSync(join(d, 'ownership.json'), JSON.stringify({ owner: 'member', tier: 'pebble' }));
  assert.deepEqual(listGrants(d), [], 'boxes born before this field still open');
  grant(d, 'harriet@example.com');
  assert.equal(listGrants(d).length, 1);
});

test('an unheld mineral can be claimed, and the claim is recorded as such', () => {
  const d = box({ holder_email: '' });
  claim(d, 'Sam@Example.com');
  const o = readOwnership(d);
  assert.equal(o.holder_email, 'sam@example.com');
  assert.ok(o.claimed_at, 'a holder that arrived by claim says so, rather than looking born-with');
  assert.deepEqual(whoCanOpen(d).map((x) => x.email), ['sam@example.com']);
});

test('claiming a HELD mineral is refused: being second is not a way to take a box', () => {
  const d = box();   // holder@example.com
  assert.throws(() => claim(d, 'thief@example.com'), /already held by holder@example.com/);
  assert.equal(readOwnership(d).holder_email, 'holder@example.com', 'the real holder is untouched');
});

test('claiming what you already hold is a no-op, not an error', () => {
  const d = box();
  assert.doesNotThrow(() => claim(d, 'HOLDER@example.com'));
  assert.equal(readOwnership(d).holder_email, 'holder@example.com');
});

test('a claim never invents access for anyone else', () => {
  const d = box({ holder_email: '', grants: [{ email: 'harriet@example.com', role: 'member', status: 'pending' }] });
  claim(d, 'sam@example.com');
  const o = readOwnership(d);
  assert.equal(o.grants.length, 1);
  assert.equal(o.grants[0].status, 'pending', 'a pending grant stays pending through a claim');
});

// ---- proofs and mirrors are gone (self-host strip, 2026-09-01) --------------
//
// drainProofs pulled /grant-proofs from the central directory and mirrorNow
// relayed the access record there; the directory and the account system are
// deleted, so both verbs went with them. The guard that matters now is the
// negative: this module and its CLI must be entirely local, or a box starts
// phoning a dead service on every access change.

test('grants.mjs and grants-cli.mjs hold no network client at all', () => {
  for (const f of ['./grants.mjs', './grants-cli.mjs']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/fetch\s*\(/.test(src), `${f} must not fetch`);
    assert.ok(!/directory\.crads-ai\.com|crads-ai\.com\/access/.test(src.replace(/^\s*\/\/.*$/gm, '')),
      `${f} must not name the dead directory or account site outside comments`);
  }
});

// ---- revoke reaches the keys, or it means nothing ---------------------------

import { revokeWithCascade } from './grants.mjs';

// The double mirrors what roster.mjs actually does, INCLUDING the date. It used
// to drop the third argument, which is how the missing stamp (QA finding 148)
// survived: the defect was written into the double as an expectation, so the
// fake and the shipped code agreed and both were wrong. A double that cannot
// express the bug cannot catch it. The real-roster test at the bottom of this
// file is the belt to this file's braces.
const fakeRoster = (devices) => ({
  listDevices: () => devices,
  revokeDevice: (_d, slug, today = new Date().toISOString().slice(0, 10)) => {
    const x = devices.find((v) => v.slug === slug);
    if (x) { x.status = 'revoked'; x.revoked = today; }
  },
});

test('revoking an account cuts the machines that name it', async () => {
  const d = box({ grants: [{ email: 'harriet@example.com', role: 'member', status: 'active' }] });
  const devices = [
    { slug: 'harriet-laptop', account: 'harriet@example.com', status: 'active' },
    { slug: 'harriet-desk', account: 'Harriet@Example.com', status: 'active' },
    { slug: 'holder-laptop', account: 'holder@example.com', status: 'active' },
  ];
  const r = await revokeWithCascade(d, 'harriet@example.com', { roster: fakeRoster(devices) });
  assert.deepEqual(r.cut.sort(), ['harriet-desk', 'harriet-laptop'], 'case differences are the same account');
  assert.equal(devices.find((x) => x.slug === 'holder-laptop').status, 'active',
    'somebody else machine must survive');
});

test('machines with no account are REPORTED, never guessed at', async () => {
  const d = box({ grants: [{ email: 'harriet@example.com', role: 'member', status: 'active' }] });
  const devices = [
    { slug: 'harriet-laptop', account: 'harriet@example.com', status: 'active' },
    { slug: 'mystery', account: '', status: 'active' },
  ];
  const r = await revokeWithCascade(d, 'harriet@example.com', { roster: fakeRoster(devices) });
  assert.deepEqual(r.cut, ['harriet-laptop']);
  assert.equal(r.unattributed, 1, 'a caller must be able to say what it could NOT account for');
  assert.equal(devices.find((x) => x.slug === 'mystery').status, 'active',
    'cutting an unattributed key would be a guess that locks somebody else out');
});

test('already-revoked machines are not counted as still open', async () => {
  const d = box({ grants: [{ email: 'harriet@example.com', role: 'member', status: 'active' }] });
  const devices = [{ slug: 'old', account: '', status: 'revoked' }];
  const r = await revokeWithCascade(d, 'harriet@example.com', { roster: fakeRoster(devices) });
  assert.equal(r.unattributed, 0);
});

test('cascading from a grant that does not exist refuses before touching any key', async () => {
  const d = box();
  const devices = [{ slug: 'holder-laptop', account: 'holder@example.com', status: 'active' }];
  await assert.rejects(() => revokeWithCascade(d, 'nobody@example.com', { roster: fakeRoster(devices) }), /has no grant/);
  assert.equal(devices[0].status, 'active');
});

// ---- QA finding 148, 2026-08-17 ---------------------------------------------
// Run against the REAL roster module, not fakeRoster. The fake above implements
// revokeDevice as `(_d, slug) => { ...status = 'revoked' }`, which ignores the
// date argument entirely, so no test using it could ever have caught this: the
// defect was written into the double as an expectation. The rule this pins is
// that the cascade's cut rows carry the day they were cut, on disk.
test('the cascade stamps the day it cut each machine, on the real roster', async () => {
  const d = box({ grants: [{ email: 'harriet@example.com', role: 'member', status: 'active' }] });
  const { writeDevice, listDevices } = await import('../devices/roster.mjs');
  const PK = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBEqBeSfd/bTMrQlFHEMSnBrPnMDvxDlnHBqLcxvXtOl a';
  writeDevice(d, { slug: 'harriet-laptop', label: 'Harriet laptop', status: 'active',
    added: '2026-08-01', pubkey: PK, account: 'harriet@example.com' });
  const r = await revokeWithCascade(d, 'harriet@example.com');
  assert.deepEqual(r.cut, ['harriet-laptop']);
  const row = listDevices(d).find((x) => x.slug === 'harriet-laptop');
  assert.equal(row.status, 'revoked');
  assert.equal(row.revoked, new Date().toISOString().slice(0, 10),
    'a row that says revoked and cannot say when is not an audit trail');
});

// (The 2026-08-20 "access is not membership" guard, which drove drainProofs
// through a fake directory and asserted no /edges-reflect call, retired with
// drainProofs itself: the whole mirror family is gone, and the no-network pin
// above is the stronger form of the same promise.)
