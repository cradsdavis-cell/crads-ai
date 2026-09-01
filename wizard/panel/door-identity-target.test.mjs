// door-identity-target.test.mjs — the identity you pick on the door is the box
// you land on. Run: node --test wizard/panel/door-identity-target.test.mjs
//
// Why this file exists. The door's identity cards navigated to a BARE
// '/go/panel' or '/go/member', remembering the chosen host only in
// localStorage, which neither surface reads. Both surfaces then opened
// targets[0]. With two member boxes on one machine — the ordinary shape once a
// person belongs to two communities — picking the second one opened the FIRST
// and presented its pages, name and dashboard as if they were yours. Same for a
// second rock. Proven live on 2026-08-04: picking
// "promo-lab · your assistant" landed on cert-pebble-box.
//
// member.html has honoured '#box=<slug>' since 2026-08-04 (the ready email's
// deep link); the door simply never sent it, and panel.html had no equivalent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(HERE, f), 'utf8');

test('the door sends the chosen identity through to the surface', () => {
  const nav = read('door.html').match(/b\.onclick = function\(\)\{[\s\S]{0,400}?\};/);
  assert.ok(nav, 'the identity card click handler must still exist');
  assert.match(nav[0], /go\/panel/);
  assert.match(nav[0], /go\/member/);
  assert.match(nav[0], /#box=|#host=/, 'the chosen identity must ride the URL, not only localStorage');
  assert.match(nav[0], /encodeURIComponent/, 'the identity must be encoded into the URL');
});

test('the panel honours the asked-for rock and falls back safely', () => {
  const html = read('member.html');
  assert.match(html, /location\.hash\.match\(\/\^#host=/, 'panel must read #host=');
  // the fallback must survive an unknown host: never leave state.host empty
  const pick = html.match(/askedHost[\s\S]{0,300}?state\.host = [^\n]*\n/);
  assert.ok(pick, 'panel must choose its target from the asked host');
  assert.match(pick[0], /state\.targets\.some/, 'an unknown host must fall back to a real target');
});

test('the member surface still honours #box= (the contract the door now uses)', () => {
  assert.match(read('member.html'), /location\.hash\.match\(\/\^#box=/);
});

test('the org landing honours the asked-for rock too (#host=, console retired P3)', () => {
  // /go/panel lands on the one shell now. The org boot must pick the asked
  // host — without this, a second rock's door click landed on the FIRST
  // rock's destructive verbs (the exact bug the console once fixed).
  const html = read('member.html');
  assert.match(html, /location\.hash\.match\(\/\^#host=/, 'the org boot reads #host=');
  const pick = html.match(/if \(IS_ORG\) askedHost = [^\n]*\n/);
  assert.ok(pick, 'the org branch chooses its target from the asked host');
  assert.match(html, /state\.targets\.some\(function\(x\)\{ return x\.host === askedHost; \}\)/,
    'an unknown host must fall back to a real target');
});

test('the app answers the door about the mineral that was ASKED for (2026-08-18)', () => {
  // Harriet's 404. The door drew a rock (account tier) and this starter refused it
  // (local alias), because it asked only "does this machine hold ANY rock". A
  // rock made or promoted in this session keeps its <slug>-box alias until the
  // face probe caches its answer, and only app launch ran that probe -- so the
  // first click after provisioning dead-ended until a relaunch.
  const app = readFileSync(join(HERE, '..', 'app.mjs'), 'utf8');
  const start = app.match(/start: \{[\s\S]*?\n    \},/);
  assert.ok(start, 'the door still gets its lazy-start hooks');
  assert.match(start[0], /panel: async \(want\)/, 'the panel starter takes the asked-for identity');
  assert.match(start[0], /member: \(want\)/, 'so does the pebble starter');
  assert.match(start[0], /t\.host === \(want && want\.host\)/,
    'the on-demand probe is scoped to the host that was clicked, not every box on the machine');
  assert.match(start[0], /probePromotedHosts\(/,
    'no local rock face means ASK the box, rather than 404 until the next relaunch');
  assert.match(start[0], /registerPromotedHost\(/, 'and cache what it says, so the next click is instant');
  assert.match(start[0], /hardTimeoutMs: \d+/,
    'the probe is bounded: a wedged box must not hold the click open for the ssh default');
  // Fail-open, in the same direction as the launch probe: no answer leaves the
  // alias guess standing and the honest 404 with it. A starter that returned
  // truthy here would bring up an empty panel with nothing behind it.
  assert.match(start[0], /if \(!promoted\.length\) return false;/, 'an unanswered probe stays an honest refusal');
});
