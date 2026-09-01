// door.test.mjs: the D47 front door.
//   node --test wizard/panel/door.test.mjs
import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDoorServer } from './door-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const IDS = [{ host: 'acme-rock', org: 'acme', kind: 'rock' }, { host: 'jane01-box', org: 'jane01', kind: 'member' }];
const listen = (opts) => new Promise((resolve) => {
  const s = createDoorServer({ port: 0, host: '127.0.0.1', htmlText: '<html>door</html>',
    bridge: { targets: () => IDS }, ...opts });
  s.on('listening', () => resolve(s));
});

test('door: identities, surface flags, go-redirects, probe validation', async () => {
  let panelUrl = '';
  const s = await listen({
    urls: { panel: () => panelUrl, wizard: () => 'http://127.0.0.1:9/', member: () => '', connect: () => '' },
    probe: (host) => Promise.resolve({ code: host === 'acme-rock' ? 0 : 255, stdout: 'login=aios-op\n', stderr: '' }),
  });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const d = await fetch(`${base}/identities`).then((r) => r.json());
    assert.equal(d.identities.length, 2);
    assert.deepEqual(d.open, { panel: false, member: false, wizard: true, connect: false });
    assert.equal((await fetch(`${base}/go/panel`, { redirect: 'manual' })).status, 404);
    panelUrl = 'http://127.0.0.1:8/';
    const go = await fetch(`${base}/go/panel`, { redirect: 'manual' });
    assert.equal(go.status, 302);
    assert.equal(go.headers.get('location'), panelUrl);
    const ok = await fetch(`${base}/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'acme-rock' }) }).then((r) => r.json());
    assert.deepEqual(ok, { ok: true, login: 'aios-op' });
    const down = await fetch(`${base}/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'jane01-box' }) }).then((r) => r.json());
    assert.equal(down.ok, false);
    assert.equal((await fetch(`${base}/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'evil-rock' }) })).status, 400);
    assert.match(await fetch(`${base}/`).then((r) => r.text()), /door/);
  } finally { s.close(); }
});

test('door: /forget removes only installed identities, via the injected remover', async () => {
  const calls = [];
  const s = await listen({ forget: (host) => { calls.push(host); return { configUpdated: true, keysRemoved: 2 }; } });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const ok = await fetch(`${base}/forget`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'acme-rock' }) }).then((r) => r.json());
    assert.equal(ok.ok, true);
    assert.equal(ok.keysRemoved, 2);
    assert.deepEqual(calls, ['acme-rock']);
    assert.equal((await fetch(`${base}/forget`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'evil-rock' }) })).status, 400, 'uninstalled identity refused');
    assert.deepEqual(calls, ['acme-rock'], 'remover never called for the refused host');
  } finally { s.close(); }
});

test('door: update routes echo the updater, nudge refresh, gate apply (2026-07-23 staleness fix)', async () => {
  let refreshed = 0;
  let applied = 0;
  const updater = {
    status: { available: false, current: { sha: 'aaa' } },
    refresh: () => { refreshed++; },
    apply: () => { applied++; return Promise.resolve({}); },
  };
  const s = await listen({ updater });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const off = await fetch(`${base}/update-status`).then((r) => r.json());
    assert.equal(off.available, false);
    assert.equal(refreshed, 1, 'each status poll must nudge a re-check');
    assert.equal((await fetch(`${base}/update-apply`, { method: 'POST' })).status, 400, 'apply gated while unavailable');
    updater.status = { available: true, current: { sha: 'aaa' }, latest: { sha: 'bbb' } };
    const on = await fetch(`${base}/update-status`).then((r) => r.json());
    assert.equal(on.available, true);
    assert.equal(refreshed, 2);
    assert.equal((await fetch(`${base}/update-apply`, { method: 'POST' })).status, 200);
    assert.equal(applied, 1);
  } finally { s.close(); }
});

test('creator door: fresh install takes over; the creator cards are gone (self-host strip, 2026-09-01)', () => {
  const html = readFileSync(new URL('./door.html', import.meta.url), 'utf8');
  assert.match(html, /id="creatorHome"/, 'takeover home exists');
  assert.match(html, /What are we making\?/, 'home heading');
  // The pebble/rock creator doors left with the self-host strip: users
  // self-provision with the local wizard, and a rock can never create a pebble.
  assert.doesNotMatch(html, /data-make="pebble"/, 'no pebble creator card');
  assert.doesNotMatch(html, /data-make="rock"/, 'no rock creator card');
  // The hosted-era cards left in the same pass's second wave (Sam, 2026-09-01):
  // nobody can be invited TO a box, and the community board was a central read.
  assert.doesNotMatch(html, /data-make="invite"/, 'no invitation card');
  assert.doesNotMatch(html, /data-make="join"/, 'no join card');
  assert.match(html, /data-make="selfhost"[\s\S]*?Set up my own/, 'the self-host door leads');
  assert.match(html, /data-make="have"[\s\S]*?I already have one/, 'existing-holder card survives');
  // A standalone pebble has no rock, so the door must not assert one over an
  // unreachable box. It said "waiting for your rock" on Sam's own two solo
  // boxes (QA 2026-07-30). The door only knows the box did not answer.
  assert.ok(!/'waiting for your rock'/.test(html), 'no org-flow status asserted over every unreachable box');
  assert.match(html, /st \? 'Connected' : 'Not answering yet'/, 'unreachable reads as not answering');
  assert.match(html, /If it belongs to a rock, it stays this way until an Admin approves your key/, 'admin approval offered as a possible reason, not the explanation');
  assert.match(html, /var fresh = !state\.rows\.length;/, 'render computes the fresh-install state');
  assert.match(html, /creatorHome'\)\.style\.display = fresh \? '' : 'none'/, 'render toggles the takeover on that state');
});

test('door: D1 -- a rejecting probe answers normally for that identity, and the process survives to serve the next request', async () => {
  const s = await listen({ probe: () => Promise.reject(new Error('ssh broke')) });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const r = await fetch(`${base}/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'acme-rock' }) });
    assert.equal(r.status, 200, 'a rejecting probe still gets a normal HTTP response, not a hang or a reset');
    const body = await r.json();
    assert.deepEqual(body, { ok: false, login: '' }, 'reads as plain not-reachable for this identity');
    // Prove the process is still alive: this is the important assertion. If D1
    // were unfixed, the probe rejection would have been an unhandled promise
    // rejection and killed this whole Node process -- and this whole test file
    // with it -- before this line ever ran.
    const d = await fetch(`${base}/identities`).then((r2) => r2.json());
    assert.equal(d.identities.length, 2, 'the server is still up and answering a second, unrelated request');
  } finally { s.close(); }
});

