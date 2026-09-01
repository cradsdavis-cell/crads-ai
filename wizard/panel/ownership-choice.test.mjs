// ownership-choice.test.mjs — RETIRED (2026-09-01, the face collapse).
// Run: node --test wizard/panel/ownership-choice.test.mjs
//
// What this file used to hold. The New Pebble form asked "Who owns their
// pebble?" and the invite-member verb had to carry that answer to
// stamp-pebble.sh as --owner (it dropped it on the floor once, caught
// 2026-08-05 by stamping two pebbles and finding both member-owned). The
// self-host pivot removed the whole subject: nobody stamps a pebble for
// anyone else, so there is no invite, no ownership picker, and no verb to
// carry the choice. The pins below hold the stronger truth: the verb and the
// form stay gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERBS } from './panel-server.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

test('the invite-member verb is RETIRED: the verb table no longer knows it', () => {
  assert.equal(VERBS['invite-member'], undefined, 'invite-member must stay out of VERBS');
});

test('the ownership picker is RETIRED: the New Pebble form left member.html with it', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');
  assert.ok(!html.includes('st_owner'), 'the hidden owner store must stay gone');
  assert.ok(!html.includes('stOwnMember') && !html.includes('stOwnOrg'),
    'the two ownership question cards must stay gone');
  assert.ok(!/data-owner=/.test(html), 'no surface offers an owner choice any more');
});
