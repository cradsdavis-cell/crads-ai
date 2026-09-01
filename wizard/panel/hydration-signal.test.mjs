// hydration-signal.test.mjs - the panel says when its data has landed.
//   node --test wizard/panel/hydration-signal.test.mjs
//
// Before 2026-08-17 the dashboard's skeletons shimmered identically whether
// the boot data legs were in flight or quietly dead, so every harness driver
// slept a fixed number of seconds and hoped. The page now settles each leg
// once (landed or definitively failed), flips <body data-hydrated> 0 to 1,
// fires panel:hydrated, and turns a timed-out skeleton grid into a visible
// waiting sentence. These are structural pins: each one is a hook a driver or
// a member depends on, and each would fail QUIETLY if refactored away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

test('the body ships the marker unhydrated, so a driver can tell "no signal yet" from "no signal ever"', () => {
  assert.ok(html.includes('<body data-hydrated="0">'),
    'body must carry data-hydrated="0" in the markup; the door has no marker and drivers key on that difference');
});

test('every expected leg is registered up front, per face', () => {
  assert.match(html, /if \(IS_ORG\) \{ hydExpect\('stall-board'\); hydExpect\('rock-state'\); \}/,
    'org face owes stall-board and rock-state before it may call itself hydrated');
  assert.match(html, /hydExpect\('dashboard'\);/, 'both faces owe dashboard-data');
});

test('each boot leg settles exactly its own name, on answer and on transport failure', () => {
  for (const leg of ['dashboard', 'stall-board', 'rock-state']) {
    assert.match(html, new RegExp(`hydSettle\\('${leg}', !!r\\.ok\\);`), `${leg} settles on answer`);
    assert.match(html, new RegExp(`hydSettle\\('${leg}', false\\);`), `${leg} settles on a rejected fetch`);
  }
});

test('the first settle wins: a late catch cannot flip a leg that already landed', () => {
  assert.match(html, /if \(\(leg in hyd\.legs\) && hyd\.legs\[leg\] !== 'pending'\) return;/,
    'hydSettle must be idempotent or the rethrow in the catch handlers double-settles');
});

test('finishing flips the attribute to 1 and fires panel:hydrated with the legs', () => {
  assert.match(html, /document\.body\.setAttribute\('data-hydrated', '1'\);/);
  assert.match(html, /new CustomEvent\('panel:hydrated', \{ detail: \{ legs: hyd\.legs \} \}\)/);
});

test('a timed-out or failed leg turns lingering skeletons into a visible waiting state', () => {
  // the guard is the load-bearing part: real data that already rendered must
  // never be replaced by the waiting sentence
  assert.match(html, /grid && grid\.querySelector\('\.skel'\)/,
    'hydWaitingState only ever replaces skeletons, never rendered cards');
  assert.ok(html.includes('Still waiting on the mineral.'),
    'the waiting state is a sentence a member can read, not more shimmer');
  assert.match(html, /if \(stuck\) hydWaitingState\(\);/, 'the timeout path draws it');
  assert.match(html, /if \(bad\) hydWaitingState\(\);/, 'and so does a definitively failed leg');
});

