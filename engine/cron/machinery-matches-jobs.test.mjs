// The machinery the app SHOWS must be the machinery this process RUNS.
//   node --test engine/cron/machinery-matches-jobs.test.mjs
//
// Finding 86 (2026-08-12). machineryRows() returned a hardcoded array of the
// seven MEMBER jobs regardless of role, while the job list itself is filtered by
// ROCK_JOBS to four. On a rock the overlap was ZERO: the owner was shown seven
// jobs that had never run on their box, badged ON, and the four that do run were
// invisible. Measured on qa-base-gllm's ledger, 587 entries: enrol-sync 339,
// grants 135, broker 68, reconcile 45. Not one of the seven appeared.
//
// It also under-reported the MEMBER: a pebble runs 14 jobs and the card listed 7.
//
// The fix derives the rows from the filtered job list, so the two cannot
// disagree. These tests assert that INVARIANT rather than a list of names: a
// list-based test would pass again the moment someone re-hardcodes it, which is
// exactly how this survived. The card's own comment claimed "what the member sees
// is what this process will actually do" throughout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const SCHEDULER = join(dirname(fileURLToPath(import.meta.url)), 'scheduler.mjs');

function mkBox() {
  const state = tmpDir('machinery-');
  mkdirSync(join(state, 'cockpit'), { recursive: true });
  writeFileSync(join(state, 'profile.yaml'),
    'identity:\n  timezone: "Australia/Sydney"\ncadence:\n  enabled: true\n');
  return state;
}
const plan = (state, role) => JSON.parse(execFileSync('node', [SCHEDULER, state, '--plan-json'], {
  encoding: 'utf8',
  env: { ...process.env, ...(role ? { AIOS_SCHEDULER_ROLE: role } : {}) },
}));

// What a rock actually runs, from ROCK_JOBS in scheduler.mjs. Named here
// because THE REGRESSION is specifically about a rock being shown member jobs.
// 'adopt' joined 2026-08-14 and LEFT with the self-host strip (2026-09-01):
// the Mountain no longer builds pebbles for a rock, so no adoption debt exists.
// 'enrol-sync', 'broker', 'grants' (proof drain) and 'edges-reflect' left in the
// same strip: all four were clients of the deleted central directory. What
// replaced enrol-sync on both tiers is 'seen-drain', the local last-seen stamp.
// 'state-md' joined 2026-08-23 (R24): a rock rewrites its own STATE.md hourly,
// because the member heartbeat that does it on a pebble never runs on a rock.
const ROCK_IDS = ['reconcile', 'seen-drain', 'heartbeat-pull', 'state-md'];
// Jobs that exist only for a member. Any of these on a rock is finding 86.
const MEMBER_ONLY = ['heartbeat', 'org-sync', 'org-pull', 'org-publish', 'backup', 'brain-push', 'auto-update'];

test('THE REGRESSION: a rock is never shown a job it does not run', () => {
  const rows = plan(mkBox(), 'rock').machinery.map((r) => r.id);
  for (const id of MEMBER_ONLY) {
    assert.ok(!rows.includes(id),
      `a rock was shown "${id}", which ROCK_JOBS never admits. That is finding 86: rows=${rows.join(',')}`);
  }
});

test('a rock is shown every job it DOES run, and only those', () => {
  const rows = plan(mkBox(), 'rock').machinery.map((r) => r.id).sort();
  assert.deepEqual(rows, [...ROCK_IDS].sort(),
    'the rock card must be exactly the ROCK_JOBS set: hiding a running job is the other half of the bug');
});

test('a member is shown MORE than the seven the old card hardcoded', () => {
  // The old list was seven. A pebble runs fourteen, so seven of its jobs were
  // invisible to its owner. This pins the under-report, not an exact count,
  // because jobs get added and the point is that the card follows.
  const rows = plan(mkBox(), null).machinery;
  assert.ok(rows.length > 7,
    `a member should see every job it runs, got ${rows.length}: ${rows.map((r) => r.id).join(',')}`);
  for (const id of ROCK_IDS) {
    assert.ok(rows.some((r) => r.id === id), `a member runs ${id} too, so it must be listed`);
  }
});

