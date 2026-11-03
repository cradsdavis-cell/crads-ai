// scheduler-plan.test.mjs — the scheduler's cadence-v2 face: the one-time
// profile fold-in, --plan-json (what the app's Cadence page renders), and the
// --at simulator. Runs the real CLI against a fixture box in tmp.
//   node --test engine/cron/scheduler-plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const SCHEDULER = join(dirname(fileURLToPath(import.meta.url)), 'scheduler.mjs');

function mkBox({ cadenceEnabled = true, watch = 0 } = {}) {
  const state = tmpDir('sched-');
  mkdirSync(join(state, 'cockpit'), { recursive: true });
  writeFileSync(join(state, 'profile.yaml'),
    'identity:\n  timezone: "Australia/Sydney"\n'
    + 'cadence:\n  enabled: ' + cadenceEnabled + '\n  morning_brief: "07:00"\n  evening_review: "18:00"\n'
    + '  weekly_review: "Sun 17:00"\n  inbox_watcher_interval_min: ' + watch + '\n  quiet_hours: "22:00-07:00"\n');
  return state;
}
const runCli = (state, ...args) => execFileSync('node', [SCHEDULER, state, ...args], { encoding: 'utf8' });

test('first run folds the four profile jobs into cadence.json exactly once', () => {
  const state = mkBox();
  runCli(state, '--plan');
  const cad = JSON.parse(readFileSync(join(state, 'cockpit', 'cadence.json'), 'utf8'));
  assert.equal(cad.version, 2);
  assert.equal(cad.migrated_profile_cadence, true);
  assert.deepEqual(cad.jobs.daily.schedule, { kind: 'times', days: [], times: ['07:00'] });
  assert.equal(cad.jobs.daily.deliver, true);
  assert.deepEqual(cad.jobs.weekly.schedule.days, ['sun']);
  assert.equal(cad.jobs.inbox.enabled, false, 'watch=0 seeds the inbox watcher OFF');
  // second run: the member's edits survive
  cad.jobs.daily.schedule.times = ['06:15'];
  writeFileSync(join(state, 'cockpit', 'cadence.json'), JSON.stringify(cad));
  runCli(state, '--plan');
  const cad2 = JSON.parse(readFileSync(join(state, 'cockpit', 'cadence.json'), 'utf8'));
  assert.deepEqual(cad2.jobs.daily.schedule.times, ['06:15'], 'the fold-in never runs twice');
});

test('--plan-json is the structured contract the Cadence page renders', () => {
  const state = mkBox();
  const out = JSON.parse(runCli(state, '--plan-json'));
  assert.equal(out.tz, 'Australia/Sydney');
  assert.equal(out.quiet_hours, '22:00-07:00');
  assert.ok(Number.isInteger(out.jitter_min) && out.jitter_min >= 0 && out.jitter_min < 30);
  const ids = out.machinery.map((m) => m.id);
  // THIS ASSERTION USED TO PIN EXACTLY SEVEN and called it "nothing runs
  // invisibly". Seven others were running invisibly underneath it: a member box
  // fires fourteen machinery jobs, and the card was a hand-written list of the
  // first seven. It was also role-blind, so a ROCK was shown all seven while
  // running NONE of them (finding 86, 2026-08-12; measured on a live ledger).
  //
  // A deepEqual on a hand-written list cannot catch that, because it IS the hand
  // written list. So assert the contract instead: the protected floor is present,
  // and the card is allowed to grow as jobs are added. The role invariant lives in
  // machinery-matches-jobs.test.mjs.
  for (const id of ['heartbeat', 'org-sync', 'org-pull', 'org-publish', 'backup', 'brain-push', 'auto-update']) {
    assert.ok(ids.includes(id), `the protected job ${id} must be visible — nothing runs invisibly. got: ${ids.join(',')}`);
  }
  assert.equal(new Set(ids).size, ids.length, 'no job is listed twice');
  for (const m of out.machinery) { assert.ok(m.when, `${m.id} carries a when`); assert.ok(m.note, `${m.id} carries a note`); }
  const daily = out.skills.find((s) => s.id === 'daily');
  assert.ok(daily && daily.enabled && daily.deliver, 'the folded-in profile jobs appear as member cadence');
  assert.equal(daily.desc, 'daily 07:00');
});

