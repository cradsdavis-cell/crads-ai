// map-iter2.test.mjs — the Map's model after the face collapse (2026-09-01).
// Iteration 2 (2026-08-23, R22) taught netModel to draw "Crads AI · the
// Mountain" above any unanchored mineral. The Mountain died with the hosted
// model: nothing hosts a self-hosted mineral, so the map is the you-card plus
// one dashed joined card per community the mineral belongs to, drawn from the
// mineral's own community list. Evaluates netModel on fixtures rather than
// pinning strings. Run: node --test wizard/panel/map-iter2.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');
const server = readFileSync(join(HERE, 'panel-server.mjs'), 'utf8');

// netModel, lifted out of the page. It reads the joined communities from the
// app's own state rather than from the world payload, so the fixture state
// rides in as an argument.
function netModel(communities) {
  const src = html.slice(html.indexOf('function netModel(w)'), html.indexOf('function netLayout(nodes)'));
  assert.ok(src.length > 200, 'netModel found');
  return new Function('state', src + '; return netModel;')({ communities });
}
const world = { ok: true, box: { label: 'Aster', tier: 'pebble', origin: 'self', framework: '' } };

test('a mineral in no community is one card: you, owner, on your own server', () => {
  const nodes = netModel([])(world);
  assert.equal(nodes.length, 1, 'the you-card stands alone; there is nothing above it');
  const you = nodes[0];
  assert.equal(you.me, true);
  assert.equal(you.label, 'Aster');
  assert.equal(you.fact, 'You own this mineral · on your own server');
  assert.equal(you.tag, 'your mineral');
});

test('the Mountain is RETIRED (2026-09-01): no fixture can summon it', () => {
  // R22's hint fields (mountain, org, orgs, fleet) mean nothing to the model
  // any more; a stale server sending them draws no extra node.
  const nodes = netModel([])({ ...world, mountain: true,
    org: { label: 'Crads AI', anchor: true },
    orgs: [{ label: 'Crads AI', tie: 'anchored', status: 'active' }],
    fleet: [{ slug: 'jane01', label: 'Jane Doe' }] });
  assert.equal(nodes.length, 1, 'still just you');
  assert.equal(nodes.filter((n) => n.kind === 'mountain').length, 0, 'no mountain node exists');
  assert.equal(nodes.filter((n) => n.role === 'anchor').length, 0, 'no anchor of any kind');
});

test('each joined community draws one dashed card above you', () => {
  const nodes = netModel([
    { org: 'harbour-guild', org_display: 'Harbour Guild' },
    { org: 'shenanigans' },
  ])(world);
  assert.equal(nodes.length, 3, 'you plus one card per community');
  const joined = nodes.filter((n) => n.role === 'joinedAbove');
  assert.equal(joined.length, 2);
  assert.equal(joined[0].label, 'Harbour Guild', 'the display name wins when the commons sent one');
  assert.equal(joined[1].label, 'shenanigans', 'and the handle stands in when it did not');
  for (const j of joined) {
    assert.equal(j.wire, 'joined', 'the wire is the dashed joined wire');
    assert.equal(j.wiresTo, 'you');
    assert.equal(j.tag, 'community');
    assert.equal(j.fact, 'A commons this mineral pulls · your mineral stays yours');
  }
});

test('the joined wire stays dashed on the stage', () => {
  assert.match(html, /#netMap svg\.nwires line\.njoinwire\{stroke-dasharray:4 4\}/);
});

test('the server world carries no hint to draw anything above the box', () => {
  // worldFacts is facts the box states about itself: box, devices, support.
  // The mountain flag, the org row and the fleet all died with the hosted
  // model, and the rock-world synthesis is gone whole.
  const wf = server.slice(server.indexOf('function worldFacts'), server.indexOf('async function topologyWorld'));
  assert.doesNotMatch(wf, /mountain/, 'no mountain hint');
  assert.doesNotMatch(wf, /orgs:/, 'no org rows');
  assert.doesNotMatch(wf, /fleet/, 'no fleet');
  assert.ok(!server.includes('orgTopologyWorld'), 'the rock world synthesis stays gone');
});
