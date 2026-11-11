// grants.test.mjs: helper access, named helpers, signed requests, many grants.
//   node --test engine/support/grants.test.mjs
// Spec: docs/superpowers/specs/2026-11-08-helper-access-design.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import {
  readRecord, liveGrants, grantSupport, revoke, checkRequest, approveRequest, declineRequest,
  shapeProblem, decodeRequest, encodeRequest, linkFor, consentText, requestBytes, NAMESPACE,
} from './grants.mjs';
import { syncKeys, supportGrant } from '../devices/device-sync.mjs';
import { writeDevice } from '../devices/roster.mjs';
import { buildRequest, signRequest } from '../../provisioning/managed/helper-request.mjs';
import { snapshot, describe, remindWeekly } from '../box/custody-watch.mjs';

const MID = 'min_0123456789abcdef01234567';
const DEVICE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBEqBeSfd/bTMrQlFHEMSnBrPnMDvxDlnHBqLcxvXtOl laptop';

function keypair(dir, name, comment = name) {
  const p = join(dir, name);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', p]);
  return { priv: p, pub: readFileSync(p + '.pub', 'utf8').trim() };
}

// One signer + one helper per test run; signersFile points at the throwaway signer.
function rig({ ownership = { mineral_id: MID, holder_email: 'client@example.com' } } = {}) {
  const dir = tmpDir('helper-');
  const state = join(dir, 'state');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'ownership.json'), JSON.stringify(ownership));
  const signer = keypair(dir, 'signer');
  const signersFile = join(dir, 'signers');
  writeFileSync(signersFile, `crads-ai namespaces="${NAMESPACE}" ${signer.pub.split(' ').slice(0, 2).join(' ')}\n`);
  const rhys = keypair(dir, 'rhys', 'rhys@laptop');
  const make = (over = {}, now = new Date()) => {
    const r = { ...buildRequest({ name: 'Rhys Morgan', org: 'Example Builds', key: rhys.pub, 'member-email': 'client@example.com', days: 21, purpose: 'Build the invoice automation' }, now), ...over };
    return signRequest(r, signer.priv);
  };
  return { dir, state, signer, signersFile, rhys, make };
}
const keysAt = (state) => readFileSync(join(state, 'ssh', 'member', 'authorized_keys'), 'utf8');

test('a signed request for this mineral shows who, why and for how long, and writes nothing', () => {
  const t = rig();
  const c = checkRequest(t.state, t.make(), { signersFile: t.signersFile });
  assert.equal(c.ok, true, c.reason);
  assert.equal(c.view.helper.name, 'Rhys Morgan');
  assert.equal(c.view.helper.org, 'Example Builds');
  assert.match(c.view.helper.fingerprint, /^SHA256:/);
  assert.equal(c.view.length, '21 days');
  assert.match(c.view.consent, /Rhys Morgan \(Example Builds\)/);
  assert.ok(!existsSync(join(t.state, 'support', 'access.json')), 'showing a request must not write');
});

test('the link form and the bare code are the same request', () => {
  const t = rig();
  const code = t.make();
  assert.equal(checkRequest(t.state, linkFor(code), { signersFile: t.signersFile }).ok, true);
  assert.equal(checkRequest(t.state, `  ${code}\n`, { signersFile: t.signersFile }).ok, true);
});

test('approve opens the door for that key only, with sshd expiry, and the record says who', () => {
  const t = rig();
  writeDevice(t.state, { slug: 'laptop', label: 'L', pubkey: DEVICE, added: '2026-11-01' });
  const r = approveRequest(t.state, t.make(), { signersFile: t.signersFile });
  assert.equal(r.ok, true, r.reason);
  syncKeys(t.state);
  const door = keysAt(t.state);
  assert.ok(door.includes(DEVICE), 'device key kept');
  assert.ok(door.includes(t.rhys.pub.split(' ')[1]), 'helper key added');
  assert.match(door, /expiry-time="\d{12}Z",no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 \S+ rhys@laptop/);
  const g = liveGrants(t.state)[0];
  assert.equal(g.helper.name, 'Rhys Morgan');
  assert.equal(g.consent.version, '1');
  assert.match(g.consent.sha256, /^[0-9a-f]{64}$/);
  const days = (Date.parse(g.expires_at) - Date.parse(g.granted_at)) / 86400_000;
  assert.equal(Math.round(days), 21);
  assert.match(readFileSync(join(t.state, 'ssh', 'member', 'helpers'), 'utf8'), new RegExp(`^SHA256:\\S+ ${g.id}$`, 'm'));
});