test('door: D1 -- probe resolving with a missing/non-string stdout (unexpected shape) is treated as empty, not a crash', async () => {
  const s = await listen({ probe: () => Promise.resolve({ code: 0 }) });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const body = await fetch(`${base}/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'acme-rock' }) }).then((r) => r.json());
    assert.deepEqual(body, { ok: true, login: '' });
  } finally { s.close(); }
});

test('door: D2 -- a rejecting forget answers 500 for that request, and the process survives to serve the next request', async () => {
  const s = await listen({ forget: () => Promise.reject(new Error('ssh broke')) });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const r = await fetch(`${base}/forget`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'acme-rock' }) });
    assert.equal(r.status, 500, 'a rejected forget answers 500 for this request, not a hang');
    // Same proof as the D1 test above: a rejection inside the request handler
    // that was never awaited would have escaped as an unhandled promise
    // rejection and killed the process before this second request could land.
    const d = await fetch(`${base}/identities`).then((r2) => r2.json());
    assert.equal(d.identities.length, 2, 'the server is still up and answering a second, unrelated request');
  } finally { s.close(); }
});

test('door: D3 -- an oversized POST body on any of the door routes gets a clean 413, not a connection reset', async () => {
  const s = await listen();
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const bigBody = JSON.stringify({ host: 'x'.repeat(11000) });
    for (const path of ['/probe', '/forget']) {
      const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bigBody });
      assert.equal(r.status, 413, `${path} answers 413 for a body over the 10KB limit`);
      const text = await r.text();
      assert.match(text, /too large/i, `${path} 413 body is short and plain-words`);
    }
    // The limit itself is unchanged: a normal-sized request on the same server
    // still works fine afterwards.
    const d = await fetch(`${base}/identities`).then((r) => r.json());
    assert.equal(d.identities.length, 2);
  } finally { s.close(); }
});

test('door.html: D4 -- the takeover latch flags exist and render() respects them', () => {
  const html = readFileSync(new URL('./door.html', import.meta.url), 'utf8');
  assert.match(html, /var pebbleDoneHold = false;/, 'module-scope hold flag declared, defaulting off');
  assert.match(html, /var pebbleFlowActive = false;/, 'the takeover latch declared, defaulting off');
  const renderFn = html.slice(html.indexOf('function render()'), html.indexOf('function startJoinFlow'));
  assert.match(renderFn, /if \(!pebbleFlowActive && !pebbleDoneHold\)\s*\{/, 'render() gates the takeover-visibility lines on both flags');
  assert.match(renderFn, /var fresh = !state\.rows\.length;/, 'render still computes the fresh-install state');
});

test('door: /go/<name> lazily starts a stopped surface and redirects once it is up (2026-08-03 new-pebble 404)', async () => {
  // The bug: a pebble stamped or claimed mid-session never started the member
  // dashboard (onStampSuccess only handles rocks), so the door listed the new
  // box but clicking it hit /go/member -> 404 "that surface is not running"
  // until the app was reopened. The door now asks the app to start the surface
  // and redirects when its URL appears.
  let memberUrl = '';
  let startCalls = 0;
  const s = await listen({
    urls: { member: () => memberUrl },
    start: { member: () => { startCalls++; setTimeout(() => { memberUrl = 'http://127.0.0.1:7/'; }, 50); } },
  });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const go = await fetch(`${base}/go/member`, { redirect: 'manual' });
    assert.equal(go.status, 302, 'the request waits for the lazy start instead of 404ing');
    assert.equal(go.headers.get('location'), 'http://127.0.0.1:7/');
    assert.equal(startCalls, 1);
    // Once the surface is up, /go/ answers from the URL directly, no second start.
    const again = await fetch(`${base}/go/member`, { redirect: 'manual' });
    assert.equal(again.status, 302);
    assert.equal(startCalls, 1, 'a running surface is never started again');
  } finally { s.close(); }
});

test('door: /go/<name> starter returning false (no identity behind the surface) keeps the honest 404', async () => {
  let startCalls = 0;
  const s = await listen({
    urls: { member: () => '' },
    start: { member: () => { startCalls++; return false; } },
  });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const go = await fetch(`${base}/go/member`, { redirect: 'manual' });
    assert.equal(go.status, 404);
    assert.match(await go.text(), /not running/);
    assert.equal(startCalls, 1, 'the app was asked, and said no');
  } finally { s.close(); }
});

test('door: /go/<name> with a throwing starter, or one that never yields a URL, answers 404 and the process survives', async () => {
  const s = await listen({
    startWaitMs: 100,
    urls: { member: () => '', panel: () => '' },
    start: { member: () => { throw new Error('start broke'); }, panel: () => { /* starts nothing */ } },
  });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    assert.equal((await fetch(`${base}/go/member`, { redirect: 'manual' })).status, 404, 'a throwing starter is a 404, not a crash');
    assert.equal((await fetch(`${base}/go/panel`, { redirect: 'manual' })).status, 404, 'a starter that never produces a URL times out to 404');
    // Same proof shape as the D1/D2 tests: an escaped rejection would have
    // killed the process before this second request could land.
    const d = await fetch(`${base}/identities`).then((r) => r.json());
    assert.equal(d.identities.length, 2, 'the server is still up and answering');
  } finally { s.close(); }
});

test('door: /go/<name> with no starter wired keeps the old behaviour (404 while down, 302 once up)', async () => {
  let panelUrl = '';
  const s = await listen({ urls: { panel: () => panelUrl } });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    assert.equal((await fetch(`${base}/go/panel`, { redirect: 'manual' })).status, 404);
    panelUrl = 'http://127.0.0.1:8/';
    assert.equal((await fetch(`${base}/go/panel`, { redirect: 'manual' })).status, 302);
  } finally { s.close(); }
});

// ---------------------------------------------------------------- anti-drift
// The release smoke opens the built app and greps the door HTML it serves. That
// assertion lives TWICE in .github/workflows/wizard-app.yml (a PowerShell copy
// for Windows, a bash copy for macOS), and the door is edited far more often
// than the workflow. On 2026-08-03 both copies still grepped for 'Set up an
// rock', which the creator door had replaced with the pebble/rock
// cards: every build failed for two days on prose while the door was healthy,
// and fixing only the Windows copy still shipped no Mac app.
//
// So pin it here, where the door's own tests run: whatever the workflow greps
// the door for must actually be in the door. Fails in one second at desk-time
// instead of ten minutes into a release.
test('anti-drift: every door string the release smoke greps for is in door.html', () => {
  const wf = readFileSync(new URL('../../.github/workflows/wizard-app.yml', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./door.html', import.meta.url), 'utf8');

  // the two shapes: PowerShell `$html -notmatch '...'` (Windows job) and bash
  // `echo "$HTML" | grep -q '...'` (macOS job). Kept separate on purpose, so
  // one copy drifting cannot hide behind the other.
  const windows = [...wf.matchAll(/\$html -notmatch '([^']+)'/g)].map((m) => m[1]);
  const mac = [...wf.matchAll(/echo "\$HTML" \| grep -q '([^']+)'/g)].map((m) => m[1]);

  for (const [platform, asserted] of [['windows', windows], ['macos', mac]]) {
    const doorStrings = asserted.filter((s) => s === 'Crads-AI' || s.startsWith('data-make'));
    // the door check and the self-host card (the only create path since 2026-09-01)
    assert.ok(doorStrings.length >= 2,
      `the ${platform} smoke should assert the door serves the self-host path; found: ${doorStrings.join(', ') || 'nothing'}`);
    for (const s of doorStrings) {
      assert.ok(html.includes(s),
        `the ${platform} release smoke greps door HTML for ${JSON.stringify(s)}, which door.html no longer contains`);
    }
  }
});

// ---- live-cert defects (2026-08-03), found by driving the app as a user in a
// clean container: a fresh install duplicated its own doors, and the rock flow
// asked an already-answered question then called itself a pebble.
test('live-cert D1: a fresh install shows the three doors ONCE (takeover owns the screen)', () => {
  const html = readFileSync(join(HERE, 'door.html'), 'utf8');
  assert.match(html, /id="idsHead"/, 'the identities heading is addressable');
  assert.match(html, /id="newHead"/);
  assert.match(html, /id="newRow"/);
  for (const id of ['idsHead', 'newHead', 'newRow']) {
    assert.match(html, new RegExp(`getElementById\\('${id}'\\)\\.style\\.display = fresh \\? 'none' : ''`),
      `${id} hides on a fresh install, like #ids already did`);
  }
});

