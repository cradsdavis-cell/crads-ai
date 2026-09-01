// org-self.test.mjs — P2 of the upgraded-pebble spec (2026-08-09): the rock box
// is a pebble-plus, so the org edition carries the member SELF-MANAGEMENT verb
// families against its own rock box, while the org-pathed twins keep winning
// and the deliberately-excluded verbs stay excluded.
//   node --test wizard/panel/org-self.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPanelServer } from './panel-server.mjs';

const ROCK = { host: 'ic-rock', org: 'ic', kind: 'rock' };
const MEMBER = { host: 'jane01-box', org: 'jane01', kind: 'member' };

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
const runVerb = async (srv, verb, host = 'ic-rock') => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host, verb, args: {} }),
  });
  return { status: r.status, text: await r.text() };
};

test('org edition runs the member self-management families against the rock box', async () => {
  const bridge = fakeBridge([ROCK]);
  const s = await listen({ bridge });
  try {
    for (const verb of ['skills-list', 'cadence-list', 'telegram-status', 'mcp-status',
      'secrets-list', 'sharing-list', 'box-version', 'devices-list', 'support-status']) {
      const r = await runVerb(s, verb);
      assert.equal(r.status, 200, `${verb} is a known org verb now`);
      assert.ok(!r.text.includes('unknown verb'), `${verb} dispatched`);
    }
    assert.ok(bridge.ran.every((x) => x.host === 'ic-rock'), 'every command went to the rock box');
  } finally { s.close(); }
});

test('the deliberately-excluded member verbs stay excluded from the org face', async () => {
  const s = await listen({ bridge: fakeBridge([ROCK]) });
  try {
    // catalog-list/catalog-install LEFT this list on 2026-08-17 (one-inbox).
    // They were excluded on the reasoning that "a rock's library is the vendor
    // catalog under Publishing", which is the exact confusion the spec removes:
    // the Catalogue page is what a rock GIVES OUT, catalog-list is what it
    // RECEIVES from rocks it is tied to. A rock is a box and now gets an inbox
    // from every rock it joins, so it picks up like anyone else. This is the
    // need community-skill-apply used to meet by crossing the wall.
    // pages-list LEFT this list on 2026-08-23 (panel iteration 2, R15): a rock
    // has Pages too. Pinned below with page-read and page-delete.
    for (const verb of ['member-console-state', 'box-rename',
      'leave-org', 'transfer-accept', 'ask-answer', 'layout-write']) {
      const r = await runVerb(s, verb);
      assert.equal(r.status, 400, `${verb} refused`);
      assert.match(r.text, /unknown verb/, `${verb} is not an org verb`);
    }
  } finally { s.close(); }
});

test('the org-pathed twins win the merge: brain-list reads the ORG brain, never /state/wiki', async () => {
  const bridge = fakeBridge([ROCK]);
  const s = await listen({ bridge });
  try {
    const r = await runVerb(s, 'brain-list');
    assert.equal(r.status, 200);
    const cmd = (bridge.ran[0] || {}).command || '';
    assert.ok(!cmd.includes('/state/wiki'), `org brain-list must not enter the member wiki (got: ${cmd.slice(0, 80)})`);
  } finally { s.close(); }
});

test('vault, self-heal and the live world feed all answer on the org face', async () => {
  const org = await listen({ bridge: fakeBridge([ROCK]) });
  const mem = await listen({ bridge: fakeBridge([MEMBER]), edition: 'member' });
  try {
    const base = (srv) => `http://127.0.0.1:${srv.address().port}`;
    const vaultOrg = await fetch(`${base(org)}/vault/seal`, { method: 'POST', body: '{}' });
    assert.notEqual(vaultOrg.status, 404, 'org /vault routes exist');
    const healOrg = await fetch(`${base(org)}/devices/self-heal`, { method: 'POST', body: '{}' });
    assert.notEqual(healOrg.status, 404, 'org self-heal exists');
    const topoOrg = await fetch(`${base(org)}/topology/world`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'ic-rock' }) });
    assert.equal(topoOrg.status, 200, 'the rock has a live world feed since P3');
    const w = await topoOrg.json();
    assert.equal(w.ok, true); assert.equal(w.rock, true, 'the world declares itself a rock world');
    assert.ok(Array.isArray(w.fleet), 'the fleet rides the world');
    assert.equal((w.org || {}).label, 'Crads AI', 'the anchor above is the platform (uniform anchor rule)');
    const topoMem = await fetch(`${base(mem)}/topology/world`, { method: 'POST', body: '{}' });
    assert.notEqual(topoMem.status, 404, 'member live topology feed unchanged');
  } finally { org.close(); mem.close(); }
});

