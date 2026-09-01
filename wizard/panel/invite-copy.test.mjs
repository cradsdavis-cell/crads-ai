// invite-copy.test.mjs — RETIRED (2026-09-01, the face collapse).
//   node --test wizard/panel/invite-copy.test.mjs
//
// What this file used to hold. The invitation a host sent had to be true: the
// expiry it promised had to be the one CLAIM_TTL_MS enforced (finding 140) and
// it could not send the member looking for a Join button that never existed
// (finding 142). The self-host pivot removed invitations altogether: nobody
// provisions or enrols anyone else, sharing rides commons repos, so
// showInviteResult and the copy it assembled are gone from member.html. The
// pins below hold the stronger truth (no invite surface remains), plus the one
// live half of finding 142: the door still offers no Join button, so no copy
// anywhere may ever point at one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(HERE, 'member.html'), 'utf8');

test('the invite surface is RETIRED: showInviteResult and its copy stay out of member.html', () => {
  assert.ok(!html.includes('showInviteResult'), 'the assembler must stay gone');
  assert.ok(!html.includes('expires in 48 hours') && !html.includes('expires in 14 days'),
    'no invite expiry promise remains, true or false');
});

test('the door really has no Join button, so nothing may ever instruct "choose Join"', () => {
  const door = readFileSync(path.join(HERE, 'door.html'), 'utf8');
  const labels = [...door.matchAll(/<button[^>]*>([^<]{2,40})/g)].map((m) => m[1].trim());
  assert.ok(labels.length, 'no buttons parsed; re-anchor');
  assert.ok(!labels.some((l) => /^join\b/i.test(l)),
    `if a Join button is ever added, revisit every instruction that names it (found: ${labels.join(' | ')})`);
});
