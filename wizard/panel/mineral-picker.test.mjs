// mineral-picker.test.mjs — the inventory's SECOND mount (spec
// docs/superpowers/specs/2026-08-13-mineral-inventory.md, rulings 6 + 8).
//
// The door renders the inventory as the app's start screen. This renders the
// same rows, from the same handler, as the switcher inside the dashboard, so a
// person in one mineral can move to another without going back out. The merge
// rules are pinned in inventory.test.mjs and the shared mount in door.test.mjs;
// this file pins that member.html actually consumes them, and consumes them
// without growing a second router.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const M = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
// comments stripped for negative assertions: a comment explaining why something
// was NOT done is not the thing being done.
const LIVE = M.replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');
// The picker's own code. Negative assertions are scoped HERE, not to the whole
// page: member.html legitimately calls /account/devices for its not-let-in
// state (pinned by not-let-in.test.mjs) and probes elsewhere. "The picker did
// not grow its own copy" is the claim; "the page never does this" would be
// false and would fail for the wrong reason.
// Sliced from the RAW source and stripped after: the end anchor is itself a
// comment, so slicing the stripped text found no end and silently ran to EOF --
// which quietly turned every negative assertion below into a whole-page one.
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');
const PICKER = strip(M.slice(M.indexOf('var picker = {'), M.indexOf("fetch('/targets')")));

test('the picker exists on the name, and #brainName stays the element every setter writes', () => {
  assert.match(M, /id="pickBtn"/, 'the name is the switcher');
  assert.match(M, /id="pickMenu"/, 'and it has a menu');
  // setBrainName, the org path (2835) and the seat path (9577) all write to
  // #brainName. Moving it from the h1 to a span inside a button must not break
  // them -- a button may not contain flow content, so the h1 had to stay outside.
  assert.match(M, /<span id="brainName" aria-busy="true">/, '#brainName survives as the write target');
  assert.match(M, /<h1>\s*<button class="pickbtn solo" id="pickBtn"/, 'the button is INSIDE the h1, never the reverse');
});

test('RULING 8: the picker reads the SAME two routes the door does', () => {
  assert.match(M, /fetch\(full \? '\/inventory\/full' : '\/inventory'\)/,
    'one call site, both stages, same endpoints as the start screen');
  // and it must not have grown its own account read
  assert.ok(PICKER.length > 500, 'the picker block was found');
  assert.doesNotMatch(PICKER, /my-minerals/, 'the picker never talks to the directory itself');
  assert.doesNotMatch(PICKER, /account\/devices/, 'nor re-implements the enrol list');
});

test('RULING 4: the picker is populated from disk first, and the network read is lazy', () => {
  // /inventory touches no network, so the switcher works offline; /inventory/full
  // is only fetched when the menu is actually opened.
  assert.match(M, /pickerLoad\(false\);/, 'the local read runs at boot');
  assert.match(M, /if \(open && !picker\.full\) pickerLoad\(true\);/,
    'the account read waits until the menu is opened');
});

test('switching routes through the DOOR, rather than growing a second router', () => {
  // /go/panel and /go/member already carry the lazy-start (a surface can be down
  // with a legitimate identity behind it, 2026-08-03) and the identity-rides-the-
  // URL fix (2026-08-04). A second router here would re-earn both bugs.
  // BOTH readers, since 2026-08-18. The fragment is for the destination surface
  // (which mineral to show); the query is for the door server (which mineral to
  // bring UP). The server never sees a fragment, so with the fragment alone its
  // lazy-start could only ask "is there any rock at all on this machine" -- and
  // answered no for a rock still wearing its <slug>-box alias, 404ing the very
  // row the door had just drawn as a rock. Dropping either half re-earns it.
  assert.match(M, /'\/go\/panel\?host=' \+ id \+ '#host=' \+ id/,
    'a rock rides host= in the query AND the fragment; its alias cannot be derived from its slug');
  assert.match(M, /'\/go\/member\?box=' \+ id \+ '#box=' \+ id/,
    'a pebble rides box= in the query AND the fragment');
  assert.match(M, /var id = encodeURIComponent\(r\.tier === 'rock' \? r\.alias : r\.slug\)/,
    'the identity is still encoded into the URL');
  assert.doesNotMatch(PICKER, /\/probe/, 'the picker does not re-probe: the surfaces do that');
});

test('a machine with ONE mineral gets no switcher at all', () => {
  // A caret over a menu with a single row promises a choice that does not exist.
  assert.match(M, /var switchable = picker\.rows\.length > 1 && !!picker\.base;/,
    'more than one mineral AND a door to route through');
  assert.match(M, /\.pickbtn\.solo\{pointer-events:none\}/, 'solo stops being a control');
  assert.match(M, /\.pickbtn\.solo \.caret\{display:none\}/, 'and stops advertising one');
});

test('with no door URL the name stays a name', () => {
  // Without the router every row would dead-end, which is worse than no menu.
  assert.match(M, /if \(!picker\.base\) \{ btn\.className = 'pickbtn solo'; return; \}/,
    'no router, no switcher');
});

test('an off-device mineral is listed but never pressable', () => {
  // Switching to a mineral this computer cannot open would land on nothing. The
  // connect flow lives on the start screen and stays there.
  const render = M.slice(M.indexOf('function pickerRender()'), M.indexOf('function pickerLoad('));
  assert.match(render, /if \(r\.onDevice\) \{[\s\S]{0,120}data-go=/, 'only on-device rows carry the go hook');
  assert.match(render, /class="pickrow off"[\s\S]{0,80}aria-disabled="true"/, 'elsewhere rows are disabled');
  assert.doesNotMatch(render.slice(render.indexOf('pickrow off')), /data-go/,
    'and carry no navigation target at all');
  assert.match(render, /Connect them from the start screen/, 'the note says where that flow lives');
});

test('the picker footer no longer deep-links create flows (self-host strip, 2026-09-01)', () => {
  // The hosted creator flows are gone: users self-provision with the local
  // wizard, so a footer link into a removed flow would be finding 9's dangling
  // pointer pointed the other way.
  assert.doesNotMatch(M, /#new=pebble/, 'no new-pebble deep link');
  assert.doesNotMatch(M, /#new=rock/, 'no new-rock deep link');
  const door = readFileSync(new URL('./door.html', import.meta.url), 'utf8');
  assert.ok(!/#new=\(pebble\|rock\)/.test(door), 'the door no longer parses the creator hash');
});

test('the current mineral is marked, and it is marked AFTER state.host is known', () => {
  // pickerLoad's first render can finish before the boot handler picks the host,
  // so a single render would leave nothing marked on a fast local read.
  assert.match(M, /r\.onDevice && r\.alias === state\.host/, 'current = this alias, on this machine');
  assert.match(M, /aria-current="true"/, 'exposed to assistive tech, not just colour');
  const boot = M.slice(M.indexOf('state.host = state.targets.some'), M.indexOf('sel.value = state.host;'));
  assert.match(boot, /pickerRender\(\);/, 're-rendered once the host is actually known');
});

test('the menu closes the ways a menu is expected to close', () => {
  assert.match(M, /e\.key === 'Escape'/, 'escape closes it');
  assert.match(M, /!menu\.contains\(e\.target\) && !btn\.contains\(e\.target\)/, 'an outside click closes it');
  assert.match(M, /btn\.setAttribute\('aria-expanded'/, 'and the button reports its state');
});
