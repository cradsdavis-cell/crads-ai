// rock-brain-root.test.mjs: a ROCK fixture whose brain_root is NOT the state dir.
//
// This is the case every existing fixture misses, and missing it is why three
// separate bugs lived here at once. On a pebble the state dir IS the brain, so
// `path.join(stateDir, x)` and `path.join(brainRoot, x)` are the same string and
// a wrong one cannot fail. Only a rock separates them.
//
// What this pins, all from the 2026-08-11 report ("rock reports onboarding as
// 0 of 8 forever"):
//   1. the generator reads onboarding state from the BRAIN, not the state dir
//   2. it walks <brain_root>/wiki, where /onboard actually writes the layers and
//      the people, and files them under the same ids a pebble would get
//   3. heartbeat.mjs answers onboarded:true for a rock that has finished
//   4. the app never names an engine file the engine does not have
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '..');
const GEN = path.join(HERE, 'box-cockpit.mjs');
const HEARTBEAT = path.join(ENGINE, 'heartbeat.mjs');

const w = (p, s) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, s); };

/**
 * A rock exactly as boot-rock.sh leaves one: state at <box>, brain at
 * <box>/brain (named in deployment.yaml), org-policy.yaml marking it an org,
 * and a completed 8-layer /onboard written where the skill writes it.
 */
function rockFixture({ done = true } = {}) {
  const box = tmpDir('rock-');
  const brain = path.join(box, 'brain');
  w(path.join(box, 'deployment.yaml'), `deployment_name: acme\ndomain: example.test\nbrain_root: ${brain}\n`);
  w(path.join(brain, 'org-policy.yaml'), 'org:\n  display_name: "Test Rock 2"\n  assistant_name: "Foreman"\n');
  const layers = {};
  for (const n of ['north-star','philosophy','self','network','past','goals','tasks','workflow']) layers[n] = { status: 'covered' };
  w(path.join(brain, 'onboarding-state.json'),
    JSON.stringify({ phase: done ? 'done' : 'interview', layers }, null, 2));

  // Where /onboard writes, per engine/skills/onboard.md, in BOTH scopes.
  const names = ['1-north-star', '2-philosophy', '3-self', '4-network',
    '5-past', '6-goals', '7-tasks', '8-workflow'];
  names.forEach((n, i) => w(path.join(brain, 'wiki', '_layers', `${n}.md`),
    `# ${n}\n\nSee [[people/harriet]] for the network.\n`));
  w(path.join(brain, 'wiki', 'people', 'harriet.md'), '# Harriet\n\ntier: core\n\nBacked by [[_layers/4-network]].\n');
  w(path.join(brain, 'wiki', 'people', 'logan.md'), '# Logan\n\ntier: live\n');

  // The three pages a rock had BEFORE this fix, and the only ones it showed.
  w(path.join(brain, 'CLAUDE.md'), '# CLAUDE\n');
  w(path.join(brain, 'README.md'), '# README\n');
  w(path.join(brain, 'notes', 'README.md'), '# notes\n');
  return { box, brain };
}

