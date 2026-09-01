// ledger-survives-rotation.test.mjs — a completed run must not read as
// never-finished once the ledger rotates.
// Run: node --test engine/lib/ledger-survives-rotation.test.mjs
//
// Why this file exists. The Skills and Cadence pages join a skill's outcome out
// of the run ledger, which keeps the newest 500 rows. Machinery alone appends
// about 867 rows a day on a member box (org-sync fires every even minute, plus
// reconcile, heartbeat, org-pull and the nightlies), so the visible window is
// under fourteen hours.
//
// That was survivable while the page fell back to "last ran <when>" from the
// fire stamp. On 2026-08-05 the fallback was corrected to say "started … no
// result recorded yet", because a stamp is written when a skill is FIRED and a
// deferred run was reading as completed. Correct for that case — and it turned
// the eviction into a lie pointing the other way: a run that succeeded on
// Sunday read as never-finished for the rest of the week, because the flood
// that proves the ledger is alive is the same flood that destroys the evidence.
//
// So a skill's newest outcome now lives in a side map that rotation cannot
// touch: one row per skill, a dozen or so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendRun, lastRunBySkill, readRuns, LEDGER_KEEP } from './run-ledger.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const box = () => tmpDir('ledger-');

test('a skill outcome survives a full day of machinery', () => {
  const d = box();
  appendRun(d, { job: 'skill /weekly', skill: 'weekly', status: 'ok', summary: 'wrote the review' });
  for (let i = 0; i < LEDGER_KEEP + 200; i++) appendRun(d, { job: 'org-sync', skill: null, status: 'ok' });

  assert.ok(!readRuns(d).some((r) => r.skill === 'weekly'), 'the ledger really has rotated it out');
  const last = lastRunBySkill(d);
  assert.ok(last.weekly, 'but the page can still find it');
  assert.equal(last.weekly.status, 'ok');
  assert.equal(last.weekly.summary, 'wrote the review', 'including what it actually did');
});

test('a newer outcome replaces an older one', () => {
  const d = box();
  appendRun(d, { job: 'skill /daily', skill: 'daily', status: 'fail', error: 'claude exited 1', ts: '2026-08-01T07:00:00.000Z' });
  appendRun(d, { job: 'skill /daily', skill: 'daily', status: 'ok', summary: 'brief sent', ts: '2026-08-02T07:00:00.000Z' });
  const last = lastRunBySkill(d);
  assert.equal(last.daily.status, 'ok', 'the newest run is the one that counts');
  assert.equal(last.daily.summary, 'brief sent');
});

test('a failure is remembered as faithfully as a success', () => {
  const d = box();
  appendRun(d, { job: 'skill /pulse', skill: 'pulse', status: 'fail', error: 'no sheet configured' });
  for (let i = 0; i < LEDGER_KEEP + 200; i++) appendRun(d, { job: 'heartbeat', skill: null, status: 'ok' });
  const last = lastRunBySkill(d);
  assert.equal(last.pulse.status, 'fail');
  assert.equal(last.pulse.error, 'no sheet configured', 'the member is told WHY, not just that it did not work');
});

test('machinery never enters the side map: it is one row per skill, not a second ledger', () => {
  const d = box();
  for (let i = 0; i < 50; i++) appendRun(d, { job: 'org-sync', skill: null, status: 'ok' });
  appendRun(d, { job: 'skill /daily', skill: 'daily', status: 'ok' });
  const side = JSON.parse(readFileSync(join(d, 'cockpit', 'last-skill-runs.json'), 'utf8'));
  assert.deepEqual(Object.keys(side), ['daily'], 'bounded by the number of skills, not by time');
});

test('a box whose engine predates the side map still answers from the ledger', () => {
  const d = box();
  appendRun(d, { job: 'skill /inbox', skill: 'inbox', status: 'ok', summary: 'triaged 4' });
  writeFileSync(join(d, 'cockpit', 'last-skill-runs.json'), '');   // as if it had never been written
  assert.equal(lastRunBySkill(d).inbox.summary, 'triaged 4');
});

test('a corrupt side map never takes the pages down', () => {
  const d = box();
  appendRun(d, { job: 'skill /inbox', skill: 'inbox', status: 'ok' });
  writeFileSync(join(d, 'cockpit', 'last-skill-runs.json'), '{not json');
  assert.doesNotThrow(() => lastRunBySkill(d));
  assert.ok(lastRunBySkill(d).inbox, 'and still finds what the ledger holds');
});

test('an empty box is simply empty', () => {
  assert.deepEqual(lastRunBySkill(box()), {});
});