test('every row is identifiable, badgeable and explained', () => {
  // org-publish declares no `lid`, and an id-less row is one the card cannot key
  // or badge. A silent omission is the failure this whole fix is about.
  for (const role of ['rock', null]) {
    for (const r of plan(mkBox(), role).machinery) {
      assert.ok(r.id && String(r.id).trim(), `row without an id on role=${role}: ${JSON.stringify(r)}`);
      assert.ok(r.note && String(r.note).trim(), `row without a note: ${JSON.stringify(r)}`);
      assert.ok(r.when && String(r.when).trim(), `row without a schedule: ${JSON.stringify(r)}`);
    }
  }
});

test('the schedule shown is read off the job, not restated by hand', () => {
  // These come from the match functions: seen-drain m%2, reconcile m%15. If
  // someone re-hardcodes the display, these drift and this fails, which is the
  // whole point.
  const by = Object.fromEntries(plan(mkBox(), 'rock').machinery.map((r) => [r.id, r.when]));
  assert.equal(by['seen-drain'], 'every 2 min');
  assert.equal(by.reconcile, 'every 15 min');
});

test('a job that cannot fire says so instead of inventing a time', () => {
  // org-publish returns false unless /state/org/config.json exists. The old card
  // claimed "02:2x" for it regardless. An unconfigured job should read honestly.
  const row = plan(mkBox(), null).machinery.find((r) => r.id === 'org-publish');
  assert.ok(row, 'org-publish should still be listed');
  assert.equal(row.when, 'never',
    'an unconfigured job must not advertise a time it will not keep');
});

// ---------------------------------------------------------------------------
// THE READ PATH MUST CARRY THE ROLE (finding 86, re-opened 2026-08-13).
//
// Everything above passes the role in itself, so it proves the scheduler is
// right and proves nothing about the caller. Production never passed it:
// panel-server's `cadence-list` verb ran `node scheduler.mjs /state --plan-json`
// bare, so on a ROCK the plan fell to the default role and answered with the
// MEMBER's 14 jobs. The Health card renders exactly those rows, badged ON, under
// "shown so nothing runs invisibly", above the word "All good".
//
// Measured on qa-r2-gmail, born through the door on 2026-08-13: the card listed
// 14 while the box's own run-ledger held four job names across 26 entries
// (enrol-sync 15, grants 6, broker 3, reconcile 2).
//
// So the fix landed where the bug was diagnosed and the bug came back through
// the surface that reads it. This test guards the CALLER, which is the half that
// was never covered.
import { readFileSync as _read } from 'node:fs';
const PANEL = _read(new URL('../../wizard/panel/panel-server.mjs', import.meta.url), 'utf8');

test('the panel verb that feeds the Health card asks with a role', () => {
  // Anchored on the EMITTED string, not the first mention: the word also
  // appears in the comment block 46 lines above, and slicing from there read
  // prose instead of the command.
  const i = PANEL.indexOf('echo "__PLANJSON__"');
  assert.ok(i > 0, 'the cadence-list verb still emits a __PLANJSON__ section');
  const seg = PANEL.slice(i, i + 500);
  assert.match(seg, /AIOS_SCHEDULER_ROLE=/,
    'invoking --plan-json without a role gives a ROCK the member plan, which IS finding 86');
  assert.match(seg, /ownership\.json/,
    'and the role must come from the box’s own record, not be assumed by the caller');
  // The fallback direction matters: unreadable must mean `member`, which can only
  // over-report. Defaulting to `rock` would HIDE jobs that really run, which is
  // the other half of finding 86 and the worse half.
  assert.match(seg, /__ROLE=member/, 'an unreadable ownership record falls back to member');
});

// --- finding 101: the rock must actually PULL the health it displays ---------
//
// control/heartbeat-pull.mjs fills heartbeats/<slug>.json, which is the only
// thing the stall board reads. Its header always said "run on a rock cron", and
// it was in no job list at all: a live rock's ledger showed zero runs of it,
// ever. The result was not a blank page but a false one — every active member
// rendered AT RISK · "never checked in", permanently, however healthy, and one
// manual run flipped a real member to the truthful reason inside a minute.
test('101: a rock runs the heartbeat puller its own fleet page depends on', () => {
  // The brain script must EXIST for this to mean anything: presence in the row
  // list is not the property under test, a real schedule is. Without the script
  // the job resolves to "never", and a test asserting only presence would pass
  // against a puller that can never fire.
  const state = mkBox();
  mkdirSync(join(state, 'brain', 'control'), { recursive: true });
  writeFileSync(join(state, 'brain', 'control', 'heartbeat-pull.mjs'), '// stub\n');

  const row = plan(state, 'rock').machinery.find((r) => r.id === 'heartbeat-pull');
  assert.ok(row, 'a rock must pull member heartbeats or its Pebbles page is fiction');
  assert.notEqual(row.when, 'never', 'and it must carry a real schedule, not read as never');
  assert.match(row.when, /every 30 min/);
});

