// member-letin-visibility.test.mjs: RETIRED with the account layer
// (face collapse, 2026-09-01).
//
// This file held finding 145 (2026-08-16): the "Let this computer in" button
// hid itself on the second render because one cache flag was doing two jobs,
// and the fix's rule was "visibility follows entitlement, not render order".
// The whole surface is gone now: the button, the /account/devices entitlement
// read behind it, and the account system that answered it were all deleted
// with the self-host strip. A machine is admitted locally instead, from a
// computer that already opens the mineral (the Map page's device roster), so
// there is no async entitlement answer left for a render to race.
//
// The lesson stands and is recorded here on purpose: when a control's
// visibility is derived from an async answer, cache the ASK per subject and
// re-apply the ANSWER on every render. If a remote entitlement surface ever
// grows back, its tests must drive the SECOND render, not the first; one
// render was exactly the blind spot that let 145 ship.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');

test('the let-in button and its entitlement read stay gone', () => {
  assert.ok(!html.includes('connLetIn'), 'no let-in control in the shell');
  assert.ok(!html.includes("fetch('/account/devices')"), 'no entitlement fetch behind it');
  assert.ok(!html.includes('dataset.entitled'), 'no entitlement cache to race a render');
});

test('the recovery copy points at the local device-add instead', () => {
  assert.match(html, /add this one from its Map page/,
    'the denied state names the way in that actually exists: another computer that already opens the mineral');
});
