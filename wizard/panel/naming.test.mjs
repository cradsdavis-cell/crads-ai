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
  assert.ok(!/'Foreman'/.test(engine), 'the literal default persona is gone from the engine');
  assert.match(engine, /PERSONA: String\(pol\['org\.display_name'\] \|\| name\)/,
    'PERSONA is a derived mirror of the display name');
  assert.match(engine, /displayName: ORG_DISPLAY_NAME/,
    'the CLI path must be able to produce a display name that differs from the slug');
});

test('the rock sidebar writes its name through the one cache the picker reads', () => {
  // The sidebar used to set textContent directly, skipping the per-host cache
  // the target picker falls back on. Same rock, same control, reading
  // "Foreman (x-rock)" on a laptop that had opened it and "x (x-rock)" on one
  // that had not, and flipping back when the 24h TTL expired.
  assert.ok(!/\$\('brainName'\)\.textContent = String\(\(\(orgx/.test(html),
    'the rock name must not bypass setBrainName');
  const connect = html.slice(html.indexOf('function connect(quiet)'), html.indexOf('var wasOk'));
  assert.match(connect, /setBrainName\(rockName\)/, 'connect() caches the display name');
  assert.match(connect, /nameHint\(state\.host\) \|\| orgT\.org/,
    'the pre-governance fallback shows the handle without caching it');
  const rid = html.slice(html.indexOf('function renderRockIdentity()'), html.indexOf('function renderRockIdentity()') + 1200);
  assert.match(rid, /if \(display\) setBrainName\(display\)/,
    'governance is where the real name first lands, so it must feed the cache');
});

test('a pebble reads its rock by name, never by handle', () => {
  // An admin read "Acme CoLab" on their own rows while every one of their
  // members read "impact-colab" on theirs: the same rock, named two ways by the
  // two people most likely to talk to each other about it.
  assert.match(server, /org:\{name:org\.org\|\|org\.name\|\|"",display:/,
    'the member console state must ship the rock display name, not the handle alone');
  assert.match(html, /function rockName\(handle, staged\)/, 'the pebble face resolves a rock name');
  assert.match(html, /var orgName = rockName\(orgHandle, org\.display\) \|\| orgHandle/,
    'Ownership and Anchor rows read the resolved name with the handle as last resort');
});

test('the rock name is resolvable from connect, not only from the Rocks page', () => {
  // strengthSync already fetches /rock-mine at connect and used to keep only the
  // counts. rockName() reads org_display out of that same payload, so throwing
  // it away meant Your pebble showed the raw handle until the member happened to
  // open the Rocks page: a fix that worked on the one screen nobody was on.
  const sync = html.slice(html.indexOf('function strengthSync'), html.indexOf('// ---- the card library'));
  assert.match(sync, /rockMineSt = j;/, 'connect keeps the tie payload it already fetched');
});

test("a rock's Pebbles row leads with the name the mineral calls itself", () => {
  // The registry row carries the name the ADMIN typed at stamp time, and nothing
  // ever carried a member's own rename back: box-rename writes the box and
  // stops, org-sync is strictly rock to box. So the row could sit on a name its
  // owner replaced weeks ago while every other surface agreed on the new one.
  assert.match(html, /function pebbleLiveName\(m\)/, 'the panel resolves the live name');
  // run-6 (79695ca) folded the row's fcLive/fcPerson locals into a fleetNames()
  // helper. Pin the helper's CONTRACT (live leads, person falls back, both
  // exposed as fields), not its callers' variable names, so the next rename
  // cannot rot this while the behaviour stands.
  const names = html.slice(html.indexOf('function fleetNames('), html.indexOf('function armingSteps('));
  assert.match(names, /pebbleLiveName\(m\)/, 'the fleet naming asks for the live name');
  assert.match(names, /heading: live \|\| person \|\| 'Unnamed pebble'/,
    'the mineral name leads, admin label is the fallback');
  // R27 (panel iteration 2): the subtitle segments are HTML now (the slug and
  // host render in mono), so the person is pushed through esc().
  assert.match(html, /if \(\w+\.person && \w+\.person !== \w+\.heading\) \w+\.push\(esc\(\w+\.person\)\)/,
    'the person becomes the subtitle, and is not repeated when the two agree');
  assert.match(server, /rock-pebble-names\?org=\$ORGN/, 'console-state fetches the live names');
  assert.match(server, /pebbleNames,value,platform/, 'and ships them on the state line');
});