test('live-cert D2, superseded twice over: the manage cards do not exist for ANYONE now', () => {
  // D2's rule was "a question that is already answered is not a question". The
  // 2026-08-17 collapse removed the cards; the self-host strip (2026-09-01)
  // removed the creator flows entirely. What remains to pin is total absence.
  const html = readFileSync(join(HERE, 'door.html'), 'utf8');
  assert.doesNotMatch(html, /managedCards/, 'no manage cards, hidden or shown');
  assert.doesNotMatch(html, /data-managed=/, 'no managed pick-one buttons');
  assert.doesNotMatch(html, /startRockFlow|startPebbleFlow/, 'no creator flow to resurrect them');
});

test('live-cert D4: the setup wizard no longer asks a new rock to invent membership levels', () => {
  const wiz = readFileSync(join(HERE, '..', 'ui', 'index.html'), 'utf8');
  assert.doesNotMatch(wiz, /Your membership levels/, 'the dead question is gone');
  assert.doesNotMatch(wiz, /tiers_add/, 'and its add-a-level control with it');
  assert.match(wiz, /id="vocab_tiers"/, 'the hidden input stays so val()/KEEP/review keep working');
  assert.match(wiz, /id="tiers_rows" hidden/, 'the rows container stays for buildTiers(), hidden');
});

