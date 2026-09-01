// demote.test.mjs — demote refuses while members remain (promote ruling § 4,
// 2026-08-04). The org face of a promoted box retires IN PLACE; the personal
// seat stays. Guard is FAIL-CLOSED: no proof the rock is empty, no
// demote. Run: node --test wizard/panel/demote.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPanelServer } from './panel-server.mjs';

// A scripted bridge: routes each streamed command to a canned {code, out} by
// content — member-list probes vs the ownership flip — and records what ran.
function scriptedBridge({ memberList, flip, targets }) {
  const ran = [];
  return {
    ran,
    targets: () => targets,
    stream: (host, command, o = {}) => {
      ran.push(command);
      const spec = /ownership\.json/.test(command) ? flip : memberList;
      const ee = new EventEmitter();
      setImmediate(() => {
        if (spec.err) { ee.emit('error', new Error(spec.err)); return; }
        for (const line of spec.out || []) { if (o.onStdout) o.onStdout(line); }
        ee.emit('close', spec.code ?? 0);
      });
      return ee;
    },
  };
}

const PROMOTED_TARGETS = [
  { host: 'promo9-box', org: 'promo9-org', kind: 'rock', promoted: true },
  { host: 'classic-rock', org: 'classic', kind: 'rock' },
];

async function startServer(bridge, extra = {}) {
  const server = createPanelServer({ port: 0, host: '127.0.0.1', bridge, htmlText: '<html></html>', ...extra });
  await new Promise((r) => server.on('listening', r));
  return server;
}

async function demote(server, body) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/demote`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

const CONFIRM = 'retire this rock';

test('demote refuses while members remain (any record not explicitly left blocks)', async (t) => {
  const bridge = scriptedBridge({
    targets: PROMOTED_TARGETS,
    memberList: { out: ['=== registry/members/a.yaml', 'status: "active"', '=== registry/members/b.yaml', 'status: "left"'], code: 0 },
    flip: { out: [], code: 0 },
  });
  const server = await startServer(bridge);
  t.after(() => server.close());
  const r = await demote(server, { host: 'promo9-box', confirm: CONFIRM });
  assert.equal(r.status, 409);
  assert.match(r.text, /still has 1 member/);
  assert.equal(bridge.ran.filter((c) => /ownership\.json/.test(c)).length, 0, 'the flip must never run');
});

test('demote FAILS CLOSED on an unreadable registry (unlike teardown, which may proceed)', async (t) => {
  const bridge = scriptedBridge({
    targets: PROMOTED_TARGETS,
    memberList: { out: [], code: 1 },
    flip: { out: [], code: 0 },
  });
  const server = await startServer(bridge);
  t.after(() => server.close());
  const r = await demote(server, { host: 'promo9-box', confirm: CONFIRM });
  assert.equal(r.status, 502);
  assert.match(r.text, /without proof the rock is empty/);
});

test('demote succeeds when every member has left: tier flips, face registry told', async (t) => {
  let demotedHost = '';
  const bridge = scriptedBridge({
    targets: PROMOTED_TARGETS,
    memberList: { out: ['=== registry/members/a.yaml', 'status: "left"'], code: 0 },
    flip: { out: ['demoted: this mineral is a pebble again'], code: 0 },
  });
  const server = await startServer(bridge, { onDemoted: (h) => { demotedHost = h; } });
  t.after(() => server.close());
  const r = await demote(server, { host: 'promo9-box', confirm: CONFIRM });
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /pebble again/);
  assert.equal(demotedHost, 'promo9-box');
  const flipCmd = bridge.ran.find((c) => /ownership\.json/.test(c));
  assert.ok(flipCmd.includes('tier="pebble"'), 'flips only the tier');
});

test('demote refuses a classic -rock org (teardown owns that path) and a wrong confirm', async (t) => {
  const bridge = scriptedBridge({ targets: PROMOTED_TARGETS, memberList: { out: [], code: 0 }, flip: { out: [], code: 0 } });
  const server = await startServer(bridge);
  t.after(() => server.close());
  assert.equal((await demote(server, { host: 'classic-rock', confirm: CONFIRM })).status, 400);
  assert.equal((await demote(server, { host: 'promo9-box', confirm: 'yes' })).status, 400);
});

test('demote needs an Admin login', async (t) => {
  const bridge = scriptedBridge({ targets: PROMOTED_TARGETS, memberList: { out: [], code: 0 }, flip: { out: [], code: 0 } });
  const server = await startServer(bridge, { role: 'support' });
  t.after(() => server.close());
  assert.equal((await demote(server, { host: 'promo9-box', confirm: CONFIRM })).status, 403);
});

test('the retire card exists, arms on the exact server phrase, and every helper is defined', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
  const server = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');
  assert.match(html, /id="retireWrap"/, 'the card exists, hidden by default');
  assert.match(html, /nothing is destroyed/, 'honest wording: retire destroys nothing');
  // the typed phrase matches the server check byte-for-byte
  assert.ok(html.includes("!== 'retire this rock'"), 'the page arms on the phrase');
  assert.ok(server.includes("!== 'retire this rock'"), 'the server requires the same phrase');
  assert.match(html, /fetch\('\/demote'/, 'wired to the guarded route');
  for (const fn of ['syncRetire']) assert.match(html, new RegExp(`function ${fn}\\(`), `${fn} defined`);
  assert.ok((html.match(/syncRetire\(\)/g) || []).length >= 2, 'visibility syncs at boot AND on host change');
});

// ---------------------------------------------------------------------------
// HONESTY ABOUT THE HANDLE (found by driving the real UI, 2026-08-04).
// The route prefers the box's own demote.mjs, which calls /unregister and says
// so; a box without that script falls back to a plain tier flip that leaves the
// directory handle CLAIMED. The success message was flat either way, so a user
// who retired a fallback-path box was told the rock was retired while
// /register would still 409 the name forever. The box already speaks the truth
// ("the org handle is STILL REGISTERED"); the route just has to carry it.
test('a fallback-path demote says the handle is still claimed', async (t) => {
  const bridge = scriptedBridge({
    targets: PROMOTED_TARGETS,
    memberList: { out: ['=== /state/brain/registry/members/a.yaml', 'status: "left"'], code: 0 },
    flip: { out: ['demoted: this mineral is a pebble again'], code: 0 },
  });
  const server = await startServer(bridge);
  t.after(() => server.close());
  const r = await demote(server, { host: 'promo9-box', confirm: CONFIRM });
  assert.equal(r.status, 200);
  assert.match(r.text, /still registered|still claimed/i, 'must not imply the handle was freed');
});

test('a demote that DID retire the handle carries no false caveat', async (t) => {
  const bridge = scriptedBridge({
    targets: PROMOTED_TARGETS,
    memberList: { out: ['=== /state/brain/registry/members/a.yaml', 'status: "left"'], code: 0 },
    flip: { out: ['retired the handle "promo9-org" at the directory.', 'OK: this mineral is a pebble again.'], code: 0 },
  });
  const server = await startServer(bridge);
  t.after(() => server.close());
  const r = await demote(server, { host: 'promo9-box', confirm: CONFIRM });
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /still registered|still claimed/i);
  assert.match(r.text, /handle/i, 'should report the handle was retired');
});