// Finding 201 (Sam, 2026-08-17): "I currently have the Institute of
// Shenanigans joined to QA Run Two Gmail, but it's not showing in the network
// tab." The rock's world ended at Crads AI above and the fleet below; a rock
// this rock had JOINED lived only on the Organisations page. The world now
// carries the same `orgs` shape the member map already reads, narrowed the
// way /rock-mine's org face narrows: the rock's OWN joined rows only.
test('the rock\'s own memberships ride its world feed', async () => {
  const s = await listen({ bridge: fakeBridge([ROCK]) });
  try {
    s._communityMine = { edgesAt: Date.now(), edges: [
      { rel: 'joined', slug: 'ic', org: 'qa-r2-gmail', org_display: 'QA Run Two Gmail', status: 'active' },
      { rel: 'joined', slug: 'someone-else', org: 'other-rock', org_display: 'Another slug\'s tie' },
      { rel: 'anchored', slug: 'ic', org: 'never-drawn', org_display: 'A rock is never anchored' },
      { rel: 'joined', slug: 'ic', org: 'crads-solo', org_display: 'A platform lane is not a rock' },
    ] };
    const r = await fetch(`http://127.0.0.1:${s.address().port}/topology/world`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'ic-rock' }) });
    assert.equal(r.status, 200);
    const w = await r.json();
    assert.equal(w.ok, true);
    assert.ok(Array.isArray(w.orgs), 'the world carries the orgs rows the map draws above the rock');
    assert.deepEqual(w.orgs[0], { label: 'Crads AI', tie: 'anchored', status: 'active' }, 'the platform anchor leads');
    assert.deepEqual(w.orgs.filter((o) => o.tie === 'joined'),
      [{ label: 'QA Run Two Gmail', tie: 'joined', status: 'active' }],
      'exactly the rock\'s own joined rows: another slug\'s edge, an anchored row and a platform lane are all excluded');
  } finally { s.close(); }
});

test('the shell shares the self-management pages: nav groups open to both faces', async () => {
  // (Library was member-only chrome until 2026-08-09, when audit R6 folded it
  // into the shared Skills page; the wall now holds only the seat + brain.)
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
  assert.match(html, /<div class="navgroup" data-group="assistant">/, 'Your assistant group is shared chrome (was "automations" until 2026-08-10)');
  assert.match(html, /<div class="navgroup" data-group="privacy">/, 'Privacy & access group is shared chrome');
  // R17 (2026-08-23): the Claude Code tab became the Help page, reached from
  // the footer link on BOTH faces (it was rock-only chrome until then).
  assert.match(html, /<section data-sec="help">/, 'the Help page is shared');
  assert.match(html, /<a class="navlink" id="helpLink" href="#help"/, 'the Help link carries no face class');
  const wall = html.match(/var MEM_SECS = \[([^\]]*)\]/);
  assert.ok(wall, 'the edition wall exists');
  // brain crossed the wall in S5 (2026-08-09): the graph viewer serves the
  // org brain too, through the org edition's own brain-list/brain-read verbs
  for (const sec of ['skills', 'connections', 'secrets', 'sharing', 'help', 'rocks', 'network', 'brain']) {
    assert.ok(!wall[1].includes(`'${sec}'`), `${sec} crossed the wall (shared since P2/S5)`);
  }
  assert.ok(wall[1].includes("'seat'"), 'the seat stays member-only');
  assert.match(html, /What Crads AI receives from this rock/, 'the rock sharing floor card exists');
});

// ---- the community-install pipe on the rock face (Sam's ruling 2026-08-10) --
// R9 gave every tied rock a catalogue and made /community-catalogs org-aware
// (narrowed to the rock's OWN joined ties), but the two gates behind Install
// stayed member-shaped: /community-item was `&& edition === 'member'` and
// community-skill-apply was absent from SELF_VERBS. The rock's Skills page
// therefore drew the shop window and dead-ended on the buy: a 404 rendered as
// "Could not fetch that skill from the directory." Ruled: wire it. These pin
// the two gates, the Support floor, and the box the write actually lands on.