test('live-cert D5: a stopped build tells the truth about what it left behind', () => {
  const wiz = readFileSync(join(HERE, '..', 'ui', 'index.html'), 'utf8');
  // The old copy promised "Nothing half-made is left behind (automatic rollback)".
  // Proven false on a real run: rollback() (engine.mjs) deletes server, DNS,
  // tunnel and deploy key but NEVER the brain repo, and it is only wired inside
  // the provisioning stage, so an earlier failure rolls back nothing at all.
  const box = wiz.slice(wiz.indexOf('id="buildFail"'), wiz.indexOf('id="buildFail"') + 400);
  assert.doesNotMatch(box, /Nothing half-made is left behind/, 'the false blanket promise is gone');
  assert.match(wiz, /id="buildFailLeft"/, 'there is a place to say what remains');
  assert.match(wiz, /brain repo \(\[\\w\.-\]\+\\\/\[\\w\.-\]\+\) created/, 'the repo it made is read back out of the log');
  assert.match(wiz, /was created and is <b>kept<\/b>/, 'and named honestly as kept');
  assert.match(wiz, /rolled back automatically/, 'while cloud resources are correctly described as rolled back');
});

test('the join-a-community flow is GONE (2026-09-01): no card, no board fetch, no orphan handlers', () => {
  const html = readFileSync(new URL('./door.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /data-make="join"/, 'no join card');
  assert.doesNotMatch(html, /id="joinFlow"/, 'no flow panel');
  assert.doesNotMatch(html, /directory\.crads-ai\.com\/communities/, 'the door reads no central board');
  assert.doesNotMatch(html, /startJoinFlow|exitJoinFlow/, 'no orphan handlers left behind');
});

// Same anti-drift wall for the FACE smokes (2026-08-04): the release smoke
// greps '/' and '/console' for face titles, and those titles live in files
// edited far more often than the workflow. The member-mode smoke pinned
// '<title>Your mineral</title>' on '/' after the landing was deliberately moved to
// the app, so every build failed on prose while both surfaces were healthy —
// the exact 2026-08-03 failure shape, one surface over.
test('anti-drift: every face title the release smoke greps for is the real one', () => {
  const wf = readFileSync(new URL('../../.github/workflows/wizard-app.yml', import.meta.url), 'utf8');
  const member = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
  const memberConsole = readFileSync(new URL('./member-console.html', import.meta.url), 'utf8');

  // the org console retired with P3 (2026-08-09): the smoke pins the redirect
  assert.ok(wf.includes('org /console should redirect home since the console retired'),
    'the org smoke asserts the console redirect');

  // the member front face: '/' serves the app itself, opened on Overview
  assert.ok(wf.includes("'<title>Your Brain</title>'"), 'the member smoke asserts the app title on /');
  assert.match(member, /<title>Your Brain<\/title>/, 'and member.html actually carries it');
  assert.ok(wf.includes(`'data-sec="dashboard" class="on"'`), 'the member smoke asserts Overview is the landing tab');
  assert.ok(member.includes('data-sec="dashboard" class="on"'), 'and member.html actually lands there');

  // the standalone member console stays reachable at /console
  assert.ok(wf.includes("'<title>Your mineral</title>'"), 'the member smoke asserts the standalone console survives at /console');
  assert.match(memberConsole, /<title>Your mineral<\/title>/, 'and member-console.html actually carries it');

  // ONE shell, two faces (2026-08-09): the smokes now pin the edition wall, so
  // every string they grep for must exist in the shell + server for real.
  const server = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');
  assert.ok(wf.includes('var AIOS_EDITION = "org"'), 'the org smoke asserts the org stamp');
  assert.ok(wf.includes('var AIOS_EDITION = "member"'), 'the member smoke asserts the member stamp');
  assert.ok(member.includes("var AIOS_EDITION = '__AIOS_EDITION__'"), 'the shell carries the placeholder the server stamps');
  assert.ok(server.includes("'__AIOS_EDITION__'"), 'panel-server actually stamps it');
  assert.ok(wf.includes('class="orgonly" data-sec="yourrock"'), 'the member smoke asserts the org chrome is orgonly-marked');
  assert.ok(member.includes('class="orgonly" data-sec="yourrock"'), 'and the shell actually marks it');
  assert.ok(wf.includes('body:not([data-edition="org"]) .orgonly{display:none'), 'the member smoke asserts the CSS wall');
  assert.ok(member.includes('body:not([data-edition="org"]) .orgonly{display:none'), 'and the shell actually walls it');
});

// ---- sign in before the box is built (Sam's ruling 2026-08-05, ruling 1) ----------
// The door took a typed email on trust and everything downstream inherited it,
// including the request id (sha256(email|brain_name)) and the box's only owner
// record. A typo built a box nobody could ever recover, because Crads AI holds no
// way back in.
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeToken = (email) => `${b64url({ alg: 'RS256' })}.${b64url({ email })}.sig`;

test('the account routes are RETIRED (2026-09-01): every one answers 404', async () => {
  // /signin, /account, /account/signin, /account/signout, /account/devices and
  // /account/enrol-device all left with the account system. Identity is the
  // SSH key; a new computer is let in by an already-connected one over SSH
  // (device-routes.mjs), and the directory these relayed to no longer exists.
  // Pinned as routes, not prose: a route that still answers is a route a
  // future screen re-grows.
  const s = await listen({});
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    for (const [method, path] of [
      ['POST', '/signin'], ['GET', '/account'], ['POST', '/account/signin'],
      ['POST', '/account/signout'], ['GET', '/account/devices'], ['POST', '/account/enrol-device'],
    ]) {
      const r = await fetch(base + path, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
      assert.equal(r.status, 404, `${method} ${path} must be gone, not lingering`);
    }
  } finally { s.close(); }
});

// ---- 2026-08-12 walkthrough: three copy defects on the rock path ----
// Pinned as behaviour where the text is computed, structure where static.
const DOOR = readFileSync(new URL('./door.html', import.meta.url), 'utf8');

// DOOR with every comment stripped: JS line comments, and CSS/HTML block
// comments. Copy assertions that say "this phrase must NOT appear" have to run
// against what the page RENDERS, not against what it MENTIONS — otherwise the
// comment explaining why a phrase was removed re-fails the test that removed
// it. (Structural assertions still use DOOR: those want the source.)
const DOOR_LIVE = DOOR
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

test('a mineral held by somebody else says so, on the row, by name', () => {
  assert.doesNotMatch(DOOR_LIVE, /'Your minerals: '/,
    'that heading asserted ownership over minerals held by somebody else');
  assert.match(DOOR, /function heldLine\(/, 'the distinction is per-row, not a heading');
  assert.match(DOOR, /held === 'org'[\s\S]{0,120}held by/,
    'an org-held mineral NAMES its holder rather than being lumped into "shared"');
  assert.doesNotMatch(DOOR_LIVE, /shared with you/i,
    'that phrase is false for a member\'s own assistant that their rock holds');
  assert.match(DOOR, /held === 'you'\) return '';/,
    'saying "yours" on your own mineral is noise; the absence of a holder IS the answer');
});

test('the inventory is local-only since the account retirement (2026-09-01)', () => {
  const routes = readFileSync(new URL('./inventory-routes.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(routes, /my-minerals|my-boxes|directory\.crads-ai\.com/,
    'no directory read survives; the list is this machine own ssh config and nothing else');
  assert.match(routes, /local-only/, 'and the stage says so honestly');
});

test('RULING 8: ONE inventory handler, mounted by BOTH servers', () => {
  // The door is the start screen; the dashboard's header picker is the same
  // list. Two implementations of "what minerals does this person have" is the
  // exact failure this whole pass removed from the door, which carried three.
  // Same shape as not-let-in.test.mjs's pin on the two enrol routes.
  // comments stripped: a comment RECORDING that the duplicate read was deleted
  // is not the duplicate read, and asserting over it makes writing down the
  // reason the thing that fails the test.
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const door = strip(readFileSync(new URL('./door-server.mjs', import.meta.url), 'utf8'));
  const panel = strip(readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8'));
  for (const [name, src] of [['door-server', door], ['panel-server', panel]]) {
    assert.match(src, /import \{ inventoryRoutes \} from '\.\/inventory-routes\.mjs'/,
      `${name} imports the shared handler`);
    assert.match(src, /if \(inventory\(req, res, path\)\) return;/,
      `${name} mounts it`);
    assert.doesNotMatch(src, /\/my-minerals/,
      `${name} must not carry its own copy of the account read`);
  }
});

// ---- 2026-08-13: the mineral inventory --------------------------------------
// Spec: docs/superpowers/specs/2026-08-13-mineral-inventory.md. The audit found
// the door rendering THREE lists derived from TWO truths and never joining
// them, which is why it could not answer any of the three questions it exists
// to answer. The merge rules themselves are pinned in inventory.test.mjs; these
// pin that the PAGE actually consumes them.

test('the door speaks the tier nouns, on the row, where the chip used to say a job title', () => {
  // FINDING 1+2. "Pebble" appeared NOWHERE on this screen, directly beneath a
  // button that says "New Pebble", and the chip read "Admin/Support" / "Member":
  // a role inside somebody's org, not what the mineral IS. On a standalone
  // pebble with no rock at all, "Member" is a member of nothing.
  // (tier-honesty 2026-08-19: the chip now takes the ROW so it can decline to
  // assert a tier nobody answered — the nouns themselves are unchanged, and
  // tier-honesty.test.mjs pins the new Checking… branch.)
  assert.match(DOOR, /function kindChip\(r\)\{[\s\S]{0,400}'Rock' : 'Pebble'/,
    'the chip carries the tier noun');
  assert.doesNotMatch(DOOR_LIVE, /Admin\/Support/, 'a role in an org is not what a mineral is');
  assert.doesNotMatch(DOOR_LIVE, /· your assistant/, 'the pebble had no name on its own screen');
});

test('FINDING 8: the door never offers to connect a computer to a mineral it already has', () => {
  // The whole question Sam asked. /account/devices returned every registered
  // box with no subtraction, and the old row rendered all of it, so a mineral
  // already open on this machine was offered again.
  assert.doesNotMatch(DOOR_LIVE, /Connect this computer to: /,
    'the unfiltered run-on line is gone');
  assert.match(DOOR, /r\.onDevice \? box\.appendChild\(deviceRow/,
    'on-device and elsewhere are the same list, split by a status on the row');
  assert.match(DOOR, /function elsewhereRow\(r\)\{[\s\S]{0,900}r\.enrollable\s*\n?\s*\?/,
    'and only an elsewhere row that is actually enrollable gets the button');
});

test('FINDING 9: no dangling instruction, and no button with nothing on the other end', () => {
  // The hint said "use Connect this computer above" for a control that only
  // drew when /account/devices returned rows. worker.js:1416 records the same
  // failure found live 2026-08-12.
  assert.doesNotMatch(DOOR_LIVE, /Use &#8220;Connect this computer&#8221; above/,
    'the instruction pointed at a conditionally absent control');
  assert.match(DOOR, /Not on this computer yet, and it has not checked in/,
    'a grant with no registered box says where it stands instead of offering an ask it cannot make');
});

test('RULING 4: the door paints from disk first and never blanks', () => {
  assert.match(DOOR, /fetch\('\/inventory'\)/, 'stage one is the no-network read');
  assert.match(DOOR, /fetch\('\/inventory\/full'\)/, 'stage two still answers by name (local-only since the account retirement)');
  const load = DOOR.slice(DOOR.indexOf('function load()'), DOOR.indexOf('function loadFull()'));
  assert.match(load, /render\(\); probeAll\(\);/, 'the local answer is painted, not awaited on the network one');
  assert.match(load, /\.then\(loadFull\)/, 'and the second stage follows it rather than gating it');
});

test('RULING 5: a key-opened mineral off the signed-in account is flagged, never hidden', () => {
  // Sam, 2026-08-10: signed in with an unrelated account and read the list as
  // that account's holdings. The key stays sovereign, so the row must open.
  assert.match(DOOR, /r\.flagged/, 'the row consumes the flag');
  assert.match(DOOR, /opens with this computer&#8217;s key, not held by/,
    'and says which account it was measured against');
  const flag = DOOR.slice(DOOR.indexOf('var flag = r.flagged'), DOOR.indexOf('b.innerHTML'));
  assert.doesNotMatch(flag, /display:\s*none|return null/, 'flagged is a label, not a filter');
});

test('elsewhere rows are not pressable, because pressing them cannot open anything', () => {
  const fn = DOOR.slice(DOOR.indexOf('function elsewhereRow'), DOOR.indexOf('function forgetRow'));
  assert.match(fn, /createElement\('div'\)/, 'a div, so it never looks like an open affordance');
  assert.doesNotMatch(fn, /\.onclick\s*=/, 'the Connect button is the row\'s only action');
  assert.match(fn, /class="nodot"/, 'no presence dot: there is nothing to probe');
});

test('only on-device rows are probed', () => {
  // An elsewhere row has no alias to dial, so probing it is a guaranteed
  // failure rendered as a red dot on something that is not broken.
  const fn = DOOR.slice(DOOR.indexOf('function probeAll()'), DOOR.indexOf('// TWO STAGES'));
  assert.match(fn, /filter\(function\(r\)\{ return r\.onDevice; \}\)/, 'the probe list is filtered');
});

test('the elsewhere Connect ask left with the account system (2026-09-01)', () => {
  assert.doesNotMatch(DOOR, /\/account\/enrol-device/,
    'nothing on the page can ask a directory that no longer exists');
});

test('the account bar is GONE (2026-09-01), and nothing account-shaped remains on the page', () => {
  assert.doesNotMatch(DOOR, /id="acctBar"|acctRender|acctSignIn|acctSignOut/,
    'the bar, its renderer and its handlers all left with the account system');
  assert.doesNotMatch(DOOR_LIVE, /Signed in as|Checking this machine/,
    'no signed-in claims rendered anywhere');
});

test('nothing is anchored without a real last-used record', () => {
  // The accent rail used to fall back to identities[0]: SSH-config parse order
  // wearing the clothes of a recommendation.
  const fn = DOOR.slice(DOOR.indexOf('var last = lastUsed();'), DOOR.indexOf('renderNote();'));
  assert.match(fn, /hasLast = state\.rows\.some/, 'the anchor needs a row that matches the record');
  assert.doesNotMatch(fn, /state\.rows\[0\]/, 'parse order is not a recommendation');
});

test('live-cert D1, extended: the fresh-install takeover owns the WHOLE screen', () => {
  // Every element asserting minerals over an install with zero hides on fresh.
  // The account bar used to be the exception; it left with the account system.
  for (const id of ['idsHead', 'newHead', 'newRow', 'idsHint', 'invTitle', 'invLead']) {
    assert.match(DOOR, new RegExp(`getElementById\\('${id}'\\)\\.style\\.display = fresh \\? 'none' : ''`),
      `${id} hides on a fresh install`);
  }
  const note = DOOR.slice(DOOR.indexOf('function renderNote()'), DOOR.indexOf('function renderNote()') + 500);
  assert.match(note, /n\.textContent = ''/, 'the note renders nothing: there is no account layer to caveat');
});

// ---- 2026-08-16 QA (pebble from a rock): the cold-app findings 143/149/150 ----
// One shape, three symptoms. Every door on this screen makes something, and the
// only control that reaches what you ALREADY hold was hidden by a test that is
// true precisely because you are not signed in yet. A returning member on a new
// computer, which is the whole of flow 3 and the tail of flow 2, had nowhere to
// go. DOOR/DOOR_LIVE are read once at the top of this file.

test('FINDING 149 is OBSOLETE by design (2026-09-01): there is no sign-in to offer', () => {
  // The finding was that hiding the account bar on fresh installs stranded a
  // returning member whose minerals were one sign-in away. With the account
  // system retired, the way in for that member is device-add (another of their
  // computers lets this one in) or the self-host wizard; both live in the
  // takeover a fresh install shows. Nothing account-shaped remains to hide.
  assert.doesNotMatch(DOOR, /acctBar/, 'no bar to key on fresh');
  assert.match(DOOR, /data-make="have"/, 'the returning member has a door');
  assert.match(DOOR, /data-make="selfhost"/, 'and so does a new one');
});

test('FINDINGS 143 + 149: the takeover carries a door for somebody who already holds a mineral, and it creates nothing', () => {
  assert.match(DOOR, /data-make="have"[\s\S]{0,200}I already have one/, 'the existing-holder door exists');
  assert.match(DOOR, /if \(make === 'have'\) \{ startHaveFlow\(''\); \}/, 'and the picker routes to it');
  assert.match(DOOR, /id="haveFlow"/, 'the flow panel exists');
  // Since 2026-09-01 the way in is device-add: another of the person's own
  // computers lets this one in over SSH. No account, no sign-in control.
  for (const id of ['devJoin', 'devName', 'devOfferBtn', 'devBundle', 'devCompleteBtn', 'devMsg']) {
    assert.match(DOOR, new RegExp(`id="${id}"`), `${id} is the device path`);
  }
  assert.doesNotMatch(DOOR, /haveSignInBtn|\/account\/signin/, 'the sign-in secondary left with the account system');
  const flow = DOOR.slice(DOOR.indexOf('id="devJoin"'), DOOR.indexOf('id="idsHead"'));
  assert.doesNotMatch(flow, /pebble-request|create-request|\/provision\/start/,
    'the existing-holder door never creates a mineral');
  const start = DOOR.slice(DOOR.indexOf('function startHaveFlow(slug)'), DOOR.indexOf('function exitHaveFlow()'));
  assert.match(start, /pebbleFlowActive = true;/, 'it latches the takeover open');
  assert.match(start, /getElementById\('creatorHome'\)\.style\.display = 'block';/, 'and forces it open');
  const exit = DOOR.slice(DOOR.indexOf('function exitHaveFlow()'), DOOR.indexOf("getElementById('haveBack')"));
  assert.match(exit, /exitPebbleFlow\(\);/, 'and leaving clears the latch');
  for (const [fn, end] of [['function startShFlow()', 'function exitShFlow()']]) {
    const body = DOOR.slice(DOOR.indexOf(fn), DOOR.indexOf(end));
    assert.match(body, /getElementById\('haveFlow'\)\.style\.display = 'none';/,
      `${fn} hides the have flow, or the two panels render on top of each other`);
  }
});

test('FINDING 143: crads-ai://box/<slug> with no local Host block lands ON the connect branch, not on "What are we making?"', () => {
  // app.mjs finds no `<slug>-box` target, drops the slug and opens the door.
  // Discarding a slug it cannot open is correct for a surface PICKER
  // (connect-enrols.test.mjs:12); what was unhandled is having no surface to
  // pick. The app can now hand the slug over as #connect=<slug>.
  const hook = DOOR.slice(DOOR.indexOf('#connect(?:='), DOOR.indexOf('RULING 3\'s action'));
  assert.match(DOOR, /location\.hash\.match\(\/\^#connect\(\?:=\(\[a-z0-9\]\[a-z0-9-\]\*\)\)\?\$\/\)/,
    'the door reads a #connect hash, with or without a slug');
  assert.match(hook, /startHaveFlow\(slug\)/, 'and opens the existing-holder branch on it');
  assert.match(hook, /firstLoad\.then\(/,
    'after the first inventory read, so a mineral the account ALREADY lists is answered by its own row');
  assert.match(hook, /if \(slug && state\.rows\.some\(function\(r\)\{ return r\.slug === slug; \}\)\) return;/,
    'an already-listed mineral is left to the list, which carries the Connect button: two doors into one room is the defect, not the fix');
  assert.match(DOOR, /var firstLoad = load\(\);/, 'the first load is held so it can be waited on');
  const load = DOOR.slice(DOOR.indexOf('function load()'), DOOR.indexOf('function loadFull()'));
  assert.match(load, /return fetch\('\/inventory'\)/, 'load returns its promise');
  assert.match(DOOR, /function loadFull\(\)\{[\s\S]{0,300}?return fetch\('\/inventory\/full'\)/, 'and so does the second stage');
  // the slug is named on screen: otherwise a member who pressed "Open in the
  // app" cannot tell whether the link did anything at all
  assert.match(DOOR, /This computer has no key for "' \+ haveSlug \+ '" yet/, 'the branch names what the link asked for');
});

// ---------------------------------------------------------------------------
// 2026-08-18: the door drew a rock, the app refused to open it.
//
// Harriet provisioned a rock, clicked it, and got a bare-text 404 "that surface is
// not running". Two definitions of "rock" had drifted apart: the row's tier
// comes from the ACCOUNT (inventory.mjs -- "the account's tier wins when we have
// it"), while the panel starter read only the local ssh alias suffix plus the
// promoted-host cache. A rock provisioned or promoted in this session still
// wears its <slug>-box alias until the face probe has cached its answer, and
// only app LAUNCH ran that probe -- so the first click dead-ended, and stayed
// dead until she relaunched. These three pin the fix.
// ---------------------------------------------------------------------------

test('door: /go/<name> tells the starter WHICH mineral was clicked', async () => {
  // The identity used to ride the fragment alone, which never reaches a server.
  const seen = [];
  const s = await listen({
    urls: { panel: () => '', member: () => '' },
    start: {
      panel: (want) => { seen.push(['panel', want]); return false; },
      member: (want) => { seen.push(['member', want]); return false; },
    },
  });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    await fetch(`${base}/go/panel?host=collab-ea-box`, { redirect: 'manual' });
    await fetch(`${base}/go/member?box=jane01`, { redirect: 'manual' });
    assert.deepEqual(seen[0], ['panel', { host: 'collab-ea-box', box: '' }],
      'the rock the member actually clicked reaches the starter');
    assert.deepEqual(seen[1], ['member', { box: 'jane01', host: '' }],
      'and so does the pebble');
    // A bare hit (older page, or someone typing the URL) must still work as before.
    await fetch(`${base}/go/panel`, { redirect: 'manual' });
    assert.deepEqual(seen[2], ['panel', { host: '', box: '' }], 'no identity asked for is not a crash');
  } finally { s.close(); }
});

test('door: a starter that promotes the asked-for host on demand gets its redirect', async () => {
  // The shape of the real fix: no local rock face, so the app asks THAT box what
  // it is, learns it is a rock, and brings the panel up -- instead of 404ing
  // until the next relaunch.
  let panelUrl = '';
  let asked = '';
  const s = await listen({
    urls: { panel: () => panelUrl },
    start: {
      panel: async (want) => {
        asked = want.host;
        if (want.host !== 'collab-ea-box') return false;   // only the box that was clicked
        await new Promise((r) => setTimeout(r, 10));        // the probe is a real round trip
        panelUrl = 'http://127.0.0.1:8/';
      },
    },
  });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const go = await fetch(`${base}/go/panel?host=collab-ea-box`, { redirect: 'manual' });
    assert.equal(asked, 'collab-ea-box');
    assert.equal(go.status, 302, 'the on-demand promote is waited for, not raced');
    assert.equal(go.headers.get('location'), 'http://127.0.0.1:8/');
  } finally { s.close(); }
});

test('door: the "not running" answer is a page with a way back, never a bare string', async () => {
  const s = await listen({ urls: { panel: () => '' } });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const r = await fetch(`${base}/go/panel`, { redirect: 'manual' });
    assert.equal(r.status, 404);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const body = await r.text();
    assert.match(body, /not running/, 'it still says what happened');
    assert.match(body, /href="\/"/, 'and it is never a dead end: there is a way back to the door');
    assert.match(body, /rock/, 'named in the words a member uses, not the surface name');
    assert.doesNotMatch(body, /https?:\/\//,
      'self-contained: an error page that fetches anything can fail while rendering a failure');
  } finally { s.close(); }
});
