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

test('legacy rock aliases still land on THEIR box (#host=, one shell since 2026-09-01)', () => {
  // The org edition and its IS_ORG boot branch died with the face collapse:
  // /go/panel and /go/member both open the one member.html. What survives is
  // the property this file exists for, on the one boot path there is: the
  // asked-for identity is honoured whichever hash convention carried it, and
  // an unknown host falls back to a real target rather than an empty page.
  const html = read('member.html');
  assert.equal(html.includes('IS_ORG'), false, 'no org boot branch remains to drift');
  // (?:&|$) since 2026-09-02: the hash may be compound (#host=...&sec=terminal),
  // the door's finish checklist naming a tab alongside the identity.
  assert.match(html, /askedHost = \(location\.hash\.match\(\/\^#host=\(\[A-Za-z0-9\._-\]\+\)\(\?:&\|\$\)\/\) \|\| \[\]\)\[1\] \|\| askedHost;/,
    'a legacy -rock/-parent alias rides #host= and wins over the #box= derivation');
  assert.match(html, /state\.host = state\.targets\.some\(function\(x\)\{ return x\.host === askedHost; \}\) \? askedHost : state\.targets\[0\]\.host;/,
    'an unknown host must fall back to a real target');
});

test('the app answers the door about the mineral that was ASKED for (2026-08-18, one server since 2026-09-01)', () => {
  // Harriet's 404. The door drew a rock and the old starter refused it because
  // it asked only "does this machine hold ANY rock". The face collapse removed
  // the face question entirely: both starters bring up the SAME panel server,
  // so what remains to pin is that each starter still checks the identity that
  // was CLICKED exists on this machine, and says no honestly when it does not.
  const app = readFileSync(join(HERE, '..', 'app.mjs'), 'utf8');
  const start = app.match(/start: \{[\s\S]*?\n    \},/);
  assert.ok(start, 'the door still gets its lazy-start hooks');
  assert.match(start[0], /panel: \(want\)/, 'the panel starter takes the asked-for identity');
  assert.match(start[0], /member: \(want\)/, 'so does the pebble starter');
  assert.match(start[0], /targets\.some\(\(t\) => t\.host === host\)/,
    'the rock starter checks the host that was clicked, not every box on the machine');
  assert.match(start[0], /t\.org === slug \|\| t\.host === `\$\{slug\}-box`/,
    'the pebble starter matches the clicked slug either way it is recorded');
  assert.equal((start[0].match(/if \(!has\) return false;/g) || []).length, 2,
    'a missing identity is an honest refusal on both starters, never an empty panel');
  assert.equal((start[0].match(/startPanel\(\);/g) || []).length, 2,
    'and both land on the ONE panel server');
});

test('the on-demand face probe survives on the door tier display (probeFaces)', () => {
  // The starters no longer probe (there is no face to pick), but the door
  // still asks a -box alias whether it is a rock so its tier chip and click
  // routing tell the truth. Same probe, same bounded timeout, same registry,
  // same fail-open as before the collapse.
  const app = readFileSync(join(HERE, '..', 'app.mjs'), 'utf8');
  const probe = app.match(/probeFaces: async \(aliases = \[\]\) => \{[\s\S]*?\n    \},/);
  assert.ok(probe, 'the door still gets its tier-honesty probe');
  assert.match(probe[0], /probePromotedHosts\(/, 'it asks the box itself');
  assert.match(probe[0], /hardTimeoutMs: \d+/, 'bounded: a wedged box must not hold the render open');
  assert.match(probe[0], /registerPromotedHost\(/, 'and caches the answer for the next click');
  assert.match(probe[0], /if \(!promoted\.length\) return;/, 'an unanswered probe changes nothing (fail-open)');
});