test('--plan-json respects the auto-update opt-out flag', () => {
  const state = mkBox();
  writeFileSync(join(state, 'cockpit', 'auto-update.json'), '{"enabled": false}');
  const out = JSON.parse(runCli(state, '--plan-json'));
  assert.equal(out.machinery.find((m) => m.id === 'auto-update').enabled, false);
});

// Trap 82 (2026-11-03): the scheduler restarted every member box every night,
// new software or not, and killed a member's five half-done video sessions.
// "The box should only restart when the user actually wants to update."
test('the overnight update is OFF by default and never fires; switched on, it only tries in the 04:10 to 05:59 window', () => {
  const state = mkBox();
  const off = JSON.parse(runCli(state, '--plan-json'));
  const au = off.machinery.find((m) => m.id === 'auto-update');
  assert.equal(au.enabled, false, 'no auto-update.json means off, not on');
  assert.equal(au.when, 'never', 'an off update has no minute it can fire');
  const fires = (t) => runCli(state, '--at', t).split('\n').find((l) => l.startsWith('At ')) || '';
  for (const t of ['04:10 Tue', '04:25 Tue', '04:39 Tue', '05:50 Tue']) {
    assert.doesNotMatch(fires(t), /auto-update/, `nothing restarts the box at ${t} unless the member asked`);
  }
  writeFileSync(join(state, 'cockpit', 'auto-update.json'), '{"enabled": true}');
  const on = JSON.parse(runCli(state, '--plan-json'));
  assert.equal(on.machinery.find((m) => m.id === 'auto-update').enabled, true);
  const j = on.jitter_min % 10;
  const two = (n) => String(n).padStart(2, '0');
  assert.match(fires(`05:${two(j)} Tue`), /auto-update/, 'switched on, it tries inside the window');
  assert.doesNotMatch(fires(`06:${two(j)} Tue`), /auto-update/, 'and never outside it');
  assert.doesNotMatch(fires(`04:0${j} Tue`), /auto-update/, 'nor before 04:10');
});

test('the update check and the temp tidy are listed, and neither can restart anything', () => {
  const state = mkBox();
  const out = JSON.parse(runCli(state, '--plan-json'));
  for (const id of ['update-check', 'tmp-tidy']) assert.ok(out.machinery.find((m) => m.id === id), `${id} is visible`);
  const src = readFileSync(SCHEDULER, 'utf8');
  const line = (id) => src.split('\n').find((l) => l.includes(`lid: '${id}'`));
  assert.doesNotMatch(line('update-check'), /kill/, 'a check never restarts');
  assert.doesNotMatch(line('tmp-tidy'), /kill|\.kernel\/home|brain/, 'the tidy touches temp only');
});

test('--at fires a v2 times schedule on its day and not off it', () => {
  const state = mkBox();
  runCli(state, '--plan');   // fold in first
  const cad = JSON.parse(readFileSync(join(state, 'cockpit', 'cadence.json'), 'utf8'));
  cad.jobs['my-review'] = { enabled: true, schedule: { kind: 'times', days: ['wed'], times: ['16:30'] } };
  writeFileSync(join(state, 'cockpit', 'cadence.json'), JSON.stringify(cad));
  // The --at output ends with one "At HH:MM (dow d): ..." firing line; the plan
  // listing above it names every enabled job, so assertions read the line only.
  const firing = (state2, when) => runCli(state2, '--at', when).split('\nAt ')[1] || '';
  assert.match(firing(state, '16:30 Wed'), /skill \/my-review/);
  assert.doesNotMatch(firing(state, '16:30 Thu'), /my-review/);
  assert.match(firing(state, '07:00 Wed'), /skill \/daily/, 'folded-in daily fires at its seeded time');
});

test('profile cadence disabled seeds entries switched off, and nothing skill-shaped fires', () => {
  const state = mkBox({ cadenceEnabled: false });
  const out = JSON.parse(runCli(state, '--plan-json'));
  const daily = out.skills.find((s) => s.id === 'daily');
  assert.ok(daily && !daily.enabled, 'seeded but off — visible in the editor, silent in the scheduler');
  assert.doesNotMatch(runCli(state, '--at', '07:00 Mon'), /skill \//);
});
