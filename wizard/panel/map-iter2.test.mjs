// map-iter2.test.mjs — panel iteration 2 (2026-08-23), R22: the Map draws
// "Crads AI · the Mountain" as the anchor whenever no rock anchors the mineral,
// and always above a rock. Evaluates netModel on fixture worlds rather than
// pinning strings. Run: node --test wizard/panel/map-iter2.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');
const server = readFileSync(join(HERE, 'panel-server.mjs'), 'utf8');

// netModel, lifted out of the page and given the two helpers it reaches for
function netModel() {
  const src = html.slice(html.indexOf('function netModel(w)'), html.indexOf('function netLayout(nodes)'));
  assert.ok(src.length > 200, 'netModel found');
  return new Function('netPresence', 'cap', src + '; return netModel;')(
    (ls) => ({ cls: ls ? 'ok' : '', txt: ls ? 'connected now' : 'no record yet' }),
    (s) => s,
  );
}
const model = netModel();
const pebble = (extra) => ({ ok: true, box: { label: 'Aster', tier: 'pebble', ownedByOrg: false, runs: 'crads-ai', ...(extra || {}) } });

test('a pebble no rock anchors draws the Mountain above it, wired anchored (R22)', () => {
  const nodes = model({ ...pebble({ mountain: true }), org: null, orgs: [] });
  assert.equal(nodes.length, 2, 'the Mountain and you: never a lone card');
  const m = nodes.find((n) => n.kind === 'mountain');
  assert.ok(m, 'a mountain node exists');
  assert.equal(m.id, 'anchor');
  assert.equal(m.role, 'anchor', 'it sits where an anchor rock would');
  assert.equal(m.label, 'Crads AI · the Mountain');
  assert.match(m.fact, /^Hosts and bills this mineral directly$/);
  assert.match(m.tag, /▲/, 'the tag carries the mountain glyph');
  const you = nodes.find((n) => n.me);
  assert.equal(you.rock, 'anchor', 'you hang off the Mountain');
  assert.equal(you.wire, 'anchored', 'and the wire says so');
});

test('the hint is inferred from the absence of an anchor even when the server did not send it', () => {
  const nodes = model({ ...pebble(), org: null, orgs: [] });
  assert.equal(nodes.filter((n) => n.kind === 'mountain').length, 1);
  assert.equal(nodes.length, 2);
});

test('an anchored pebble draws its rock, not the Mountain', () => {
  const nodes = model({ ...pebble({ ownedByOrg: true, mountain: false }), org: { label: 'Acme CoLab' },
    orgs: [{ label: 'Acme CoLab', tie: 'anchored', status: 'active' }, { label: 'Harbour Guild', tie: 'joined', status: 'active' }] });
  assert.equal(nodes.filter((n) => n.kind === 'mountain').length, 0, 'no mountain when a rock anchors');
  const a = nodes.find((n) => n.role === 'anchor');
  assert.equal(a.kind, 'rock');
  assert.equal(a.label, 'Acme CoLab');
  assert.equal(nodes.filter((n) => n.role === 'joinedAbove').length, 1, 'joined rocks still draw above');
  assert.equal(nodes.find((n) => n.me).wire, 'owns', 'the ownership wire is untouched');
});

test('a rock is always anchored to the Mountain, so its map draws it above the rock', () => {
  const nodes = model({ ok: true, rock: true, box: { label: 'acme', tier: 'rock', mountain: true },
    org: { label: 'Crads AI', anchor: true },
    orgs: [{ label: 'Crads AI', tie: 'anchored', status: 'active' }, { label: 'Shenanigans', tie: 'joined', status: 'active' }],
    fleet: [{ slug: 'jane01', label: 'Jane Doe', tie: 'anchored', status: 'active', last_seen: new Date().toISOString() }] });
  const ms = nodes.filter((n) => n.kind === 'mountain');
  assert.equal(ms.length, 1, 'one Mountain');
  assert.match(ms[0].fact, /this rock directly/);
  assert.equal(nodes.filter((n) => n.role === 'anchor').length, 1, 'the Crads AI org row is not drawn a second time as a rock');
  assert.equal(nodes.filter((n) => n.role === 'joinedAbove').length, 1);
  assert.equal(nodes.find((n) => n.me).wire, 'anchored');
  // the legacy single-org shape (an older server) still resolves to the Mountain
  const legacy = model({ ok: true, rock: true, box: { label: 'acme', tier: 'rock' }, org: { label: 'Crads AI', anchor: true }, fleet: [] });
  assert.equal(legacy.filter((n) => n.kind === 'mountain').length, 1);
});

test('the Mountain has its own quiet style in the iteration-2 block, and the stage no longer goes lone for it', () => {
  const block = html.slice(html.indexOf('/* ===== iteration 2: sharing / map / organisations ===== */'), html.indexOf('</style>', html.indexOf('/* ===== iteration 2')));
  assert.match(block, /#netMap \.nbx\[data-kind="mountain"\]\{[^}]*border-style:dashed/, 'dashed border');
  assert.ok(!/var\(--accent\)/.test(block.match(/#netMap \.nbx\[data-kind="mountain"\]\{[^}]*\}/)[0]), 'no accent: terracotta is action only');
  // the renderer stamps data-kind from the node, so the style reaches it
  assert.match(html, /data-kind="' \+ n\.kind \+ '"/);
});

test('the server sends the hint: worldFacts marks a mineral with no anchored rock, the rock world always', () => {
  const wf = server.slice(server.indexOf('function worldFacts'), server.indexOf('async function topologyWorld'));
  assert.match(wf, /mountain: !anchorOrg/, 'a pebble: the Mountain iff no rock remains after crads-ai is stripped');
  const ow = server.slice(server.indexOf('async function orgTopologyWorld'), server.indexOf('async function devicesSelfHeal'));
  assert.match(ow, /mountain: true/, 'a rock: always');
});
