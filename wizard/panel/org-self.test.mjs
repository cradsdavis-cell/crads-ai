// org-self.test.mjs — born as P2 of the upgraded-pebble spec (2026-08-09): the
// rock box is a pebble-plus, so the org edition carried the member
// self-management verbs with an edition wall (exclusions, org-pathed twins,
// adminOnly rewrites) between the two faces.
//
// The face collapse (2026-09-01) deleted the wall wholesale: ONE verb table
// (MEMBER_VERBS plus the Catalogue page's library/commons verbs), served to
// every target, legacy <org>-rock aliases included. This file now pins the
// collapsed truth: the wall stays down, the one table answers, and the only
// role gate left is the legacy Support role against the adminOnly commons
// verbs.
//   node --test wizard/panel/org-self.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPanelServer } from './panel-server.mjs';

const ROCK = { host: 'ic-rock', org: 'ic', kind: 'rock' };

function fakeBridge(targets) {
  const ran = [];
  return {
    ran,
    targets: () => targets,
    stream: (host, command, o = {}) => {
      ran.push({ host, command });
      const pebble = new EventEmitter();
      pebble.kill = () => {};
      setImmediate(() => { if (o.onStdout) o.onStdout(`RAN:${command}`); pebble.emit('close', 0); });
      return pebble;
    },
  };
}
const listen = (opts) => new Promise((resolve) => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html>x</html>', ...opts });
  s.on('listening', () => resolve(s));
});

// A bridge whose box answers the batched topology-state read with a real
// marked transcript, so /topology/world can be driven end to end.
function worldBridge(state) {
  const out = 'CONSOLE_STATE ' + JSON.stringify(state) + '\n'
    + '__DEVICES__\n{"devices":[]}\n__SUPPORT__\n{"active":null}\n';
  return {
    targets: () => [ROCK],
    stream: (host, command, o = {}) => {
      const pebble = new EventEmitter();
      pebble.kill = () => {};
      setImmediate(() => { if (o.onStdout) o.onStdout(out); pebble.emit('close', 0); });
      return pebble;
    },
  };
}
const runArgs = async (srv, verb, args = {}, host = 'ic-rock') => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host, verb, args }),
  });
  return { status: r.status, text: await r.text() };
};
const runVerb = (srv, verb, host) => runArgs(srv, verb, {}, host);

test('the one table serves the self-management families to a legacy -rock target', async () => {
  const bridge = fakeBridge([ROCK]);
  const s = await listen({ bridge });
  try {
    for (const verb of ['skills-list', 'cadence-list', 'telegram-status', 'mcp-status',
      'secrets-list', 'sharing-list', 'box-version', 'devices-list', 'support-status']) {
      const r = await runVerb(s, verb);
      assert.equal(r.status, 200, `${verb} is served`);
      assert.ok(!r.text.includes('unknown verb'), `${verb} dispatched`);
    }
    assert.ok(bridge.ran.every((x) => x.host === 'ic-rock'), 'every command went to the named box');
  } finally { s.close(); }
});

test('the edition wall is RETIRED (2026-09-01): the once-excluded member verbs answer', async () => {
  // These six were refused on the org face because the rock had org-pathed
  // twins or no use for them. There is no org face: a mineral whose ownership
  // tier happens to be rock is still a mineral, and manages itself with the
  // same verbs as everyone.
  const s = await listen({ bridge: fakeBridge([ROCK]) });
  try {
    for (const verb of ['member-console-state', 'box-rename',
      'leave-org', 'transfer-accept', 'ask-answer', 'layout-write']) {
      const r = await runVerb(s, verb);
      assert.ok(!r.text.includes('unknown verb'), `${verb} is in the one table now`);
    }
  } finally { s.close(); }
});

test('one brain: brain-list reads the mineral\'s own wiki at /state/wiki', async () => {
  // The org-pathed twin that read the rock's brain repo lost its page and is
  // no longer served; every mineral's Brain page is its own wiki.
  const bridge = fakeBridge([ROCK]);
  const s = await listen({ bridge });
  try {
    const r = await runVerb(s, 'brain-list');
    assert.equal(r.status, 200);
    const cmd = (bridge.ran[0] || {}).command || '';
    assert.ok(cmd.includes('/state/wiki'), `brain-list enters the member wiki (got: ${cmd.slice(0, 80)})`);
  } finally { s.close(); }
});

test('vault, self-heal and the live world feed all answer on the one face', async () => {
  const s = await listen({ bridge: worldBridge({ name: 'Aster', ownership: { tier: 'rock' } }) });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const vault = await fetch(`${base}/vault/seal`, { method: 'POST', body: '{}' });
    assert.notEqual(vault.status, 404, '/vault routes exist');
    const heal = await fetch(`${base}/devices/self-heal`, { method: 'POST', body: '{}' });
    assert.notEqual(heal.status, 404, 'self-heal exists');
    const topo = await fetch(`${base}/topology/world`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'ic-rock' }) });
    assert.equal(topo.status, 200, 'the world feed answers for a legacy -rock target too');
    const w = await topo.json();
    assert.equal(w.ok, true);
    // The org/anchor/Mountain synthesis died with the hosted model: the world
    // is the box, its devices, and any open support window. Nothing else.
    assert.deepEqual(Object.keys(w).sort(), ['box', 'devices', 'ok', 'support'],
      'the world carries exactly box, devices and support');
    assert.equal(w.box.tier, 'rock', 'the ownership tier still rides the box facts');
  } finally { s.close(); }
});

