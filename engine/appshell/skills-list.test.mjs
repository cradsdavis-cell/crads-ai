// skills-list.test.mjs — the Skills system page's data source (P1 of the
// skills/cadence/library spec, 2026-08-04). Fixture boxes in tmp; the engine
// catalog is faked via AIOS_ENGINE_SKILLS_DIR so classification is deterministic.
//   node --test engine/appshell/skills-list.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';

// Fake engine catalog BEFORE importing the module (it reads env at import time).
const fakeEngine = tmpDir('sk-engine-');
writeFileSync(join(fakeEngine, 'daily.md'), '---\nname: daily\n---\n');
writeFileSync(join(fakeEngine, 'capture.md'), '---\nname: capture\n---\n');
process.env.AIOS_ENGINE_SKILLS_DIR = fakeEngine;
const { listSkills, CATEGORIES } = await import('./skills-list.mjs');

function mkBox() {
  const state = tmpDir('sk-state-');
  mkdirSync(join(state, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(state, 'cockpit'), { recursive: true });
  return state;
}
function addSkill(state, id, { fm = '', yaml = null, origin = null } = {}) {
  const d = join(state, '.claude', 'skills', id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${id}\n${fm}\n---\n\n# Skill: /${id}\n`);
  if (yaml !== null) writeFileSync(join(d, 'skill.yaml'), yaml);
  if (origin !== null) writeFileSync(join(d, '.origin.json'), JSON.stringify(origin));
}

test('engine-synced skill classifies as engine, category from frontmatter', () => {
  const state = mkBox();
  addSkill(state, 'daily', { fm: 'description: Morning brief.\ncategory: briefing        # comment' });
  const out = listSkills(state);
  assert.equal(out.skills.length, 1);
  const s = out.skills[0];
  assert.equal(s.source, 'engine');
  assert.equal(s.category, 'briefing');
  assert.equal(s.description, 'Morning brief.');
});

test('org skill with .origin.json carries rock + version and wins classification', () => {
  const state = mkBox();
  addSkill(state, 'pricing-review', {
    fm: 'description: Reviews pricing.',
    yaml: 'id: pricing-review\nversion: 3\ndescription: "Reviews pricing."\ncategory: comms\ncadence:\n  default: "weekly"\n  time: "09:00"\ngate: ""\noutbound: false\n',
    origin: { rock: 'acme-collab', version: 3, installed: '2026-08-01' },
  });
  const s = listSkills(state).skills[0];
  assert.equal(s.source, 'org');
  assert.equal(s.rock, 'acme-collab');
  assert.equal(s.version, 3);
  assert.equal(s.category, 'comms');
  assert.equal(s.cadence_default, 'weekly');
});

test('legacy org install (skill.yaml, no origin marker) still classifies as org', () => {
  const state = mkBox();
  addSkill(state, 'legacy-skill', { yaml: 'id: legacy-skill\nversion: 1\ndescription: "old"\n' });
  const s = listSkills(state).skills[0];
  assert.equal(s.source, 'org');
  assert.equal(s.rock, '');
  assert.equal(s.version, 1);
});

test('seed ids classify as seed; unknown ids as member; bad category falls to other', () => {
  const state = mkBox();
  addSkill(state, 'eod', { fm: 'description: End of day.\ncategory: capture' });
  addSkill(state, 'my-own-thing', { fm: 'description: Mine.\ncategory: nonsense' });
  const by = Object.fromEntries(listSkills(state).skills.map((s) => [s.id, s]));
  assert.equal(by['eod'].source, 'seed');
  assert.equal(by['my-own-thing'].source, 'member');
  assert.equal(by['my-own-thing'].category, 'other');
});

test('outbound flag reads from skill.yaml; cadence + runs pass through; empty box is empty', () => {
  const state = mkBox();
  addSkill(state, 'sender', { yaml: 'id: sender\nversion: 1\noutbound: true\n' });
  writeFileSync(join(state, 'cockpit', 'cadence.json'), JSON.stringify({ sender: { enabled: true, when: 'daily', time: '08:00' } }));
  writeFileSync(join(state, 'cockpit', 'skill-runs.json'), JSON.stringify({ sender: '2026-08-04T07:00:00Z' }));
  const out = listSkills(state);
  assert.equal(out.skills[0].outbound, true);
  assert.equal(out.cadence.sender.when, 'daily');
  assert.equal(out.runs.sender, '2026-08-04T07:00:00Z');

  const empty = mkBox();
  const eout = listSkills(empty);
  assert.deepEqual(eout.skills, []);
  assert.deepEqual(eout.cadence, {});
});

test('dot-dirs, uppercase and skill-less dirs are skipped', () => {
  const state = mkBox();
  addSkill(state, 'good-one', { fm: 'description: ok' });
  mkdirSync(join(state, '.claude', 'skills', 'No-SKILL-md-here'), { recursive: true });
  mkdirSync(join(state, '.claude', 'skills', '_template'), { recursive: true });
  writeFileSync(join(state, '.claude', 'skills', '_template', 'SKILL.md'), 'x');
  const out = listSkills(state);
  assert.deepEqual(out.skills.map((s) => s.id), ['good-one']);
});

test('the category vocabulary is the spec six', () => {
  assert.deepEqual(CATEGORIES, ['briefing', 'capture', 'comms', 'box', 'org', 'other']);
});
