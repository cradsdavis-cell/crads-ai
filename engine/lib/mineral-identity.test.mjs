// mineral-identity.test.mjs — the ownership/access model on the mineral's own
// disk. The rulings under test: a serial that never changes, one holder,
// first-claim-wins, many accessors, and "you cannot revoke the owner".
// Run: node --test engine/lib/mineral-identity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mineralNames,
  ensureMineralId, claimOwner, grantAccess, revokeAccess, transferOwner,
  identityFacts, readOwnership, MINERAL_ID_RE,
} from './mineral-identity.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const box = () => tmpDir('mineral-');
const SAM = { account_id: 'acc_' + 'a'.repeat(24), email: 'Sam@X.com', kind: 'account' };
const JO = { account_id: 'acc_' + 'b'.repeat(24), email: 'jo@x.com', kind: 'account' };

test('the serial is minted once and never changes', () => {
  const d = box();
  const id = ensureMineralId(d);
  assert.match(id, MINERAL_ID_RE);
  assert.equal(ensureMineralId(d), id, 'stable across calls');
  // and it survives everything else being rewritten
  claimOwner(d, SAM);
  grantAccess(d, { email: 'jo@x.com', role: 'user' });
  transferOwner(d, { kind: 'org', org: 'acme' });
  assert.equal(readOwnership(d).mineral_id, id, 'a rename or a change of hands never re-serials the mineral');
});

test('claiming records the holder AND gives them owner access', () => {
  const d = box();
  const r = claimOwner(d, SAM);
  assert.equal(r.ok, true);
  const f = identityFacts(d);
  assert.equal(f.holder.kind, 'account');
  assert.equal(f.holder.email, 'sam@x.com', 'lowercased');
  assert.equal(f.access.length, 1);
  assert.equal(f.access[0].role, 'owner');
  assert.equal(f.access[0].account_id, SAM.account_id, 'access keys on the permanent id');
});

test('FIRST CLAIM WINS: a different holder is refused, the same one is idempotent', () => {
  const d = box();
  claimOwner(d, SAM);
  const hostile = claimOwner(d, JO);
  assert.equal(hostile.ok, false, 'a mineral re-owned by whoever asks last is not owned at all');
  assert.match(hostile.reason, /already records a different holder/);
  assert.equal(identityFacts(d).holder.email, 'sam@x.com', 'unchanged');

  const again = claimOwner(d, SAM);
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assert.equal(identityFacts(d).access.length, 1, 're-claiming does not duplicate the grant');
});

test('an account with no id yet can still claim, and gains the id on a later claim', () => {
  const d = box();
  claimOwner(d, { email: 'sam@x.com', kind: 'account' });        // pre-id account
  const r = claimOwner(d, SAM);                                   // same human, now with an id
  assert.equal(r.ok, true, 'matched on email');
  assert.equal(identityFacts(d).holder.account_id, SAM.account_id, 'and the id is recorded');
});

test('many accounts may reach one mineral; roles are only owner and user', () => {
  const d = box();
  claimOwner(d, SAM);
  grantAccess(d, { account_id: JO.account_id, email: JO.email, role: 'user' });
  grantAccess(d, { email: 'colleague@x.com', role: 'user' });
  assert.equal(identityFacts(d).access.length, 3, 'the company case: one holder, several reachers');
  assert.equal(grantAccess(d, { email: 'x@y.com', role: 'admin' }).ok, false, 'no invented roles');
  // re-granting updates rather than duplicating
  grantAccess(d, { account_id: JO.account_id, role: 'owner' });
  const jo = identityFacts(d).access.filter((g) => g.account_id === JO.account_id);
  assert.equal(jo.length, 1);
  assert.equal(jo[0].role, 'owner');
});

test('access can be taken away — except the holder\'s own', () => {
  const d = box();
  claimOwner(d, SAM);
  grantAccess(d, { account_id: JO.account_id, email: JO.email, role: 'user' });
  assert.equal(revokeAccess(d, { account_id: JO.account_id }).removed, 1);
  assert.equal(identityFacts(d).access.length, 1);
  const self = revokeAccess(d, { account_id: SAM.account_id });
  assert.equal(self.ok, false, 'losing access to what you own is not a thing');
  assert.match(self.reason, /transfer it rather than/);
});

