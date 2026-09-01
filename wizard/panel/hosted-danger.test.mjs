// The Danger zone renders NOTHING unless a destructive action is live and
// unlocked for this rock (R19c, panel iteration 2, 2026-08-23).
//
// History: the zone was written around the self-provisioned flow and on a
// hosted rock (provisioned:false, every door-born rock) rendered three blocks
// of warning about an action it did not offer; 2026-08-10 cut that to one
// "not self-serve" line. R19c goes the rest of the way: a hosted rock, or a
// rock that still has members, shows no heading, no hint, no locked box. The
// zone appears only with the retire card (promoted host) or the delete form
// (self-provisioned, no members left). These pin that rule structurally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

test('the whole zone, heading included, sits inside one wrapper that is hidden by default', () => {
  const zone = html.slice(html.indexOf('<div id="dangerZone" style="display:none">'), html.indexOf('<section data-sec="publish"'));
  assert.ok(zone.length > 0, 'the wrapper exists');
  assert.match(zone, /<h3 class="subhead zonegap">Danger<\/h3>/, 'the heading is inside it');
  assert.match(zone, /id="retireWrap"/, 'so is the retire card');
  assert.match(zone, /<div id="deleteWrap" style="display:none">[\s\S]*<h3 class="subhead">Delete this rock<\/h3>/, 'and the delete subsection, itself hidden by default');
  assert.match(zone, /id="odCard" style="display:none"/, 'and the delete form');
  assert.ok(!html.includes('id="odLocked"'), 'no locked box: a locked zone renders nothing');
  assert.ok(!html.includes('dangerArmNote'), 'no per-line hide toggles left over from the 2026-08-10 shape');
});

test('syncDanger is the one switch: zone visible iff the retire card or the delete form is on screen', () => {
  const fn = html.slice(html.indexOf('function syncDanger()'), html.indexOf('\n  }', html.indexOf('function syncDanger()')));
  assert.match(fn, /var retire = \$\('retireWrap'\) && \$\('retireWrap'\)\.style\.display !== 'none';/);
  assert.match(fn, /var del = \$\('odCard'\) && \$\('odCard'\)\.style\.display !== 'none';/);
  assert.match(fn, /\$\('deleteWrap'\)\.style\.display = del \? '' : 'none'/, 'the delete subsection follows the form');
  assert.match(fn, /\$\('dangerZone'\)\.style\.display = \(retire \|\| del\) \? '' : 'none'/, 'the zone follows either');
  // both writers call it, so neither path can leave the zone stale
  const rod = html.slice(html.indexOf('function renderOrgDelete()'), html.indexOf('function syncDanger()'));
  assert.match(rod, /syncDanger\(\);/, 'renderOrgDelete syncs');
  const sr = html.slice(html.indexOf('function syncRetire()'), html.indexOf('\n  }', html.indexOf('function syncRetire()')));
  assert.match(sr, /syncDanger\(\);/, 'syncRetire syncs');
});

test('renderOrgDelete shows the form only when self-provisioned AND no member remains, and says nothing otherwise', () => {
  const rod = html.slice(html.indexOf('function renderOrgDelete()'), html.indexOf('function syncDanger()'));
  assert.match(rod, /var hosted = tgt\.provisioned === false;/, 'the hosted case is read from the /targets flag');
  assert.match(rod, /var unlocked = !hosted && !live\.length;/, 'the unlock rule');
  assert.match(rod, /\$\('odCard'\)\.style\.display = unlocked \? '' : 'none';/, 'the form follows it');
  assert.doesNotMatch(rod, /innerHTML = '<b>(Locked|Not self-serve)/, 'no locked / not-self-serve message: nothing renders');
  assert.doesNotMatch(rod, /Not self-serve/, 'the hosted line is gone from the rock zone (the seat page mirror on Your pebble is a different surface)');
});

// The seat-page mirror (Your pebble) follows the same R19c rule since panel
// iteration 2 (2026-08-23): nothing renders unless a destructive action is
// live and unlocked for this mineral, and none is today. The "Not self-serve
// yet" paragraph, which described an action that did not exist, is gone.
test('the seat Danger mirror renders nothing when nothing is live, and "Not self-serve yet" is gone', () => {
  const seat = html.slice(html.indexOf("if ($('seatDanger'))"), html.indexOf("var b = st.backup || {};"));
  assert.ok(seat.length > 0 && seat.length < 2000, 'the seat danger block found');
  assert.match(seat, /var liveDanger = false;/, 'no live destructive action on a pebble today');
  assert.match(seat, /\$\('seatDanger'\)\.style\.display = liveDanger \? '' : 'none';/, 'the card follows it');
  assert.match(seat, /closest\('details'\)[\s\S]{0,80}liveDanger \? '' : 'none'/, 'and so does the Advanced fold that holds only it');
  assert.doesNotMatch(seat, /innerHTML = '<b>Delete/, 'no prose about a delete that cannot be done here');
  assert.doesNotMatch(html.replace(/^\s*\/\/.*$/gm, ''), /Not self-serve/, 'the line is gone from the page, comments aside');
});
