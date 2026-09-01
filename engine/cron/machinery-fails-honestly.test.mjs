// machinery-fails-honestly.test.mjs: a machinery job that FAILED must say so.
//   node --test engine/cron/machinery-fails-honestly.test.mjs
//
// 2026-08-20 audit. Ten of the jobs in scheduler.mjs ended their bash line with
// `|| true`, so the shell exited 0 whatever the job did, and the ledger write in
// fire() is `status: e ? 'fail' : 'ok'`. Every one of those ten therefore
// recorded ok on every run, forever.
//
// It was not a theoretical loss. engine/comms/mcp-refresh.mjs and
// engine/gh-token-refresh.mjs both go out of their way to exit non-zero when a
// member's Gmail connection or GitHub sign-in can no longer be renewed, the
// second under a comment saying in as many words that calling a broken hour a
// good one is how a dead mineral kept reading green. Both exits were swallowed
// one layer up. The run ledger, the Machinery card on the member's own Health
// page and the rock's stall board all read those minerals as fine.
//
// These tests DRIVE THE REAL SCHEDULER rather than grepping it, because the
// grep-shaped version of this test is what the `|| true` would have passed: the
// job was scheduled, it was named, it ran, and the only thing wrong was the one
// character of its exit status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHED = join(HERE, 'scheduler.mjs');
const ENGINE = join(HERE, '..');

// The scheduler emits ONE heartbeat at first start whatever the minute, and that
// job shells <state>/heartbeat-push.sh when the file exists. So a stand-in script
// there is a real machinery job, running on the real cadence path, with an exit
// status we choose. Same lever engine/cron/scheduler.test.mjs uses for the log.
function boxWithPush(body) {
  const dir = tmpDir('machfail-');
  writeFileSync(join(dir, 'profile.yaml'), 'identity:\n  timezone: "UTC"\ncadence:\n  enabled: false\n');
  if (body !== null) writeFileSync(join(dir, 'heartbeat-push.sh'), body);
  return dir;
}

function runScheduler(dir, env = {}, ms = 3000) {
  return new Promise((resolve) => {
    const p = spawn('node', [SCHED, dir], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { out += c; });
    setTimeout(() => { p.kill('SIGKILL'); resolve(out); }, ms);
  });
}

const heartbeatRows = (dir) => {
  const f = join(dir, 'cockpit', 'run-ledger.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').trimEnd().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((r) => r.job === 'heartbeat');
};

test('THE REGRESSION: a machinery job that exits non-zero is recorded as a failure', async () => {
  // Before the fix this row read {"status":"ok"} with the job's own protest,
  // "push denied", sitting in the summary field beside it.
  const dir = boxWithPush('#!/bin/sh\necho "push denied (membership closed?)"\nexit 4\n');
  await runScheduler(dir);
  const rows = heartbeatRows(dir);
  assert.equal(rows.length, 1, 'the job ran exactly once at first start');
  assert.equal(rows[0].status, 'fail',
    'a job that exited 4 was recorded as ok, which is the whole defect: ' + JSON.stringify(rows[0]));
  assert.match(rows[0].summary, /push denied/, 'and what it actually said is kept beside the verdict');
});

test('a machinery job that works is still recorded as ok', async () => {
  // The other half. A fix that made everything red would be the same failure
  // upside down: an always-red board is read exactly as carefully as an
  // always-green one, which is not at all.
  const dir = boxWithPush('#!/bin/sh\necho "pushed."\nexit 0\n');
  await runScheduler(dir);
  const rows = heartbeatRows(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'ok');
});

test('a box the job does not apply to stays silent, exactly as before', async () => {
  // This is what `|| true` was reaching for and got wrong. The presence test
  // exits 0 when there is nothing to push, so the job is a true no-op: still ok,
  // and node never spawns for the second leg at all.
  const dir = boxWithPush(null);
  const out = await runScheduler(dir);
  const rows = heartbeatRows(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'ok', 'no push script is not a failure, it is a box with nothing to push');
  // The job's own output lines, which logOutput prefixes with the job name. The
  // emitter ran and said what it found; the guarded second leg never ran, so it
  // said nothing at all.
  const said = out.split('\n').filter((l) => /\]   heartbeat: /.test(l)).join('\n');
  assert.match(said, /credential=/, 'the emitter still ran');
  assert.ok(!/push/.test(said), 'and nothing from the push leg reached the log, because it never started');
});