test('a request is single use: approve twice, or decline then approve, is refused', () => {
  const t = rig();
  const code = t.make();
  assert.equal(approveRequest(t.state, code, { signersFile: t.signersFile }).ok, true);
  const again = approveRequest(t.state, code, { signersFile: t.signersFile });
  assert.equal(again.ok, false);
  assert.match(again.reason, /already been answered/);
  const code2 = t.make();
  assert.equal(declineRequest(t.state, code2, { signersFile: t.signersFile }).ok, true);
  assert.equal(approveRequest(t.state, code2, { signersFile: t.signersFile }).ok, false);
});

test('a request for another mineral or another member is refused', () => {
  const t = rig();
  const other = checkRequest(t.state, t.make({ for: { mineral_id: 'min_ffffffffffffffffffffffff' } }), { signersFile: t.signersFile });
  assert.equal(other.ok, false);
  assert.match(other.reason, /different mineral/);
  const someoneElse = checkRequest(t.state, t.make({ for: { email: 'someone@else.com' } }), { signersFile: t.signersFile });
  assert.equal(someoneElse.ok, false);
  assert.match(someoneElse.reason, /someone else/);
  const byId = checkRequest(t.state, t.make({ for: { mineral_id: MID } }), { signersFile: t.signersFile });
  assert.equal(byId.ok, true, byId.reason);
});

test('an email-addressed request on a mineral with no owner email asks for the mineral ID instead', () => {
  const t = rig({ ownership: { mineral_id: MID } });
  const c = checkRequest(t.state, t.make(), { signersFile: t.signersFile });
  assert.equal(c.ok, false);
  assert.match(c.reason, /mineral ID/);
});

test('tampered, unsigned and foreign-signed requests are refused before anything is shown', () => {
  const t = rig();
  const code = t.make();
  const { bytes, sig } = decodeRequest(code);
  const forged = JSON.parse(bytes.toString('utf8'));
  forged.days = 30; forged.helper.name = 'Someone Else';
  const tampered = encodeRequest(requestBytes(forged), sig);
  const r1 = checkRequest(t.state, tampered, { signersFile: t.signersFile });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /not signed by Crads-AI/);

  const stranger = keypair(t.dir, 'stranger');
  const r2 = checkRequest(t.state, signRequest(buildRequest({ name: 'X', key: t.rhys.pub, 'member-email': 'client@example.com', days: 3, purpose: 'p' }), stranger.priv), { signersFile: t.signersFile });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /not signed by Crads-AI/);

  assert.equal(checkRequest(t.state, 'hello', { signersFile: t.signersFile }).ok, false);
});

test('a signer file with no key line switches requests off', () => {
  const t = rig();
  writeFileSync(t.signersFile, '# nothing here\n');
  const c = checkRequest(t.state, t.make(), { signersFile: t.signersFile });
  assert.equal(c.ok, false);
  assert.match(c.reason, /not switched on/);
});

test('an unanswered request expires', () => {
  const t = rig();
  const tenDaysAgo = new Date(Date.now() - 10 * 86400_000);
  const c = checkRequest(t.state, t.make({}, tenDaysAgo), { signersFile: t.signersFile });
  assert.equal(c.ok, false);
  assert.match(c.reason, /expired/);
});

test('shape limits: 30 days, 72 hours, one of the two, a purpose, a key', () => {
  const base = buildRequest({ name: 'M', key: DEVICE, 'member-email': 'a@b.co', days: 3, purpose: 'p' });
  assert.equal(shapeProblem(base), '');
  assert.match(shapeProblem({ ...base, days: 31 }), /days must be 1 to 30/);
  assert.match(shapeProblem({ ...base, days: undefined, hours: 73 }), /hours must be 1 to 72/);
  assert.match(shapeProblem({ ...base, hours: 5 }), /either days or hours/);
  assert.match(shapeProblem({ ...base, purpose: '' }), /what the access is for/);
  assert.match(shapeProblem({ ...base, helper: { ...base.helper, key: 'ssh-rsa AAAA x' } }), /ssh-ed25519/);
  assert.match(shapeProblem({ ...base, approve_by: new Date(Date.parse(base.issued_at) + 8 * 86400_000).toISOString() }), /answer window/);
});