test('a transfer moves the holder and leaves the old one able to get their things out', () => {
  const d = box();
  claimOwner(d, SAM);
  const t = transferOwner(d, { kind: 'org', org: 'acme' });
  assert.equal(t.ok, true);
  assert.equal(t.previous.email, 'sam@x.com');
  const f = identityFacts(d);
  assert.equal(f.holder.kind, 'org');
  assert.equal(f.holder.org, 'acme', 'a company can hold a person\'s mineral');
  assert.ok(f.access.some((g) => g.email === 'sam@x.com' && g.role === 'user'),
    'the old holder keeps access: an eviction must not lock someone out mid-migration');
  // and the hard version, when that IS what is meant
  const d2 = box();
  claimOwner(d2, SAM);
  transferOwner(d2, JO, { keepOldAccess: false });
  assert.ok(!identityFacts(d2).access.some((g) => g.email === 'sam@x.com'), 'a clean break is possible when asked for');
});

test('it never destroys what the stamp path already wrote', () => {
  const d = box();
  writeFileSync(join(d, 'ownership.json'), JSON.stringify({ owner: 'member', tier: 'pebble', anchor: 'test-org-4' }));
  claimOwner(d, SAM);
  const rec = readOwnership(d);
  assert.equal(rec.tier, 'pebble', 'tier survives');
  assert.equal(rec.anchor, 'test-org-4', 'and the anchor');
  assert.equal(rec.owner, 'member', 'and the legacy role field');
  assert.equal(identityFacts(d).legacy_owner, 'member', 'which a reader can still see');
});

test('mineralNames: a rock is named by its policy, a pebble by its box-name, and a container id only as a last resort', async () => {
  const { mkdirSync } = await import('node:fs');
  const hostname = () => '1c8db1bea6a3';

  // a rock: org-policy.yaml carries both names
  const rock = tmpDir('rock-');
  mkdirSync(join(rock, 'brain'), { recursive: true });
  writeFileSync(join(rock, 'brain', 'org-policy.yaml'), 'org:\n  name: "test-org-4"\n  display_name: "Test Org 4"\n');
  assert.deepEqual(mineralNames(rock, { hostname }), { label: 'Test Org 4', host: 'test-org-4' },
    'the rock is Test Org 4 at test-org-4, never a docker id');

  // a pebble: box-name + org-inbox slug
  const peb = tmpDir('peb-');
  writeFileSync(join(peb, 'box-name'), 'Janet\n');
  writeFileSync(join(peb, 'org-inbox.conf'), 'SLUG=janet\nORG=test-org-4\n');
  assert.deepEqual(mineralNames(peb, { hostname }), { label: 'Janet', host: 'janet' });

  // nothing on disk: honest about having no name, but the host is still real
  const bare = tmpDir('bare-');
  assert.deepEqual(mineralNames(bare, { hostname }), { label: '', host: '1c8db1bea6a3' },
    'no invented names; the display layer says "an unnamed pebble"');
});

// ------------------------------- one fact, one array: grants reach the account
//
// ownership.json carries who may open a mineral in TWO places: `access` (birth:
// holder + owner row) and `grants` (grants-cli: invited, then proven). Only
// `access` is mirrored by /mineral-register, and only the directory's per-account
// index feeds "Your minerals". So an ACTIVE grant opened the SSH door, wrote its
// edge, and never showed up on the grantee's own page.
//
// Proven live on qa-rock-a 2026-08-11 with two real accounts: grant active on the
// box, edge:<hash>:qa-rock-a:admin in KV, no mineralidx for that account, page
// empty. identityFacts is where every mirror reads, so the merge belongs here.

function ownedState(t, grants) {
  mkdirSync(t, { recursive: true });
  writeFileSync(join(t, 'ownership.json'), JSON.stringify({
    owner: 'org', tier: 'rock', anchor: 'crads-ai', mineral_id: 'min_test',
    holder: { kind: 'account', account_id: '', email: 'owner@example.com' },
    access: [{ account_id: '', email: 'owner@example.com', role: 'owner', granted: '2026-08-11' }],
    grants,
  }, null, 2));
  return t;
}

test('an ACTIVE grant joins the access view the directory mirrors', () => {
  const t = ownedState(tmpDir('mi-'), [
    { email: 'friend@example.com', role: 'admin', status: 'active', added_at: '2026-08-11T11:19:16.074Z', activated_at: '2026-08-11T11:21:12.471Z' },
  ]);
  const f = identityFacts(t);
  const emails = f.access.map((a) => a.email);
  assert.ok(emails.includes('friend@example.com'), 'a proven grant must reach the account page');
  assert.ok(emails.includes('owner@example.com'), 'and the owner is still there');
  assert.equal(f.access.find((a) => a.email === 'friend@example.com').role, 'admin');
});

