// phantom-control.test.mjs — a control is offered only when the thing it does
// is actually available. Run: node --test wizard/panel/phantom-control.test.mjs
//
// Why this file exists. The member sidebar's "Accept rock transfer" row was
// shown for every member-owned box, staged invitation or not, so a box that
// had never been offered a transfer displayed a permanent button promising an
// action it could not perform (pressed on a real pebble, 2026-08-04).
//
// The face collapse (2026-09-01) retired the transfer machinery whole, row
// and all, so the original phantom cannot re-form. The law it taught stays
// pinned against the surface that still gates a control on availability: the
// seat's Stop hosting flow, which renders only for a mineral actually
// upgraded to host (ownership tier rock).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');

test('the transfer row is RETIRED (2026-09-01): the phantom cannot re-form', () => {
  // A stylesheet selector for #taRow lingers as dead CSS; no element carries
  // the id and no code decides its visibility, so nothing can render it.
  assert.ok(!html.includes('<div id="taRow"'), 'no transfer row in the markup');
  assert.ok(!html.includes('syncTransferRow'), 'no gate deciding a row that does not exist');
  assert.ok(!html.includes('transfer_invitation'), 'no staged-invitation signal read anywhere');
  assert.ok(!html.includes('state.waiting = w;'), 'the seat no longer publishes a waiting state');
});

test('the Waits card is honestly static: no ask can be staged any more', () => {
  assert.ok(html.includes("$('seatWaits').textContent = 'Nothing needs your answer.';"),
    'one sentence, no phantom rows');
});

test('Stop hosting renders only where stopping is possible: ownership tier rock', () => {
  const gate = html.slice(html.indexOf("if ($('seatDanger'))"), html.indexOf("var b = st.backup || {};"));
  assert.match(gate, /var liveDanger = own\.tier === 'rock';/, 'the gate reads the real tier');
  assert.match(gate, /\$\('seatDanger'\)\.style\.display = liveDanger \? '' : 'none';/,
    'a personal mineral never sees the control');
  assert.match(gate, /fold\.style\.display = liveDanger \? '' : 'none';/,
    'and the Advanced fold hides with it, so no empty summary invites a click');
});

test('the armed control still demands the typed phrase before it can fire', () => {
  const gate = html.slice(html.indexOf("if ($('seatDanger'))"), html.indexOf("var b = st.backup || {};"));
  assert.match(gate, /rtBtn\.disabled = rtIn\.value\.trim\(\)\.toLowerCase\(\) !== 'stop hosting';/,
    'the button stays dead until the exact phrase is typed');
  assert.match(gate, /fetch\('\/demote'/, 'and it runs the mineral-local demote, nothing central');
});