const B64_SKILL = Buffer.from('---\nname: deep-research\n---\nbody\n', 'utf8').toString('base64');

const runArgs = async (srv, verb, args, host = 'ic-rock') => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host, verb, args }),
  });
  return { status: r.status, text: await r.text() };
};


// ONE INBOX (2026-08-17). Four tests stood here covering a rock installing a
// joined rock's skill through community-skill-apply and /community-item: the
// apply verb crossing the org wall, its adminOnly rewrite, the content route
// serving both faces, and the sign-in-needed answer. That whole path is retired.
// The NEED it served is not, so it is pinned here against its replacement.
const runVerbArgs = async (srv, verb, args, host = 'ic-rock') => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host, verb, args }),
  });
  return { status: r.status, text: await r.text() };
};

test('a rock picks up from a rock it joined, through the one installer', async () => {
  const bridge = fakeBridge([ROCK]);
  const s = await listen({ bridge });
  try {
    const r = await runVerbArgs(s, 'catalog-install', { id: 'deep-research' });
    assert.equal(r.status, 200, `the rock face has it now: ${r.text}`);
    const cmd = (bridge.ran[0] || {}).command || '';
    assert.match(cmd, /org-inbox\/skills\/deep-research/, 'copied out of the rock’s OWN inbox');
    assert.doesNotMatch(cmd, /curl|fetch/, 'no directory leg: a rock acquires the way a pebble does');
  } finally { s.close(); }
});

test('installing on a rock is an Admin action: a Support sign-in cannot', async () => {
  // The property the old adminOnly-rewrite test protected. Imported mutating
  // verbs become adminOnly on the org face, and catalog-install is mutating.
  const s = await listen({ bridge: fakeBridge([ROCK]), role: 'support' });
  try {
    const r = await runVerbArgs(s, 'catalog-install', { id: 'deep-research' });
    assert.notEqual(r.status, 200, 'Support is read-mostly on the rock');
    assert.match(r.text, /admin/i, 'and refused for being Support, not for a malformed call');
  } finally { s.close(); }
});

// ---- Pages on rocks (panel iteration 2, R15, 2026-08-23) -------------------
// Pages were pebble-only three times over: boot-rock never seeded them, the
// verbs were missing from SELF_VERBS (400 on the org face), and the client
// walled `page:` routes. These pin the server half: the three verbs answer on
// the rock, the delete is an Admin act, and bad ids never reach a shell.
test('a rock lists, reads and deletes its own pages', async () => {
  const bridge = fakeBridge([ROCK]);
  const s = await listen({ bridge });
  try {
    for (const [verb, args] of [['pages-list', {}], ['page-read', { page: 'welcome.html' }], ['page-delete', { id: 'welcome' }]]) {
      const r = await runVerbArgs(s, verb, args);
      assert.equal(r.status, 200, `${verb} answers on the org face: ${r.text}`);
      assert.ok(!r.text.includes('unknown verb'), `${verb} dispatched`);
    }
    assert.ok(bridge.ran.every((x) => x.host === 'ic-rock'), 'every command went to the rock box');
    const del = bridge.ran[bridge.ran.length - 1].command;
    assert.match(del, /page-delete\.mjs/, 'delete runs the engine script');
    assert.match(del, /\/state welcome(\s|;|$)/, 'against /state with the bare id');
  } finally { s.close(); }
});

test('deleting a page on a rock is an Admin action: a Support sign-in cannot', async () => {
  const s = await listen({ bridge: fakeBridge([ROCK]), role: 'support' });
  try {
    const r = await runVerbArgs(s, 'page-delete', { id: 'welcome' });
    assert.notEqual(r.status, 200, 'Support is read-mostly on the rock');
    assert.match(r.text, /admin/i, 'refused for being Support, not for a malformed call');
  } finally { s.close(); }
});

test('page-delete refuses anything that is not a plain page slug', async () => {
  const bridge = fakeBridge([ROCK]);
  const s = await listen({ bridge });
  try {
    for (const id of ['', '../etc', 'a/b', 'Welcome', 'x;touch /tmp/pwn', 'a b', '.hidden', 'a'.repeat(90)]) {
      const r = await runVerbArgs(s, 'page-delete', { id });
      assert.equal(r.status, 400, `refused: ${JSON.stringify(id)}`);
    }
    assert.equal(bridge.ran.length, 0, 'nothing reached the box');
  } finally { s.close(); }
});