// A member's plan lists every job, so this must read HONESTLY there rather than
// advertise a puller a pebble can never run — which would be finding 86 again,
// committed while fixing 101.
test('101: on a box with no members, the puller reads "never", not ON', () => {
  const rows = plan(mkBox(), null).machinery;
  const row = rows.find((r) => r.id === 'heartbeat-pull');
  if (row) {
    assert.equal(row.when, 'never',
      'a box with no control/heartbeat-pull.mjs must not advertise a schedule it cannot keep');
  }
});

// --- finding 121: a scheduled job must not inherit a broken GH_CONFIG_DIR ----
//
// The 101 fix above put heartbeat-pull on the rock's schedule and it then FAILED
// on every single scheduled run for 15 hours, while succeeding every time by
// hand. The difference was one `:-`. The command shipped as
// `${GH_CONFIG_DIR:-<state>/.kernel/gh}`, and a `:-` default only fires when the
// variable is ABSENT. An interactive shell has no GH_CONFIG_DIR, so hand-runs
// took the default and worked. The scheduler's own environment DOES carry one:
// boot-rock.sh exports `$ROCK_DIR/gh` (/state/.rock/gh) into /etc/ai-os/env, and
// that directory is empty, while the app's Connect GitHub flow writes the real
// credential to /state/.kernel/gh. So the job inherited an empty gh config and
// died with "ORG_GH_OWNER + ORG_GH_TOKEN unresolved" every 30 minutes.
//
// Static, because the property is in the command STRING: the failure survived a
// green suite precisely because the tests above assert the job is SCHEDULED and
// never that its command can work.
test('121: heartbeat-pull hard-sets GH_CONFIG_DIR and never defers to the environment', () => {
  const src = readFileSync(SCHEDULER, 'utf8');
  const line = src.split('\n').find((l) => l.includes('heartbeat-pull.mjs') && l.includes('GH_CONFIG_DIR'));
  assert.ok(line, 'the heartbeat-pull command must still set GH_CONFIG_DIR');
  assert.doesNotMatch(line, /\$\{GH_CONFIG_DIR:-/,
    'a `:-` default never fires when the variable is present-and-wrong, which is exactly the rock case');
  assert.match(line, /GH_CONFIG_DIR="\$\{stateDir\}\/\.kernel\/gh"|GH_CONFIG_DIR="\/state\/\.kernel\/gh"/,
    'it must point at .kernel/gh, where the app\'s Connect GitHub flow writes the credential');
});

test('121: gh-token-refresh, the job that always worked, is still the pattern', () => {
  // Named so the two cannot drift apart again: being the odd one out is what
  // broke heartbeat-pull, so this asserts the precedent still holds.
  const src = readFileSync(SCHEDULER, 'utf8');
  const line = src.split('\n').find((l) => l.includes('gh-token-refresh.mjs'));
  assert.ok(line, 'gh-token-refresh must still exist');
  assert.doesNotMatch(line, /\$\{GH_CONFIG_DIR:-/, 'it has always hard-set the dir; keep it that way');
});

// --- finding 123, closed by the self-host strip (2026-09-01) -----------------
//
// edges-reflect wrote membership edges to the central directory, which is
// deleted; the job left the schedule with it. What must now hold is the
// NEGATIVE: no box, either tier, may still schedule the reflector.
test('123 (inverted): no tier schedules edges-reflect any more', () => {
  const state = mkBox();
  mkdirSync(join(state, 'brain', 'control'), { recursive: true });
  writeFileSync(join(state, 'brain', 'control', 'edges-reflect.mjs'), '// stale copy on an old brain\n');
  for (const role of ['rock', null]) {
    const row = plan(state, role).machinery.find((r) => r.id === 'edges-reflect');
    assert.ok(!row, `role=${role} still schedules edges-reflect, a client of the deleted directory`);
  }
});