test('the FIRST command of a two-command job carries its own exit, not the last one', async () => {
  // The heartbeat job is `emit; push`, and the shell reports the LAST command.
  // Without an explicit `|| exit $?` on the emitter, a mineral that could not
  // write its heartbeat at all still reported a good run purely because the push
  // leg afterwards had nothing to complain about.
  //
  // AIOS_ENGINE_DIR moves the job's script paths without moving the scheduler's
  // own imports, so heartbeat.mjs is missing while the push script is fine. The
  // kernel dir is created because fire() runs jobs with cwd there, and a missing
  // cwd would fail the job for a different reason and pass this test on a lie.
  const engine = tmpDir('noemit-');
  mkdirSync(join(engine, 'kernel'), { recursive: true });
  const dir = boxWithPush('#!/bin/sh\nexit 0\n');
  await runScheduler(dir, { AIOS_ENGINE_DIR: engine });
  const rows = heartbeatRows(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'fail',
    'the emitter failed and the push succeeded, and the job reported the push: ' + JSON.stringify(rows[0]));
});

// ---------------------------------------------------------------- the invariant
//
// Behaviour is proven above on one job. This is the rule for the other nine, and
// it is written as an invariant rather than a list of names so that a job added
// next month is covered without anyone remembering to add it here.

test('no machinery job ends its shell with an unconditional `|| true`', () => {
  // COMMENTS ARE STRIPPED FIRST, and the first draft of this test did not do
  // that, so it failed on the block comment in scheduler.mjs that QUOTES the old
  // shape while explaining it. Same trap wizard/panel/member-fleet-restale.test
  // records for finding 166: a naive scan reads the description of the defect as
  // the defect. Assert on the code.
  const code = readFileSync(SCHED, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l));
  const offenders = code.filter((l) => /\|\| true`/.test(l));
  assert.deepEqual(offenders.map((l) => l.trim().slice(0, 90)), [],
    'a trailing `|| true` throws the job\'s exit status away and the ledger then records ok unconditionally');
});

test('the guard is a presence test that exits 0, the shape reconcile already used', () => {
  const src = readFileSync(SCHED, 'utf8');
  // Named jobs, because each of these guards a DIFFERENT thing and getting the
  // subject of the test wrong is how a job becomes a permanent no-op (finding
  // 153) or a permanent failure.
  const needs = [
    ['heartbeat', /\[ -f \$\{stateDir\}\/heartbeat-push\.sh \] \|\| exit 0;/],
    ['org-sync', /\[ -f \$\{stateDir\}\/org-sync\.sh \] \|\| exit 0;/],
    ['custody-watch', /\[ -f \$\{stateDir\}\/ownership\.json \] \|\| exit 0; node \$\{path\.join\(ENGINE_DIR, 'box', 'custody-watch/],
    ['seen-drain', /\[ -f \$\{stateDir\}\/devices\/seen\.log \] \|\| exit 0; node \$\{path\.join\(ENGINE_DIR, 'devices', 'seen-drain/],
    ['mcp-refresh', /\[ -f \$\{stateDir\}\/\.kernel\/mcp-oauth\.json \] \|\| exit 0; node \$\{path\.join\(ENGINE_DIR, 'comms', 'mcp-refresh/],
    ['google-rekey', /\[ -f \$\{stateDir\}\/\.kernel\/mcp-oauth\.json \] \|\| exit 0; node \$\{path\.join\(ENGINE_DIR, 'comms', 'google-rekey/],
    ['gh-token-refresh', /\[ -f \$\{stateDir\}\/\.kernel\/gh\/device-refresh\.json \] \|\| exit 0;/],
    ['org-pull', /\[ -d \$\{stateDir\}\/org\/brain\/\.git \] \|\| exit 0;/],
  ];
  for (const [name, re] of needs) {
    assert.match(src, re, `${name} must guard on what it needs and exit 0 when the box has not got it`);
  }
  // (broker-register used to be the tenth entry here; it left with the
  // self-host strip 2026-09-01 — it registered the org route at the central
  // directory, which is deleted.)
});

test('the two jobs that deliberately fail still deliberately fail', () => {
  // The scheduler no longer swallows a non-zero exit. That is only worth
  // anything while these two keep producing one, so pin the other end of the
  // wire: both were written with the run ledger in mind.
  const mcp = readFileSync(join(ENGINE, 'comms', 'mcp-refresh.mjs'), 'utf8');
  assert.match(mcp, /process\.exit\(failed\.length \? 1 : 0\)/,
    'a connection that could not be refreshed is a failed run, and the member only finds out from this');
  const gh = readFileSync(join(ENGINE, 'gh-token-refresh.mjs'), 'utf8');
  assert.match(gh, /process\.exit\(r\.refused \|\| r\.expired \|\| r\.storeFailed \? 1 : 0\)/,
    'a GitHub sign-in that cannot be renewed needs a human, and nothing else on the box will say so');
});


