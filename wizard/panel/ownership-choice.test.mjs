// ownership-choice.test.mjs — the ownership picker must actually own something.
// Run: node --test wizard/panel/ownership-choice.test.mjs
//
// Why this file exists. The New Pebble form asks "Who owns their pebble?" and
// offers three answers, with a help panel spelling out the consequences: a
// member-owned brain is theirs and goes with them, a rock-owned box is a work
// asset whose brain lives in the rock's account and comes back when they leave.
//
// invite-member never read that answer. It handled slug, name, email, provider
// and region, and dropped `owner` on the floor, so every pebble came out
// member-owned whatever the admin chose. Caught on 2026-08-05 by stamping two
// pebbles on one rock, deliberately one of each, and finding both registry rows
// saying owner: "member".
//
// stamp-pebble.sh has taken --owner all along (OWNER_OVERRIDE at line 67), so the
// choice had a home to go to; nothing carried it there. An empty choice must
// still mean "the rock's default", which is what the first option says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERBS } from './panel-server.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const base = { slug: 'jane01', name: 'Jane Doe', email: 'jane@example.com', provider: 'google' };
const cmd = (over = {}) => VERBS['invite-member'].build({ ...base, ...over }).command;

test('a rock-owned pebble is stamped rock-owned', () => {
  assert.match(cmd({ owner: 'org' }), /--owner org\b/, 'the admin chose a work asset and must get one');
});

test('a member-owned pebble is stamped member-owned', () => {
  assert.match(cmd({ owner: 'member' }), /--owner member\b/);
});

test("no choice means the rock's default, which is what the form's first option promises", () => {
  assert.doesNotMatch(cmd({}), /--owner/, 'passing nothing lets org-policy decide, as documented');
});

test('a junk ownership value is refused, not passed through to a shell', () => {
  for (const bad of ['everyone', 'org; touch /tmp/pwn', '$(id)', 'MEMBER ']) {
    assert.throws(() => cmd({ owner: bad }), /own/i, `must refuse ${JSON.stringify(bad)}`);
  }
});

test('the form still offers exactly the three answers the verb understands', () => {
  // Since the staged flow (2026-08-09) the select is hidden and the two
  // question cards write into it; the VALUE CONTRACT with the verb is
  // unchanged, and that contract is what this test pins.
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');
  // The hidden select became a hidden input in the 2026-08-10 fold cleanup;
  // the qcards remain the only writers and the value contract is unchanged.
  const sel = html.match(/<input type="hidden" id="st_owner" value="">/);
  assert.ok(sel, 'the (hidden) owner store must still exist');
  assert.ok(/qcard" id="stOwnMember" data-owner="member"/.test(html) && /qcard" id="stOwnOrg" data-owner="org"/.test(html),
    'the two question cards cover the two real answers');
  assert.match(html, /\$\('st_owner'\)\.value = c\.getAttribute\('data-owner'\)/, 'the qcards write the two real answers into it');
  assert.ok(!/data-owner="(?!member|org)[^"]+"/.test(html), 'a third owner value would be a promise the verb cannot keep');
});
