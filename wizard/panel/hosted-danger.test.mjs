// The Danger zone renders NOTHING unless a destructive action is live and
// unlocked for this mineral (R19c, panel iteration 2, 2026-08-23).
//
// History: the zone was written around the self-provisioned flow and on a
// hosted rock rendered three blocks of warning about an action it did not
// offer; 2026-08-10 cut that to one "not self-serve" line, and R19c went the
// rest of the way. The face collapse (2026-09-01) then removed the org face
// altogether: the rock-page zone (dangerZone, retireWrap, deleteWrap, odCard,
// syncDanger, renderOrgDelete) left with it, and the one danger surface that
// remains is the seat mirror, whose one live action is mineral-local stop
// hosting. The R19c rule is pinned there; the org zone is pinned gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

test('the org-face danger zone is RETIRED: its wrapper, cards and switches stay gone', () => {
  for (const id of ['dangerZone', 'retireWrap', 'deleteWrap', 'odCard', 'odLocked']) {
    assert.ok(!html.includes(`id="${id}"`), `${id} must stay gone`);
  }
  for (const fn of ['syncDanger', 'renderOrgDelete', 'syncRetire']) {
    assert.ok(!html.includes(`function ${fn}(`), `${fn} must stay gone`);
  }
  assert.ok(!html.includes('Not self-serve'), 'the hosted-era locked line stays gone too');
  // whole-server deletion is not a panel action any more; it happens at the
  // hosting provider, which is why no delete form comes back
  assert.ok(!html.includes('Delete this rock'), 'no delete-this-rock surface remains');
});

test('the seat Danger mirror still follows R19c: nothing renders unless an action is live', () => {
  const seat = html.slice(html.indexOf("if ($('seatDanger'))"), html.indexOf("var b = st.backup || {};"));
  assert.ok(seat.length > 0 && seat.length < 4000, 'the seat danger block found');
  // the one live destructive action is stop hosting, offered only when the
  // box's own ownership record says it hosts (tier rock)
  assert.match(seat, /var liveDanger = own\.tier === 'rock';/, 'live iff this mineral hosts');
  assert.match(seat, /\$\('seatDanger'\)\.style\.display = liveDanger \? '' : 'none';/, 'the card follows it');
  assert.match(seat, /closest\('details'\)/, 'the Advanced fold that holds only it is found');
  assert.match(seat, /fold\.style\.display = liveDanger \? '' : 'none';/, 'and follows the same switch');
  assert.match(seat, /<b>Stop hosting<\/b>/, 'the action that renders is stop hosting');
  assert.doesNotMatch(seat, /innerHTML = '<b>Delete/, 'no prose about a delete that cannot be done here');
});
