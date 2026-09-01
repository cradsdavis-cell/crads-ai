// run-ledger.test.mjs — the box's run history (spec 2026-08-04 § 5): append,
// rotation, per-skill/per-job joins, the summary extractor, and the heartbeat
// filter that keeps summary text on the box.
//   node --test engine/lib/run-ledger.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendRun, readRuns, lastRunBySkill, lastOkRunBySkill, lastRunByJob, summarize, tailForHeartbeat, LEDGER_KEEP } from './run-ledger.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const mkBox = () => tmpDir('ledger-');

test('append + read round-trips, newest-last, junk lines skipped', () => {
  const state = mkBox();
  appendRun(state, { job: 'skill /daily', skill: 'daily', status: 'ok', summary: 'Brief written.' });
  appendRun(state, { job: 'backup', status: 'fail', error: 'disk full' });
  const runs = readRuns(state);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].skill, 'daily');
  assert.equal(runs[0].status, 'ok');
  assert.equal(runs[1].job, 'backup');
  assert.equal(runs[1].status, 'fail');
  assert.equal(runs[1].error, 'disk full');
  assert.equal(runs[1].skill, null);
});

test('a failed append never throws (observability must not fail a run)', () => {
  assert.equal(appendRun('/nonexistent-root-path-hopefully/x', { job: 'y' }), null);
});

test('rotation keeps the newest LEDGER_KEEP entries', () => {
  const state = mkBox();
  for (let i = 0; i < LEDGER_KEEP + 150; i++) appendRun(state, { job: 'skill /tick', skill: 'tick', status: 'ok', summary: 'n' + i });
  const runs = readRuns(state);
  assert.ok(runs.length <= LEDGER_KEEP + 100, `rotated (got ${runs.length})`);
  assert.equal(runs[runs.length - 1].summary, 'n' + (LEDGER_KEEP + 149), 'newest entry survives');
  const text = readFileSync(join(state, 'cockpit', 'run-ledger.jsonl'), 'utf8');
  assert.ok(!text.includes('"n0"'), 'oldest entry rotated away');
});

test('lastRunBySkill / lastRunByJob return the newest entry per key', () => {
  const state = mkBox();
  appendRun(state, { job: 'skill /daily', skill: 'daily', status: 'fail', error: 'x' });
  appendRun(state, { job: 'skill /daily', skill: 'daily', status: 'ok', summary: 'second time lucky' });
  appendRun(state, { job: 'backup', status: 'ok' });
  assert.equal(lastRunBySkill(state).daily.summary, 'second time lucky');
  assert.equal(lastRunByJob(state).backup.status, 'ok');
  assert.ok(!lastRunByJob(state)['skill /daily'], 'skill rows never leak into the machinery join');
});

test('lastOkRunBySkill keeps the last run that WORKED, not the last run', () => {
  // The distinction the heartbeat's skill_ok_runs is built on, and the case the
  // first cut got wrong: newest-per-skill filtered to ok DROPS this skill
  // entirely, because its newest row is the failure. A mineral whose Claude
  // sign-in died on Tuesday looks exactly like this, and Tuesday is the answer.
  const state = mkBox();
  appendRun(state, { ts: '2026-08-11T09:00:00.000Z', job: 'skill /daily', skill: 'daily', status: 'ok', summary: 'brief written' });
  appendRun(state, { ts: '2026-08-19T09:00:00.000Z', job: 'skill /daily', skill: 'daily', status: 'fail', error: 'Invalid API key' });
  assert.equal(lastRunBySkill(state).daily.status, 'fail', 'the newest row is still the failure');
  assert.equal(lastOkRunBySkill(state).daily.ts, '2026-08-11T09:00:00.000Z',
    'and the newest SUCCESS survives it, which is the number a stall board can act on');
});

test('a skill that has never finished is absent, and that is not the same as never run', () => {
  const state = mkBox();
  appendRun(state, { job: 'skill /daily', skill: 'daily', status: 'fail', error: 'boom' });
  assert.equal(lastOkRunBySkill(state).daily, undefined,
    'nothing is claimed for a skill with no successful run in the window');
  assert.ok(lastRunBySkill(state).daily, 'while the run itself is still on the record, as a failure');
});

test('summarize prefers the ## Summary line, else the last non-empty line, one line always', () => {
  assert.equal(summarize('did things\n\n## Summary\nThree priorities set, one conflict flagged.\nmore detail'), 'Three priorities set, one conflict flagged.');
  assert.equal(summarize('line one\nline two  \n\n'), 'line two');
  assert.equal(summarize(''), '');
  assert.equal(summarize('a\nb'.padEnd(500, 'x')).length <= 200, true);
  assert.ok(!summarize('## Summary\nmulti  \n  space').includes('\n'));
});

test('tailForHeartbeat: status only, machinery on the floor, skill rows gated', () => {
  const runs = [
    { ts: 't1', job: 'backup', skill: null, status: 'ok', summary: 'SECRET-ish text' },
    { ts: 't2', job: 'skill /daily', skill: 'daily', status: 'ok', summary: 'private summary' },
  ];
  const open = tailForHeartbeat(runs, { shareEngagement: true });
  assert.equal(open.length, 2);
  assert.ok(!('summary' in open[0]) && !('error' in open[0]), 'summary text never rides the heartbeat');
  const closed = tailForHeartbeat(runs, { shareEngagement: false });
  assert.deepEqual(closed.map((r) => r.job), ['backup'], 'skill rows withheld with engagement off; machinery floor stays');
});
