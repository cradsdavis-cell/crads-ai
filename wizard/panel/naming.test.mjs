// naming.test.mjs: one mineral, one name (docs/naming.md, 2026-08-14).
//
// An audit of both panels found the same rock called four things across five
// surfaces: "QA Run Two Gmail" in the sidebar, "Foreman" in the Overview hero,
// "qa-r2-gmail" in the target picker, "qa-r2-gmail-rock" in the connection
// line. Nothing threw. Each surface picked a different name slot and no
// document said which slot wins where.
//
// Names are the cheapest thing here to get wrong and the most expensive to
// notice, because a wrong name renders perfectly. These pins are the only thing
// that fails when a surface starts reading the wrong slot again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const cockpit = readFileSync(new URL('../../engine/cockpit/box-cockpit.mjs', import.meta.url), 'utf8');
const fixtures = readFileSync(new URL('../dev-harness/fixtures.mjs', import.meta.url), 'utf8');
const engine = readFileSync(new URL('../engine.mjs', import.meta.url), 'utf8');
const server = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');

test('the panel reads the wire field the box actually writes', () => {
  // box-cockpit.mjs has always emitted `pebble`; the panel read `client`, which
  // no live box has ever written. The subtitle was therefore blank on every
  // real mineral while looking correct in every screenshot, because the dev
  // fixtures emitted `client` too. A dead read is invisible: it renders.
  assert.match(cockpit, /^\s*pebble: IS_ORG$/m, 'the box writes `pebble`');
  assert.ok(!/\bd\.client\b|\bstate\.data\.client\b/.test(html),
    'no panel surface may read `client`: the box has never emitted that field');
  assert.match(html, /state\.data\.pebble/, 'the pebble hero subtitle reads `pebble`');
});

test('fixtures emit exactly the fields the box emits', () => {
  // A fixture carrying a field the box does not write is a second
  // implementation, and it hides the very bug it was written to catch.
  //
  // Assert the FIELD, never the demo name (2026-08-24). This pin used to read
  // /pebble: 'Priya Sharma'/, which tied a wire-field contract to whatever the
  // fictional member happened to be called. Renaming the fixture world (Acme /
  // Priya -> Driftwood / Mel), a change with no behavioural content at all,
  // therefore reddened CI on two branches and refused a promote. The contract
  // this test exists to defend is `pebble` vs the phantom `client`; the name is
  // set dressing and must never be able to fail a build.
  assert.ok(!/\bclient: '/.test(fixtures), 'no fixture may invent a `client` field');
  assert.match(fixtures, /pebble: '[^']+'/, 'fixtures carry the real field name');
});

test("a rock's assistant is called what the rock is called", () => {
  // ONE NAME. `persona` used to headline a rock's Overview, so a rock its owner
  // had named introduced itself as "Foreman", a build-time default nobody was
  // ever asked for, while the sidebar and the invite emails used the real name.
  const line = cockpit.slice(cockpit.indexOf('assistant: IS_ORG'), cockpit.indexOf('business: IS_ORG'));
  assert.match(line, /oget\('display_name'\)/, "a rock's assistant name IS its display name");
  assert.ok(line.indexOf("oget('display_name')") < line.indexOf("oget('persona')"),
    'display_name must win over persona, not the other way round');
});

test('no path asks a human for a persona, and none defaults to "Foreman"', () => {
  // The provisioning flow that carried PERSONA (runWizard + the org-policy
  // composer) was deleted with the org wizard (2026-09-01); what survives of
  // engine.mjs is key machinery, so the pin is that nothing persona-shaped
  // (least of all the "Foreman" default) creeps back in.
  assert.ok(!/'Foreman'/.test(engine), 'the literal default persona stays gone from the engine');
  assert.ok(!/PERSONA/.test(engine), 'no persona plumbing survives in the key machinery');
});

test('every sidebar write goes through the one cache the picker reads', () => {
  // The rock sidebar used to set textContent directly, skipping the per-host
  // cache the target picker falls back on. The org path died with the face
  // collapse (2026-09-01); what survives is the law: nothing writes the h1
  // except setBrainName, and every surface that learns the real name feeds it.
  const connect = html.slice(html.indexOf('function connect(quiet)'), html.indexOf('var wasOk'));
  assert.match(connect, /setBrainName\(\);/, 'connect() opens with the cached name (or skeleton), never a generic label');
  assert.match(html, /if \(state\.data\.assistant\) setBrainName\(state\.data\.assistant\);/,
    'the dashboard feeds the cache when the data lands');
  assert.match(html, /if \(nm\) setBrainName\(nm\);/, 'the seat feeds it: the sidebar says what the seat says');
  assert.match(html, /if \(rr && rr\.ok\) \{ setBrainName\(name\); loadDashboard\(true\); \}/,
    'a rename feeds it immediately, so no surface keeps the dead name');
  assert.match(html, /\(nameHint\(x\.host\) \|\| x\.org\)/, 'the picker falls back to the same cache, then the handle');
  // And the retired org write shape must not come back.
  assert.ok(!html.includes("$('brainName').textContent = String((("), 'nothing bypasses setBrainName');
});

test('an owning community is read by name, never by handle alone', () => {
  // An admin read "Acme CoLab" on their own rows while every one of their
  // members read "impact-colab" on theirs. The rock-name resolver died with
  // the org face, but the seat's Ownership row can still name a legacy owning
  // org, so the display name must still ride the wire and win over the handle.
  assert.match(server, /org:\{name:org\.org\|\|org\.name\|\|"",display:/,
    'the member console state ships the display name, not the handle alone');
  assert.match(html, /var orgName = String\(org\.display \|\| ''\)\.trim\(\) \|\| orgHandle;/,
    'the seat prefers the display name with the handle as last resort');
});

test('the rock-tie name plumbing is RETIRED (2026-09-01): community names ride the community list', () => {
  // rockName() read org_display out of the /rock-mine payload strengthSync
  // kept at connect. The directory tie read is gone; the map and the ladder
  // name communities from the mineral's own community-list instead.
  assert.ok(!html.includes('rockMineSt'), 'no kept tie payload');
  assert.ok(!html.includes('function rockName('), 'no rock-name resolver');
  // Communities retired 2026-09-09 (simple assistant): nothing names one.
  const sync = html.slice(html.indexOf('function strengthSync'), html.indexOf('// ---- the card library'));
  assert.ok(!sync.includes('community-list'), 'strengthSync reads no community list');
  assert.ok(!html.includes('c.org_display'), 'and the map names no community');
});

test("the Pebbles roster naming is RETIRED (2026-09-01): no mineral names another", () => {
  // pebbleLiveName/fleetNames resolved a member's own rename against the
  // admin's stamp-time label. The Pebbles page and the fleet died with the
  // org face, so the resolver chain stays gone on both sides of the wire.
  assert.ok(!html.includes('function pebbleLiveName('), 'the live-name resolver stays gone');
  assert.ok(!html.includes('function fleetNames('), 'and the fleet naming helper with it');
  assert.ok(!server.includes('rock-pebble-names?org='), 'the server no longer fetches live names from a directory');
});
