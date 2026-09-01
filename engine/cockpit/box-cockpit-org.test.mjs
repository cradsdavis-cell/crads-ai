// box-cockpit-org.test.mjs — org mode (2026-08-09, unification stage S3).
// The same builder serves both faces: a rock (org-policy.yaml at its resolved
// brain_root) gets its identity from the org policy, onboarding from the
// BRAIN's state file, and a graph scoped to the wiki proper, never machinery.
// Run: node --test engine/cockpit/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILDER = join(HERE, 'box-cockpit.mjs');

function buildRock({ deployment = true } = {}) {
  const box = tmpDir('cc-org-');
  const br = join(box, 'brain');
  mkdirSync(br, { recursive: true });
  if (deployment) writeFileSync(join(box, 'deployment.yaml'), `brain_root: "${br}"\n`);
  writeFileSync(join(br, 'org-policy.yaml'),
    'org:\n  name: "acme-collab"\n  display_name: "Acme CoLab"\n  persona: "Iris"\n');
  writeFileSync(join(br, 'onboarding-state.json'), JSON.stringify({
    phase: 'interview', scope: 'rock', current_layer: '2-philosophy',
    layers: {
      '1-north-star': { status: 'covered' }, '2-philosophy': { status: 'in-progress' },
      '3-self': { status: 'not-started' }, '4-network': { status: 'not-started' },
      '5-past': { status: 'not-started' }, '6-goals': { status: 'not-started' },
      '7-tasks': { status: 'not-started' }, '8-workflow': { status: 'not-started' },
    },
  }));
  // wiki proper: a root page + notes/, linked so the graph has an edge
  writeFileSync(join(br, 'priorities.md'), '# Priorities\n\nSee [[north-star]].\n');
  mkdirSync(join(br, 'notes'), { recursive: true });
  writeFileSync(join(br, 'notes', 'north-star.md'), '# North star\n\nWhy this org exists.\n');
  // machinery that must NEVER become a graph node
  mkdirSync(join(br, 'registry'), { recursive: true });
  writeFileSync(join(br, 'registry', 'stray.md'), '# not a page\n');
  mkdirSync(join(br, 'orchestrator'), { recursive: true });
  writeFileSync(join(br, 'orchestrator', 'readme.md'), '# machinery\n');
  // an installed skill, counted on both faces
  mkdirSync(join(box, '.claude', 'skills', 'daily'), { recursive: true });
  writeFileSync(join(box, '.claude', 'skills', 'daily', 'SKILL.md'), '---\ntitle: Daily\n---\n');
  execFileSync(process.execPath, [BUILDER, box], { encoding: 'utf8' });
  return JSON.parse(readFileSync(join(box, 'cockpit', 'data.json'), 'utf8'));
}

test('a rock brain builds identity from the org policy, onboarding from the brain', () => {
  const d = buildRock();
  // ONE NAME (2026-08-14, docs/naming.md). This used to pin assistant = the
  // org PERSONA, which is how a rock its owner had named "Acme CoLab"
  // introduced itself on its own Overview as "Iris". A rock's assistant is
  // called what the rock is called; persona survives only as a derived mirror.
  assert.equal(d.assistant, 'Acme CoLab', "assistant = the rock's own name, not a separate persona");
  assert.equal(d.pebble, 'Acme CoLab', 'pebble = display name, never the bare org name');
  assert.equal(d.tier, 'rock');
  assert.equal(d.business, null, 'a rock has no business block');
  assert.equal(d.onboarding.total, 8);
  assert.equal(d.onboarding.covered, 1, 'covered counted from the BRAIN state file');
  assert.equal(d.onboarding.current, '2-philosophy');
});

test('the org graph keeps to the wiki proper; machinery dirs never become nodes', () => {
  const d = buildRock();
  const ids = d.graph.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['notes/north-star', 'priorities'], 'root page + notes/, nothing else');
  assert.ok(d.graph.links.some((l) =>
    (l.source === 'priorities' && l.target === 'notes/north-star')
    || (l.source === 'notes/north-star' && l.target === 'priorities')), 'wikilinks still resolve');
  assert.ok(!ids.some((i) => i.startsWith('registry/') || i.startsWith('orchestrator/')),
    'registry/ and orchestrator/ are machinery, not brain');
});

test('skills.installed is counted on the box, both faces', () => {
  const d = buildRock();
  assert.equal(d.skills.installed, 1);
});

test('brain_root defaults to <box>/brain when deployment.yaml is absent', () => {
  const d = buildRock({ deployment: false });
  assert.equal(d.assistant, 'Acme CoLab', 'org detection still fires at the default root');
});

test('dashboard-data is importable by the org face (SELF_VERBS crossing, non-mutating)', async () => {
  const src = readFileSync(join(HERE, '..', '..', 'wizard', 'panel', 'panel-server.mjs'), 'utf8');
  const selfVerbs = (src.split('const SELF_VERBS')[1] || '').split('];')[0];
  assert.ok(selfVerbs.includes("'dashboard-data'"), 'dashboard-data rides SELF_VERBS into ORG_VERBS');
  const { MEMBER_VERBS } = await import('../../wizard/panel/panel-server.mjs');
  assert.ok(!MEMBER_VERBS['dashboard-data'].mutating, 'and stays read-only, so no adminOnly rewrite');
});

test('a rock reports the brain root it walked, and does not call it missing', () => {
  const d = buildRock();
  assert.equal(d.brain.root_missing, false, 'org mode looks in the right place');
  assert.match(d.brain.root, /brain$/, 'and that place is the brain root, never <box>/wiki');
});