const build = (box) => {
  execFileSync('node', [GEN, box], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(readFileSync(path.join(box, 'cockpit', 'data.json'), 'utf8'));
};

test('a finished rock reports its real step count and persona, not the empty state', () => {
  // The exact symptom: "ONBOARDING · 0 of 8 · current: getting started" and
  // "ASSISTANT · your assistant", both of which are the panel's fallbacks.
  const { box } = rockFixture();
  const d = build(box);
  assert.equal(d.tier, 'rock');
  assert.equal(d.onboarding.covered, 8, `expected 8 covered, got ${d.onboarding.covered}`);
  assert.equal(d.onboarding.total, 8);
  assert.equal(d.pebble, 'Test Rock 2', 'the org display name, never the fallback');
  assert.notEqual(d.assistant, 'your assistant', 'the pebble fallback must never appear on a rock');
});

test('the rock brain shows its layer and people pages, with the links between them', () => {
  // Before: pages 3, people 0, links 0 — CLAUDE.md, README.md, notes/README.md.
  const { box } = rockFixture();
  const d = build(box);
  assert.equal(d.brain.people, 2, `people should be counted, got ${d.brain.people}`);
  assert.ok(d.brain.pages >= 13, `8 layers + 2 people + 3 root pages, got ${d.brain.pages}`);
  assert.ok(d.graph.links.length > 0, 'the [[wikilinks]] between them resolve');
  assert.equal(d.brain.root_missing, false);
});

test('a rock files its pages under the same ids a pebble would', () => {
  // The reason <brain_root>/wiki is walked as its own root: `folder` is the first
  // path segment, so walking it from the brain root would file every person under
  // `wiki` and leave peopleCount at 0 while the pages appeared to be there.
  const { box } = rockFixture();
  const d = build(box);
  const ids = d.graph.nodes.map((n) => n.id);
  assert.ok(ids.includes('people/harriet'), `expected people/harriet among ${ids.slice(0, 12).join(', ')}`);
  assert.ok(ids.includes('_layers/4-network'), 'layer pages keep their _layers/ id');
  assert.ok(!ids.some((i) => String(i).startsWith('wiki/')), 'and nothing is filed under a wiki/ prefix');
});

test('a node’s path is what brain-read can open, even when its id is not', () => {
  // Finding 107's fourth reader (hit live 2026-08-17). The wiki walk keeps ids
  // wiki-relative for pebble parity — the test above pins that — but brain-read
  // cd's to the BRAIN ROOT on a rock, so the READ path for those same pages must
  // carry the wiki/ prefix. With path: p.rel the graph showed _layers/5-past.md,
  // invited a click, and the reader answered "no such page": every onboarded
  // page was visible and unopenable, the exact 107 symptom one door further in.
  // The public-brain toggle failed the same way: brain-public's page keys are
  // brain-root-relative, so the wiki-relative path never matched its list.
  const { box } = rockFixture();
  const d = build(box);
  const byId = new Map(d.graph.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get('_layers/5-past').path, 'wiki/_layers/5-past.md',
    'a wiki-walk page reads from wiki/…');
  assert.equal(byId.get('people/harriet').path, 'wiki/people/harriet.md');
  const claude = d.graph.nodes.find((n) => n.path === 'CLAUDE.md');
  assert.ok(claude, 'a brain-root page keeps its unprefixed read path');
});

test('the org root scope is unchanged: machinery dirs stay out', () => {
  // Adding the wiki must not turn the whole brain repo into pages.
  const { box, brain } = rockFixture();
  w(path.join(brain, 'registry', 'members', 'keith.md'), '# keith\n');
  w(path.join(brain, '.claude', 'skills', 'x', 'SKILL.md'), '# skill\n');
  const d = build(box);
  const ids = d.graph.nodes.map((n) => String(n.id));
  assert.ok(!ids.some((i) => i.startsWith('registry/')), 'registry is machinery, not pages');
  assert.ok(!ids.some((i) => i.includes('.claude/')), 'nor are the synced skills');
});

test('an unfinished rock still reports honestly', () => {
  const { box } = rockFixture({ done: false });
  const d = build(box);
  assert.equal(d.onboarding.covered, 8, 'coverage is counted from the layers, not the phase');
  assert.notEqual(d.onboarding.phase, 'done');
});

test('heartbeat reads the brain, so a finished rock is onboarded:true', () => {
  const { box } = rockFixture();
  execFileSync('node', [HEARTBEAT, box], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const hb = JSON.parse(readFileSync(path.join(box, 'cockpit', 'heartbeat-full.json'), 'utf8'));
  assert.equal(hb.onboarded, true, 'onboarding state lives under brain_root on a rock');
  assert.ok(hb.last_activity, 'and so does the wiki it derives activity from');
});

test('a pebble is unaffected: state dir and brain are the same directory', () => {
  // The regression guard in the other direction. Everything above would also pass
  // if the fix had simply moved every path to <state>/brain unconditionally.
  const box = tmpDir('pebble-');
  w(path.join(box, 'profile.yaml'), 'assistant_name: "Nova"\n');
  w(path.join(box, 'onboarding-state.json'), JSON.stringify({ phase: 'done', layers: { 'north-star': { status: 'covered' } } }));
  w(path.join(box, 'wiki', 'people', 'sam.md'), '# Sam\n');
  const d = build(box);
  assert.equal(d.tier, 'pebble');
  assert.equal(d.brain.people, 1);
  assert.equal(d.onboarding.covered, 1);
});

test('a member-born rock resolves its brain to the box itself (finding 107, reader five)', () => {
  // The promoted-rock shape, exactly as ingrid proved it 2026-08-17: empty
  // deployment.yaml, NO <box>/brain, org-policy.yaml and the wiki at the box
  // root. BR_RESOLVE and the org verbs learned the `/state` fallback that day;
  // this generator had not, so IS_ORG read false, the walk ran in pebble mode,
  // and every node path lost the wiki/ prefix the org brain-read needs — the
  // fourth reader's bug reborn one box-shape later.
  const box = tmpDir('promoted-');
  w(path.join(box, 'deployment.yaml'), '');
  w(path.join(box, 'org-policy.yaml'), 'org:\n  name: milk-and-honey\n  display_name: "Milk and Honey"\n');
  w(path.join(box, 'onboarding-state.json'), JSON.stringify({ phase: 'done', layers: { 'north-star': { status: 'covered' } } }));
  w(path.join(box, 'wiki', 'people', 'estelle-byrne.md'), '# Estelle Byrne\n\nSee [[6-goals]].\n');
  w(path.join(box, 'wiki', '_layers', '6-goals.md'), '# Goals\n\n[[people/estelle-byrne]]\n');
  const d = build(box);
  assert.equal(d.tier, 'rock', 'org-policy at the box root makes this a rock, not a pebble');
  assert.equal(d.pebble, 'Milk and Honey', 'identity reads the org policy, not a pebble profile');
  const byId = new Map(d.graph.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get('people/estelle-byrne').path, 'wiki/people/estelle-byrne.md',
    'the read path carries the wiki/ prefix the org brain-read resolves from the box root');
  assert.equal(byId.get('people/estelle-byrne').id, 'people/estelle-byrne',
    'while the id keeps pebble parity');
  assert.ok(d.graph.links.length > 0, 'the links between them still resolve');
});

test('a member-born rock with ONLY ownership.json is still an org (no policy file by design)', () => {
  // The real end-state of the 2026-08-17 self-registration flow, as Sam's own
  // promoted rock proved live: NO org-policy.yaml anywhere — the flip writes
  // ownership.json (tier "rock", the box-kind convention) and nothing else.
  // The policy-only IS_ORG built this box's graph in pebble mode: unprefixed
  // node paths against org verbs rooted at /state, the two panes disagreeing.
  const box = tmpDir('ownrock-');
  w(path.join(box, 'ownership.json'), JSON.stringify({ tier: 'rock', owner: 'org', owner_slug: 'milk-and-honey', anchor: 'crads-ai' }));
  w(path.join(box, 'box-name'), 'Institute of Shenanigans\n');
  w(path.join(box, 'onboarding-state.json'), JSON.stringify({ phase: 'done', layers: { 'north-star': { status: 'covered' } } }));
  w(path.join(box, 'wiki', 'people', 'estelle-byrne.md'), '# Estelle Byrne\n\nSee [[6-goals]].\n');
  w(path.join(box, 'wiki', '_layers', '6-goals.md'), '# Goals\n\n[[people/estelle-byrne]]\n');
  const d = build(box);
  assert.equal(d.tier, 'rock', 'ownership tier rock makes this an org without any policy file');
  const byId = new Map(d.graph.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get('people/estelle-byrne').path, 'wiki/people/estelle-byrne.md',
    'read paths carry the wiki/ prefix the org brain-read resolves from the box root');
  assert.equal(d.pebble, 'Institute of Shenanigans', 'the box name introduces the rock, never "state"');
  assert.notEqual(d.assistant, 'your assistant');
});

test('a plain pebble with an ownership.json that is NOT tier rock stays a pebble', () => {
  // ownership.json also exists on ordinary member boxes (owner: member); only
  // tier "rock" may flip the face, or every pebble becomes a phantom org.
  const box = tmpDir('ownpeb-');
  w(path.join(box, 'ownership.json'), JSON.stringify({ tier: 'member', owner: 'member' }));
  w(path.join(box, 'wiki', 'people', 'sam.md'), '# Sam\n');
  const d = build(box);
  assert.equal(d.tier, 'pebble');
  const byId = new Map(d.graph.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get('people/sam').path, 'people/sam.md', 'pebble paths stay unprefixed');
});