test('helpers and the support grant live side by side; revoking one leaves the other', () => {
  const t = rig();
  approveRequest(t.state, t.make(), { signersFile: t.signersFile });
  grantSupport(t.state, 2);
  syncKeys(t.state);
  assert.equal(liveGrants(t.state).length, 2);
  assert.equal(keysAt(t.state).split('\n').filter((l) => l.startsWith('expiry-time=')).length, 2);
  const helperId = liveGrants(t.state).find((g) => g.kind === 'helper').id;
  revoke(t.state, helperId);
  syncKeys(t.state);
  const left = liveGrants(t.state);
  assert.deepEqual(left.map((g) => g.id), ['support']);
  assert.doesNotMatch(keysAt(t.state), /rhys@laptop/);
  assert.doesNotMatch(readFileSync(join(t.state, 'ssh', 'member', 'helpers'), 'utf8'), /req_/);
  revoke(t.state);   // no id = everything, as older apps' single button expects
  assert.equal(liveGrants(t.state).length, 0);
});

test('a second request for the same helper key replaces the first grant', () => {
  const t = rig();
  approveRequest(t.state, t.make({ days: 3 }), { signersFile: t.signersFile });
  approveRequest(t.state, t.make({ days: 14 }), { signersFile: t.signersFile });
  const live = liveGrants(t.state);
  assert.equal(live.length, 1);
  assert.equal(Math.round((Date.parse(live[0].expires_at) - Date.parse(live[0].granted_at)) / 86400_000), 14);
});

test('an access.json from before helpers (one `grant`) still reads and still opens the door', () => {
  const t = rig();
  mkdirSync(join(t.state, 'support'), { recursive: true });
  const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkK crads-support';
  const exp = new Date(Date.now() + 3600_000).toISOString();
  writeFileSync(join(t.state, 'support', 'access.json'), JSON.stringify({ grant: { granted_at: '', expires_at: exp, hours: 1, key }, events: [{ at: 'x', event: 'granted' }] }));
  const rec = readRecord(t.state);
  assert.equal(rec.grants.length, 1);
  assert.equal(rec.grants[0].id, 'support');
  assert.equal(rec.events.length, 1);
  syncKeys(t.state);
  assert.match(keysAt(t.state), /crads-support/);
  assert.equal(supportGrant(t.state).active, true);
});

test('custody-watch names each helper when access opens and when it ends', () => {
  const t = rig();
  const before = snapshot(t.state);
  approveRequest(t.state, t.make(), { signersFile: t.signersFile });
  const during = snapshot(t.state);
  const opened = describe(before, during);
  assert.equal(opened.length, 1);
  assert.match(opened[0], /HELPER ACCESS GRANTED: Rhys Morgan \(Example Builds\)/);
  revoke(t.state);
  const ended = describe(during, snapshot(t.state));
  assert.match(ended[0], /Helper access ended for Rhys Morgan/);
});

test('custody-watch: upgrading a box with a live support grant reports no change', () => {
  const t = rig();
  grantSupport(t.state, 2);
  const now = snapshot(t.state);
  const old = { ...now };
  delete old.helpers;   // a snapshot written by the previous software
  assert.deepEqual(describe(old, now), []);
});

test('weekly reminder: nothing in week one, one line after a week, then not again for a week', () => {
  const t = rig();
  const start = new Date();
  approveRequest(t.state, t.make({ days: 30 }), { signersFile: t.signersFile, now: start });
  const day = (n) => new Date(start.getTime() + n * 86400_000);
  assert.equal(remindWeekly(t.state, { now: day(3), notify: false }).reminded, 0);
  assert.equal(remindWeekly(t.state, { now: day(7.1), notify: false }).reminded, 1);
  assert.equal(remindWeekly(t.state, { now: day(9), notify: false }).reminded, 0);
  assert.equal(remindWeekly(t.state, { now: day(14.2), notify: false }).reminded, 1);
});

test('the consent text names the helper and says plainly whether sessions are recorded', () => {
  const on = consentText({ name: 'Rhys', org: 'Example Builds', until: '2026-12-01T00:00:00Z', recorded: true });
  const off = consentText({ name: 'Rhys', org: 'Example Builds', until: '2026-12-01T00:00:00Z', recorded: false });
  assert.match(on, /Rhys \(Example Builds\)/);
  assert.match(on, /recorded on the server/);
  assert.match(off, /not recorded/);
  assert.doesNotMatch(on + off, /\{[a-z]+\}/, 'no unfilled slots');
  assert.doesNotMatch(on + off, /—/, 'no em dashes');
});
