// phantom-control.test.mjs — a control is offered only when the thing it does
// is actually available. Run: node --test wizard/panel/phantom-control.test.mjs
//
// Why this file exists. The member sidebar's "Accept rock transfer"
// row was shown for every member-owned box:
//
//   tr.style.display = o.owner === 'member' ? 'block' : 'none';
//
// with no reference to whether a rock had actually staged anything. So
// a box that had never been offered a transfer — and that carries no
// /state/org-inbox/transfer directory at all — displayed a permanent button
// promising an action it could not perform. Pressed on a real pebble on
// 2026-08-04 it answered "No transfer invitation from your rock.":
// honest once clicked, but the offer should never have been on screen.
//
// The seat already renders a correctly gated card from w.transfer_invitation.
// The sidebar row now reads the same signal, so the two surfaces cannot
// disagree about whether there is anything to accept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');

test('the sidebar transfer row is not shown on ownership alone', () => {
  assert.doesNotMatch(
    html,
    /tr\.style\.display = o\.owner === 'member' \? 'block' : 'none';/,
    'ownership alone must not reveal the accept control',
  );
});

test('the sidebar transfer row is gated on a staged invitation', () => {
  const fn = html.match(/function syncTransferRow\(\)\{[\s\S]{0,600}?\n  \}/);
  assert.ok(fn, 'a single place must decide whether the row is shown');
  assert.match(fn[0], /transfer_invitation/, 'it must require a staged invitation');
  assert.match(fn[0], /owner === 'member'/, 'and it must still only apply to a box you own');
});

// Grepping the gate for the two condition names says nothing about WHAT IT
// RENDERS: an inverted gate would pass that check, and nothing then covered the
// row ever legitimately appearing. So run the real function against a fake row
// and assert the direction in both senses.
test('the gate actually shows and hides in the right directions', () => {
  const fn = html.match(/function syncTransferRow\(\)\{[\s\S]{0,600}?\n  \}/)[0];
  const run = (ownership, waiting) => {
    const row = { style: { display: 'untouched' } };
    const state = { ownership, waiting };
    // eslint-disable-next-line no-new-func
    new Function('$', 'state', `${fn}; syncTransferRow();`)((id) => (id === 'taRow' ? row : null), state);
    return row.style.display;
  };
  const staged = { transfer_invitation: { org_slug: 'acme' } };
  assert.equal(run({ owner: 'member' }, staged), 'block', 'a member-owned box WITH an offer must show it');
  assert.equal(run({ owner: 'member' }, {}), 'none', 'no offer, no control');
  assert.equal(run({ owner: 'org' }, staged), 'none', 'an org-owned box does not accept a transfer-to-org');
  assert.equal(run({}, undefined), 'none', 'and an unknown shape stays hidden rather than guessing');
});

test('the seat records the waiting state the row depends on', () => {
  assert.match(html, /state\.waiting = w;/, 'the seat must publish what it learned');
  assert.match(html, /syncTransferRow\(\);/, 'and refresh the row from it');
});

test('the row starts hidden, so a box never asked stays quiet', () => {
  const markup = html.match(/<div id="taRow"[^>]*>/);
  assert.ok(markup, 'the row must still exist');
  assert.match(markup[0], /display:none/, 'default hidden');
});
