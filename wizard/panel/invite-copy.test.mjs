// invite-copy.test.mjs — the invitation a host sends must be true.
//   node --test wizard/panel/invite-copy.test.mjs
//
// This is the first thing a new member ever reads about Crads-AI, and on
// 2026-08-24 it carried two instructions that were false, both of them known:
//
//   "it expires in 14 days"  — QA finding 140. The only expiry anything
//     enforces is CLAIM_TTL_MS in cockpit/jobs/enrol-arrivals.mjs, which is 48
//     HOURS and refuses an older claim outright. 140 found one link carrying
//     three different promises; the join page was corrected and this one, the
//     copy the member actually receives, was not.
//
//   "choose Join"            — QA finding 142. There is no Join button. The
//     door offers Connect this computer, Continue, Create my pebble and Sign in
//     to Crads-AI. A member following this instruction looks for a control that
//     has never existed, and concludes they have the wrong app.
//
// Pinned by SOURCE STRING rather than by driving the page, deliberately: this
// text is assembled in a function that only runs after a real invite is minted
// against a real rock, which no test can reach. A string pin is weaker than a
// driven assertion and it is what is available; it is still enough to stop the
// two specific regressions above.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(HERE, 'member.html'), 'utf8');
const invite = /function showInviteResult\([\s\S]*?\n {4}}/.exec(html);

test('the invite function is still where this test thinks it is', () => {
  assert.ok(invite, 'showInviteResult moved or was renamed; re-anchor this test');
});

test('the invite promises the expiry the code actually enforces', () => {
  assert.match(invite[0], /expires in 48 hours/,
    'CLAIM_TTL_MS is 48h (cockpit/jobs/enrol-arrivals.mjs); the member must be told that');
  assert.doesNotMatch(invite[0], /14 days/,
    'nothing anywhere enforces 14 days (finding 140)');
});

test('the invite does not send the member looking for a Join button', () => {
  assert.doesNotMatch(invite[0], /choose Join/i,
    'no Join control exists in the app (finding 142)');
});

test('the door really has no Join button, so the rule above still applies', () => {
  const door = readFileSync(path.join(HERE, 'door.html'), 'utf8');
  const labels = [...door.matchAll(/<button[^>]*>([^<]{2,40})/g)].map((m) => m[1].trim());
  assert.ok(labels.length, 'no buttons parsed; re-anchor');
  assert.ok(!labels.some((l) => /^join\b/i.test(l)),
    `if a Join button is ever added, this test and the invite copy should change together (found: ${labels.join(' | ')})`);
});