// Rewritten 2026-08-12. The rule this test protects is UNCHANGED — an unproven
// intent is not access — but withholding the row entirely was enforcing it in
// the wrong place, and the cost was a timer. The directory could not know an
// invitation existed, so it had to wait for this box to wake, spot the proof
// and mirror the activation back. Sam accepted an invitation, opened his
// minerals, and saw nothing. Correct, and useless.
//
// The row now rides WITH its status, and the worker refuses to treat a pending
// one as access unless it also holds proof:<org>:<hash> for that caller. Same
// test as the box makes before activating: it invited this address, and this
// address signed in. So what is pinned here is that pending is published and
// LABELLED, never that it is published as access.
test('a PENDING grant mirrors, and is labelled pending so nothing mistakes it for access', () => {
  const t = ownedState(tmpDir('mi-'), [
    { email: 'nope@example.com', role: 'admin', status: 'pending', added_at: '2026-08-11T08:28:14.762Z' },
  ]);
  const row = identityFacts(t).access.find((a) => a.email === 'nope@example.com');
  assert.ok(row, 'the directory cannot resolve an invitation it was never told about');
  assert.equal(row.status, 'pending',
    'an unlabelled row reads as access, which would show a mineral to someone who never proved the mailbox');
});

test('an ACTIVE grant is not labelled pending, so it needs no proof to be reachable', () => {
  const t = ownedState(tmpDir('mi-'), [
    { email: 'friend@example.com', role: 'admin', status: 'active', added_at: '2026-08-11T11:19:16.074Z' },
  ]);
  assert.notEqual(identityFacts(t).access.find((a) => a.email === 'friend@example.com').status, 'pending');
});

test('a REVOKED grant still stays out entirely', () => {
  const t = ownedState(tmpDir('mi-'), [
    { email: 'gone@example.com', role: 'admin', status: 'revoked', added_at: '2026-08-11T08:28:14.762Z' },
  ]);
  assert.ok(!identityFacts(t).access.some((a) => a.email === 'gone@example.com'),
    'revoked is not an invitation and must never reach the mirror');
});

test('a grant to the holder does not duplicate their row', () => {
  const t = ownedState(tmpDir('mi-'), [
    { email: 'OWNER@example.com', role: 'admin', status: 'active', added_at: '2026-08-11T11:19:16.074Z' },
  ]);
  assert.equal(identityFacts(t).access.filter((a) => a.email.toLowerCase() === 'owner@example.com').length, 1);
});

test('no grants at all leaves the birth record untouched', () => {
  const t = ownedState(tmpDir('mi-'), []);
  assert.deepEqual(identityFacts(t).access.map((a) => a.email), ['owner@example.com']);
});

// ---- 2026-08-12: a rock showed its ASSISTANT's name as the organisation ----
//
// mineralNames' own comment has always said a pebble's label is /state/box-name
// and a ROCK's is org-policy display_name. The code read `boxName || orgDisplay
// || orgSlug` for both. On a rock, box-name holds the assistant's PERSONA (the
// onboard skill writes it there deliberately, beside identity.assistant_name),
// so a rock created as "QA Harbour Labs" and onboarded with persona "Foreman"
// showed on the operator's minerals table as Foreman, while the invitation email
// its members received correctly said "set up for you by QA Harbour Labs".
// Two surfaces, two names, one rock.
test('a rock is labelled by its ORGANISATION, not by its assistant', () => {
  const t = tmpDir('mn-');
  mkdirSync(join(t, 'brain'), { recursive: true });
  writeFileSync(join(t, 'ownership.json'), JSON.stringify({ tier: 'rock' }));
  writeFileSync(join(t, 'brain', 'org-policy.yaml'),
    'org:\n  name: "qa-harbour-labs"\n  display_name: "QA Harbour Labs"\n  persona: "Foreman"\n');
  writeFileSync(join(t, 'box-name'), 'Foreman\n');
  assert.equal(mineralNames(t).label, 'QA Harbour Labs',
    'the operator must see the organisation, not the assistant');
});

test('a pebble is still labelled by its box-name', () => {
  const t = tmpDir('mn-');
  writeFileSync(join(t, 'ownership.json'), JSON.stringify({ tier: 'pebble' }));
  writeFileSync(join(t, 'box-name'), 'Wren\n');
  assert.equal(mineralNames(t).label, 'Wren', 'a pebble names itself');
});

test('a rock with no display_name falls back to its slug before its persona', () => {
  const t = tmpDir('mn-');
  mkdirSync(join(t, 'brain'), { recursive: true });
  writeFileSync(join(t, 'ownership.json'), JSON.stringify({ tier: 'rock' }));
  writeFileSync(join(t, 'brain', 'org-policy.yaml'), 'org:\n  name: "qa-harbour-labs"\n');
  writeFileSync(join(t, 'box-name'), 'Foreman\n');
  assert.equal(mineralNames(t).label, 'qa-harbour-labs');
});
