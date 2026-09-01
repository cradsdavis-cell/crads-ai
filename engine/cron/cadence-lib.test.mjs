// cadence-lib.test.mjs — the v2 schedule model (spec 2026-08-04 § 4). These are
// the rules that run unattended on every box at 3am; they get the heavy harness.
//   node --test engine/cron/cadence-lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCadence, normalizeEntry, scheduleMatches, scheduleProblem,
  describeSchedule, migrateProfileCadence, buildJobsFromCadence, inQuiet, EVERY_FLOOR_MIN,
} from './cadence-lib.mjs';

const at = (hour, minute, dow = 1, ymd = '2026-08-03', quiet = '') => ({ hour, minute, dow, ymd, quiet });

// ---- v1 back-compat ----------------------------------------------------------

test('v1 daily/weekly/off shapes read as v2 without moving anything', () => {
  const v1 = {
    'morning-thing': { enabled: true, when: 'daily', time: '07:30' },
    'week-thing': { enabled: true, when: 'weekly', time: '09:00' },
    'off-thing': { enabled: false, when: 'off', time: '10:00' },
  };
  const cad = normalizeCadence(v1);
  assert.equal(cad.version, 2);
  assert.deepEqual(cad.jobs['morning-thing'].schedule, { kind: 'times', days: [], times: ['07:30'] });
  // the old weekly hardcode was Monday; the migration must preserve it, not move it
  assert.deepEqual(cad.jobs['week-thing'].schedule, { kind: 'times', days: ['mon'], times: ['09:00'] });
  assert.equal(cad.jobs['off-thing'].enabled, false);
  assert.equal(cad.jobs['off-thing'].schedule.times[0], '10:00', 'the off entry keeps its time for the editor');
});

test('non-kebab ids and junk entries are dropped; junk roots normalize empty', () => {
  const cad = normalizeCadence({ 'BAD ID': { enabled: true, when: 'daily' }, ok: { enabled: true, when: 'daily', time: '08:00' }, weird: 'string' });
  assert.deepEqual(Object.keys(cad.jobs), ['ok']);
  assert.deepEqual(normalizeCadence(null).jobs, {});
  assert.deepEqual(normalizeCadence([1, 2]).jobs, {});
});

// ---- kind: times ---------------------------------------------------------------

test('times: fires on listed days at each listed time, and only there', () => {
  const s = { kind: 'times', days: ['mon', 'thu'], times: ['07:00', '16:30'] };
  assert.ok(scheduleMatches(s, at(7, 0, 1)), 'Mon 07:00');
  assert.ok(scheduleMatches(s, at(16, 30, 4)), 'Thu 16:30');
  assert.ok(!scheduleMatches(s, at(7, 0, 2)), 'not Tue');
  assert.ok(!scheduleMatches(s, at(7, 1, 1)), 'not 07:01');
});

test('times: empty days means every day', () => {
  const s = { kind: 'times', days: [], times: ['12:00'] };
  for (let d = 0; d < 7; d++) assert.ok(scheduleMatches(s, at(12, 0, d)));
});

// ---- kind: every ---------------------------------------------------------------

test('every: interval from midnight, quiet hours respected by default', () => {
  const s = { kind: 'every', minutes: 120 };
  assert.ok(scheduleMatches(s, at(14, 0)));
  assert.ok(!scheduleMatches(s, at(14, 1)));
  assert.ok(!scheduleMatches(s, at(2, 0, 1, '2026-08-03', '22:00-07:00')), 'suppressed inside overnight quiet');
  assert.ok(scheduleMatches({ kind: 'every', minutes: 120, quiet: false }, at(2, 0, 1, '2026-08-03', '22:00-07:00')),
    'quiet:false opts out explicitly');
});

test('every: the 30-minute floor is a hard validity rule', () => {
  assert.match(String(scheduleProblem({ kind: 'every', minutes: 5 })), />= 30/);
  assert.equal(scheduleProblem({ kind: 'every', minutes: EVERY_FLOOR_MIN }), null);
  assert.ok(!scheduleMatches({ kind: 'every', minutes: 5 }, at(0, 5)), 'an invalid schedule never fires');
});

// ---- kind: every-days ------------------------------------------------------------

test('every-days: anchored day arithmetic in the box calendar', () => {
  const s = { kind: 'every-days', n: 3, time: '09:00', anchor: '2026-08-01' };
  assert.ok(scheduleMatches(s, { ...at(9, 0), ymd: '2026-08-01' }), 'the anchor day itself');
  assert.ok(scheduleMatches(s, { ...at(9, 0), ymd: '2026-08-04' }), '+3');
  assert.ok(!scheduleMatches(s, { ...at(9, 0), ymd: '2026-08-05' }), '+4');
  assert.ok(!scheduleMatches(s, { ...at(9, 0), ymd: '2026-07-29' }), 'never before the anchor');
  assert.ok(!scheduleMatches(s, { ...at(9, 1), ymd: '2026-08-04' }), 'wrong minute');
});

// ---- validity ---------------------------------------------------------------------

