// layers.test.mjs: the onboarding seed is the 8 layers /onboard writes, on a
// box (init-state.mjs, run by box-up.sh) exactly as on a local folder.
//   node --test engine/onboarding/layers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { LAYERS, initialLayersState, isUntouchedLegacySeed } from './layers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('the layer ids are the ones onboard.md names, in order', () => {
  const md = readFileSync(join(HERE, '..', 'skills', 'onboard.md'), 'utf8');
  for (const id of LAYERS) assert.ok(md.includes(`wiki/_layers/${id}.md`), `onboard.md builds wiki/_layers/${id}.md`);
  assert.equal(LAYERS.length, 8);
});

test('init-state.mjs seeds 8 layers (person scope), and org scope when org-policy.yaml is present', () => {
  const box = tmpDir('init-state-');
  execFileSync(process.execPath, [join(HERE, 'init-state.mjs'), box]);
  const st = JSON.parse(readFileSync(join(box, 'onboarding-state.json'), 'utf8'));
  assert.deepEqual(st, initialLayersState());
  assert.equal(st.current_layer, '1-north-star');
  assert.ok(!st.modules, 'no legacy modules map: the dashboard used to count 11 of them');
  const rock = tmpDir('init-state-org-');
  writeFileSync(join(rock, 'org-policy.yaml'), 'x: 1\n');
  execFileSync(process.execPath, [join(HERE, 'init-state.mjs'), rock]);
  assert.equal(JSON.parse(readFileSync(join(rock, 'onboarding-state.json'), 'utf8')).scope, 'org');
});

test('isUntouchedLegacySeed: only an unanswered 11-module seed is replaceable', () => {
  const legacy = { phase: 'interview', current_module: 'self', modules: { self: { status: 'in-progress', raw: [] }, voice: { status: 'not-started', raw: [] } } };
  assert.equal(isUntouchedLegacySeed(legacy), true);
  assert.equal(isUntouchedLegacySeed({ ...legacy, modules: { self: { status: 'in-progress', raw: ['an answer'] } } }), false, 'answers are kept');
  assert.equal(isUntouchedLegacySeed({ ...legacy, phase: 'done' }), false);
  assert.equal(isUntouchedLegacySeed(initialLayersState()), false, 'the new shape is not legacy');
  assert.equal(isUntouchedLegacySeed(null), false);
});

// Adopt rehearsal T4, finding 10: an adopted brain's Overview read "0 of 8"
// beside "Complete" because --done flipped only the phase. The card's count is
// read from the layers by the very reader below (engine/cockpit/box-cockpit.mjs),
// so this runs it on the written file and checks the two agree.
test('init-state.mjs --done writes a finished state the Overview counts as 8 of 8, and marks it adopted', () => {
  const box = tmpDir('init-state-done-');
  execFileSync(process.execPath, [join(HERE, 'init-state.mjs'), box, '--done']);
  const st = JSON.parse(readFileSync(join(box, 'onboarding-state.json'), 'utf8'));
  assert.equal(st.phase, 'done');
  assert.equal(st.adopted, true);
  assert.equal(st.current_layer, null);
  assert.deepEqual(Object.keys(st.layers), LAYERS);
  for (const id of LAYERS) assert.deepEqual(st.layers[id], { status: 'covered', raw: [], synthesized: true, reviewed: true });
  // what the Overview card is handed: the count agrees with the phase
  execFileSync(process.execPath, [join(HERE, '..', 'cockpit', 'box-cockpit.mjs'), box], { encoding: 'utf8' });
  const ob = JSON.parse(readFileSync(join(box, 'cockpit', 'data.json'), 'utf8')).onboarding;
  assert.equal(ob.phase, 'done');
  assert.equal(ob.covered, ob.total, `"${ob.covered} of ${ob.total}" beside "Complete"`);
  assert.equal(ob.total, 8);
  // the interview seed is untouched by the adopted path
  assert.deepEqual(initialLayersState().phase, 'interview');
  // org scope still detected
  const rock = tmpDir('init-state-done-org-');
  writeFileSync(join(rock, 'org-policy.yaml'), 'x: 1\n');
  execFileSync(process.execPath, [join(HERE, 'init-state.mjs'), rock, '--done']);
  assert.equal(JSON.parse(readFileSync(join(rock, 'onboarding-state.json'), 'utf8')).scope, 'org');
});