test('the directory-edge synthesis is RETIRED (2026-09-01): no edge cache, no orgs rows', async () => {
  // Finding 201 taught the rock world to carry its own joined ties from the
  // directory edge cache. The directory is deleted; communities are drawn
  // page-side from the mineral's own community-list, so the server keeps no
  // edge cache and the world stays silent about ties.
  const s = await listen({ bridge: worldBridge({ name: 'Aster', ownership: { tier: 'rock' } }) });
  try {
    s._communityMine = { edgesAt: Date.now(), edges: [
      { rel: 'joined', slug: 'ic', org: 'qa-r2-gmail', org_display: 'QA Run Two Gmail', status: 'active' },
    ] };
    const r = await fetch(`http://127.0.0.1:${s.address().port}/topology/world`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'ic-rock' }) });
    assert.equal(r.status, 200);
    const w = await r.json();
    assert.equal(w.ok, true);
    assert.ok(!('orgs' in w), 'a planted edge cache changes nothing: the world never grows orgs rows');
  } finally { s.close(); }
});

test('the shell has one nav: the section wall and the org-only chrome are gone', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
  assert.match(html, /<div class="navgroup" data-group="assistant">/, 'Your assistant group survives');
  assert.match(html, /<div class="navgroup" data-group="privacy">/, 'Privacy & access group survives');
  assert.match(html, /<section data-sec="help">/, 'the Help page survives');
  assert.match(html, /<a class="navlink" id="helpLink" href="#help"/, 'the Help link carries no face class');
  // The wall itself is gone, both halves.
  assert.ok(!html.includes('MEM_SECS'), 'no member-only section list');
  assert.ok(!html.includes('ORG_SECS'), 'no org-only section list');
  assert.ok(!html.includes('What Crads AI receives from this rock'), 'the rock sharing floor card died with the Sharing page');
});

// ---- the commons is where Admin still means something -----------------------
// The old org face rewrote imported mutating verbs to adminOnly. That rewrite
// died with the face: on your own mineral, lifecycle authority rides
// ownership, not a panel role. What the legacy Support role still gates is
// publishing: the commons write verbs stay adminOnly in the one table.

test('a Support sign-in can install on the box but cannot publish to the commons', async () => {
  const bridge = fakeBridge([ROCK]);
  const s = await listen({ bridge, role: 'support' });
  try {
    const inst = await runArgs(s, 'catalog-install', { id: 'deep-research' });
    assert.equal(inst.status, 200, `installing from the box's own inbox is not admin-gated: ${inst.text}`);
    for (const verb of ['commons-publish', 'commons-grant', 'commons-revoke']) {
      const r = await runArgs(s, verb, {});
      assert.equal(r.status, 403, `${verb} refused for Support`);
      assert.match(r.text, /admin/i, 'and refused for being Support, not for a malformed call');
    }
  } finally { s.close(); }
});

test('a box picks up from its inbox through the one installer, no directory leg', async () => {
  const bridge = fakeBridge([ROCK]);
  const s = await listen({ bridge });
  try {
    const r = await runArgs(s, 'catalog-install', { id: 'deep-research' });
    assert.equal(r.status, 200, r.text);
    const cmd = (bridge.ran[0] || {}).command || '';
    assert.match(cmd, /org-inbox\/skills\/deep-research/, 'copied out of the box\'s OWN inbox');
    assert.doesNotMatch(cmd, /curl|fetch/, 'no directory leg: everything installable is already aboard');
  } finally { s.close(); }
});

// ---- Pages (panel iteration 2, R15, 2026-08-23) ----------------------------
// The R15 verbs survive the collapse unchanged; only the face they were once
// walled from is gone. These pin the server half: the three verbs answer, and
// bad ids never reach a shell.
test('a mineral lists, reads and deletes its own pages', async () => {
  const bridge = fakeBridge([ROCK]);
  const s = await listen({ bridge });
  try {
    for (const [verb, args] of [['pages-list', {}], ['page-read', { page: 'welcome.html' }], ['page-delete', { id: 'welcome' }]]) {
      const r = await runArgs(s, verb, args);
      assert.equal(r.status, 200, `${verb} answers: ${r.text}`);
      assert.ok(!r.text.includes('unknown verb'), `${verb} dispatched`);
    }
    assert.ok(bridge.ran.every((x) => x.host === 'ic-rock'), 'every command went to the named box');
    const del = bridge.ran[bridge.ran.length - 1].command;
    assert.match(del, /page-delete\.mjs/, 'delete runs the engine script');
    assert.match(del, /\/state welcome(\s|;|$)/, 'against /state with the bare id');
  } finally { s.close(); }
});

test('page-delete refuses anything that is not a plain page slug', async () => {
  const bridge = fakeBridge([ROCK]);
  const s = await listen({ bridge });
  try {
    for (const id of ['', '../etc', 'a/b', 'Welcome', 'x;touch /tmp/pwn', 'a b', '.hidden', 'a'.repeat(90)]) {
      const r = await runArgs(s, 'page-delete', { id });
      assert.equal(r.status, 400, `refused: ${JSON.stringify(id)}`);
    }
    assert.equal(bridge.ran.length, 0, 'nothing reached the box');
  } finally { s.close(); }
});