test('scheduleProblem names every malformation', () => {
  assert.equal(scheduleProblem({ kind: 'times', days: [], times: ['07:00'] }), null);
  assert.match(String(scheduleProblem({ kind: 'times', days: ['funday'], times: ['07:00'] })), /unknown day/);
  assert.match(String(scheduleProblem({ kind: 'times', days: [], times: [] })), /no times/);
  assert.match(String(scheduleProblem({ kind: 'times', days: [], times: ['25:00'] })), /malformed time/);
  assert.match(String(scheduleProblem({ kind: 'every-days', n: 0, time: '09:00', anchor: '2026-08-01' })), /positive/);
  assert.match(String(scheduleProblem({ kind: 'every-days', n: 2, time: '09:00', anchor: 'yesterday' })), /YYYY-MM-DD/);
  assert.match(String(scheduleProblem({ kind: 'cron', expr: '* * * * *' })), /unknown schedule kind/);
});

// ---- profile fold-in ---------------------------------------------------------------

const PROFILE = { enabled: true, mh: 7, mm: 0, eh: 18, em: 0, watch: 0, wdow: 0, wh: 17, wmin: 0 };

test('fold-in seeds the four profile jobs once, member entries win, flag stops re-runs', () => {
  const first = migrateProfileCadence({ daily: { enabled: true, when: 'daily', time: '06:45' } }, PROFILE, { anchorYmd: '2026-08-04' });
  assert.equal(first.changed, true);
  const jobs = first.cadence.jobs;
  assert.deepEqual(jobs.daily.schedule.times, ['06:45'], 'the member already owned daily; the seed must not overwrite it');
  assert.deepEqual(jobs.capture.schedule.times, ['18:00']);
  assert.deepEqual(jobs.weekly.schedule, { kind: 'times', days: ['sun'], times: ['17:00'] });
  assert.equal(jobs.weekly.deliver, true);
  assert.equal(jobs.inbox.enabled, false, 'watch=0 seeds the inbox entry OFF');
  assert.equal(jobs.inbox.schedule.kind, 'every');
  const again = migrateProfileCadence(first.cadence, PROFILE, { anchorYmd: '2026-08-05' });
  assert.equal(again.changed, false, 'the flag makes the fold-in run exactly once');
});

test('fold-in respects profile cadence.enabled=false and an active watcher', () => {
  const off = migrateProfileCadence({}, { ...PROFILE, enabled: false }, { anchorYmd: '2026-08-04' });
  assert.equal(off.cadence.jobs.daily.enabled, false, 'profile cadence off seeds entries disabled, not absent');
  const watch = migrateProfileCadence({}, { ...PROFILE, watch: 45 }, { anchorYmd: '2026-08-04' });
  assert.equal(watch.cadence.jobs.inbox.enabled, true);
  assert.equal(watch.cadence.jobs.inbox.schedule.minutes, 45);
  const low = migrateProfileCadence({}, { ...PROFILE, watch: 10 }, { anchorYmd: '2026-08-04' });
  assert.equal(low.cadence.jobs.inbox.schedule.minutes, 30, 'a sub-floor watcher is clamped to the floor');
});

// ---- job building --------------------------------------------------------------------

test('buildJobsFromCadence: only enabled+valid entries fire, deliver rides along', () => {
  const raw = { version: 2, jobs: {
    good: { enabled: true, deliver: true, schedule: { kind: 'times', days: [], times: ['07:00'] } },
    off: { enabled: false, schedule: { kind: 'times', days: [], times: ['07:00'] } },
    broken: { enabled: true, schedule: { kind: 'every', minutes: 1 } },
  } };
  const jobs = buildJobsFromCadence(raw, { quiet: '' });
  assert.deepEqual(jobs.map((j) => j.skill), ['good']);
  assert.equal(jobs[0].deliver, true);
  assert.ok(jobs[0].match(7, 0, 3, '2026-08-05'));
  assert.ok(!jobs[0].match(7, 1, 3, '2026-08-05'));
});

test('v1 file through buildJobsFromCadence behaves exactly like the old scheduler', () => {
  const jobs = buildJobsFromCadence({ pulse: { enabled: true, when: 'weekly', time: '10:00' } });
  assert.equal(jobs.length, 1);
  assert.ok(jobs[0].match(10, 0, 1, '2026-08-03'), 'Monday, the old hardcode');
  assert.ok(!jobs[0].match(10, 0, 2, '2026-08-04'), 'not Tuesday');
});

// ---- helpers ------------------------------------------------------------------------

test('inQuiet handles overnight windows; describeSchedule stays one line', () => {
  assert.ok(inQuiet('22:00-07:00', 23, 30));
  assert.ok(inQuiet('22:00-07:00', 3, 0));
  assert.ok(!inQuiet('22:00-07:00', 12, 0));
  assert.equal(describeSchedule({ kind: 'times', days: ['mon', 'thu'], times: ['07:00'] }), 'mon+thu 07:00');
  assert.equal(describeSchedule({ kind: 'every', minutes: 60 }), 'every 60m (quiet-aware)');
  assert.equal(describeSchedule({ kind: 'every-days', n: 3, time: '09:00', anchor: '2026-08-01' }), 'every 3d 09:00 (from 2026-08-01)');
  assert.match(describeSchedule({ kind: 'nope' }), /^invalid/);
});
