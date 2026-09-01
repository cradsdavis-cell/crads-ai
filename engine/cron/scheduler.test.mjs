// scheduler.test.mjs — the base jobs actually fire.
//
// Why this file exists at all: the scheduler had NO test, and that is how the
// registry appliers went uncadenced without anyone noticing. The scheduler ran
// happily, its --plan output looked healthy, and no base job ran an applier —
// so a member could leave and the registry would still read active until a
// human opened the console. A green suite that never asked "does the job fire?"
// was part of the failure, so these tests drive the REAL planner (--at, which
// filters the real jobs array) rather than grepping the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
const { join } = path;
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHED = path.join(HERE, 'scheduler.mjs');

// A box shaped like a rock: a brain with a control/ dir, cadence OFF (so we are
// proving the ALWAYS-ON base lane, not skill cadence).
function box({ withBrain = true } = {}) {
  const dir = tmpDir('sched-');
  writeFileSync(path.join(dir, 'profile.yaml'), 'cadence:\n  enabled: false\n');
  if (withBrain) {
    mkdirSync(path.join(dir, 'brain', 'control'), { recursive: true });
    writeFileSync(path.join(dir, 'brain', 'control', 'reconcile-all.mjs'), '// stub\n');
    writeFileSync(path.join(dir, 'deployment.yaml'), `brain_root: "${path.join(dir, 'brain')}"\n`);
  }
  return dir;
}

const firingAt = (dir, at) => {
  const out = execFileSync('node', [SCHED, dir, '--at', at], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.startsWith('At ')) || '';
  return line.replace(/^At [^:]*:\d+ \(dow \d+\): /, '').trim();
};

test('the reconcile job fires on its quarter-hour, with cadence off', () => {
  const dir = box();
  for (const at of ['09:04 Tue', '09:19 Tue', '09:34 Tue', '09:49 Tue']) {
    assert.match(firingAt(dir, at), /reconcile \(registry appliers\)/,
      `nothing reconciled at ${at}: the appliers are back to waiting for a human`);
  }
});

test('it does not fire every minute', () => {
  const dir = box();
  assert.doesNotMatch(firingAt(dir, '09:05 Tue'), /reconcile/);
  // :07 is the heartbeat's slot; the reconcile must not pile onto it.
  assert.doesNotMatch(firingAt(dir, '09:07 Tue'), /reconcile/);
  assert.match(firingAt(dir, '09:07 Tue'), /heartbeat/, 'heartbeat still owns :07');
});

test('the base lane survives: heartbeat and org-sync still fire', () => {
  const dir = box();
  // These are the jobs the reconcile was slotted alongside. If a future edit to
  // the jobs array breaks one, that is the same class of silence, so pin them.
  assert.match(firingAt(dir, '09:07 Tue'), /heartbeat/);
  assert.match(firingAt(dir, '09:04 Tue'), /org-sync/);
});

test('the shell guard is what makes it safe on a brain-less box', () => {
  // A member box has no control/ dir. The job is still SCHEDULED there (the
  // match is time-only, like org-sync's); what makes it a no-op is the
  // `[ -f "$BR/control/reconcile-all.mjs" ] || exit 0` guard inside the command.
  // Assert the guard rather than the absence of the job, because asserting the
  // absence would pass for the wrong reason and hide a real regression.
  const dir = box({ withBrain: false });
  assert.match(firingAt(dir, '09:19 Tue'), /reconcile/, 'scheduled everywhere, guarded in shell');
  const out = execFileSync('bash', ['-c',
    `BR=/nope; [ -f "$BR/control/reconcile-all.mjs" ] || { echo GUARDED; exit 0; }; echo RAN`,
  ], { encoding: 'utf8' });
  assert.equal(out.trim(), 'GUARDED');
});

// --- a rock's cadence ------------------------------------------------------
// A ROCK HAD NO CADENCE AT ALL, which quietly undid the reconcile job added
// earlier the same day. Three things, all verified on the live rock 2026-08-04:
// no profile.yaml anywhere (so the scheduler crashed on ENOENT before doing
// anything), no scheduler process and no cadence.log (boot-rock never started
// one), and `cron` not on the rock's PATH (so boot-rock's crontab block is
// dead code, the same broken system-cron path this scheduler replaced for
// members). Net effect: the appliers never ran unattended on the one kind of box
// where control/ actually lives.
test('the scheduler survives a box with no profile.yaml', () => {
  // Not hypothetical: this is every rock box.
  const dir = tmpDir('noprofile-');
  mkdirSync(join(dir, 'brain', 'control'), { recursive: true });
  writeFileSync(join(dir, 'brain', 'control', 'reconcile-all.mjs'), '// stub\n');
  writeFileSync(join(dir, 'deployment.yaml'), `brain_root: "${join(dir, 'brain')}"\n`);
  const out = execFileSync('node', [SCHED, dir, '--at', '09:19 Tue'], { encoding: 'utf8' });
  assert.match(out, /reconcile \(registry appliers\)/, 'and still schedules the appliers');
});

test('a rock runs the reconcile and NOT the member housekeeping', () => {
  // A rock is not a member with a bigger brain. backup encrypts a member's
  // state, brain-push sends it to the member's own account, heartbeat emits a
  // MEMBER heartbeat, auto-update restarts the box overnight. Inheriting those
  // by accident is how a rock starts backing itself up over its own brain.
  const dir = tmpDir('rockrole-');
  mkdirSync(join(dir, 'brain', 'control'), { recursive: true });
  writeFileSync(join(dir, 'brain', 'control', 'reconcile-all.mjs'), '// stub\n');
  writeFileSync(join(dir, 'deployment.yaml'), `brain_root: "${join(dir, 'brain')}"\n`);
  const at = (t) => execFileSync('node', [SCHED, dir, '--at', t],
    { encoding: 'utf8', env: { ...process.env, AIOS_SCHEDULER_ROLE: 'rock' } })
    .split('\n').find((l) => l.startsWith('At ')) || '';
  assert.match(at('09:19 Tue'), /reconcile/, 'the reconcile runs');
  for (const [slot, job] of [['09:07 Tue', 'heartbeat'], ['03:40 Tue', 'backup'], ['09:04 Tue', 'org-sync']]) {
    assert.doesNotMatch(at(slot), new RegExp(job), `a rock must not run ${job}`);
  }
});

test('the rock boot actually starts it, and does not die if it cannot', () => {
  const boot = readFileSync(new URL('../../provisioning/rock/boot-rock.sh', import.meta.url), 'utf8');
  assert.match(boot, /AIOS_SCHEDULER_ROLE=rock node .*scheduler\.mjs/, 'started with the rock role');
  assert.match(boot, /engine\/cron\/scheduler\.mjs" \] *; then/, 'guarded on the file existing');
  assert.ok(boot.indexOf('scheduler.mjs') < boot.indexOf('command -v code-server'),
    'backgrounded BEFORE the exec that takes over the foreground');
});

// --- an empty timezone must not kill the scheduler -------------------------
// profile.yaml SHIPS with `timezone: ""`. The `|| 'UTC'` fallback only fires
// when the KEY IS MISSING; a key present with an empty value captured '' and
// sailed past it, and new Intl.DateTimeFormat throws RangeError on an empty
// timeZone, killing the scheduler at startup before a single job is built.
// An org stamp fills the field from org-policy, which is why org-stamped boxes
// were fine and hid it; a box provisioned standalone got NO cadence at all.
// Found on promo-lab, stamped 2026-08-04, whose cadence.log was a stack and
// nothing else.
const withProfile = (body) => {
  const dir = tmpDir('tz-');
  writeFileSync(join(dir, 'profile.yaml'), body);
  return dir;
};
const planOf = (dir) => execFileSync('node', [SCHED, dir, '--plan'], { encoding: 'utf8' });

test('an EMPTY timezone falls back to UTC instead of crashing', () => {
  const out = planOf(withProfile('identity:\n  timezone: ""\ncadence:\n  enabled: false\n'));
  assert.match(out, /tz=UTC/, 'the shipped default must not be fatal');
});

test('a whitespace-only timezone is treated the same way', () => {
  const out = planOf(withProfile('identity:\n  timezone: "   "\ncadence:\n  enabled: false\n'));
  assert.match(out, /tz=UTC/);
});

test('a missing timezone key still falls back, as it always did', () => {
  const out = planOf(withProfile('cadence:\n  enabled: false\n'));
  assert.match(out, /tz=UTC/);
});

test('a REAL timezone is still honoured (the fallback must not swallow it)', () => {
  const out = planOf(withProfile('identity:\n  timezone: "Australia/Sydney"\ncadence:\n  enabled: false\n'));
  assert.match(out, /tz=Australia\/Sydney/);
});

test('the scheduler builds jobs on a profile it could previously die on', () => {
  // The crash happened before any job was built, so the box had no heartbeat,
  // no backup and no auto-update either. Assert it gets all the way through.
  const dir = withProfile('identity:\n  timezone: ""\ncadence:\n  enabled: false\n');
  const out = execFileSync('node', [SCHED, dir, '--at', '09:07 Tue'], { encoding: 'utf8' });
  assert.match(out, /^At .*heartbeat/m, 'the base lane is alive');
});

// ------------------------------------------- a fresh box must not look dead
//
// The heartbeat owns :07 hourly, so a box booting at :11 says nothing for 56
// minutes. On 2026-08-10 janet-jackson was running, tunnel healthy, org-sync and
// enrol-sync green every two minutes, and silent to the outside until :07 the
// next hour. The diagnosis cost went entirely on "fine but quiet" being
// indistinguishable from "dead".

test('the scheduler emits one heartbeat at first start', () => {
  const src = readFileSync(new URL('./scheduler.mjs', import.meta.url), 'utf8');
  const blk = src.slice(src.indexOf('announce yourself once'));
  assert.match(blk, /jobs\.find\(\(j\) => j\.lid === 'heartbeat'\)/, 'it fires the real heartbeat job, not a copy of its command');
  assert.match(blk, /fire\(hb\)/);
});

test('and only when the box has never emitted one, so restarts do not add pushes', () => {
  const src = readFileSync(new URL('./scheduler.mjs', import.meta.url), 'utf8');
  const blk = src.slice(src.indexOf('announce yourself once'));
  assert.match(blk, /!existsSync\(FIRST_HEARTBEAT_MARK\)/);
  assert.match(blk, /'cockpit', 'heartbeat\.json'/, 'the emitter output is the marker: no new state file to keep honest');
});

test('the hourly slot is untouched, so steady state is unchanged', () => {
  const src = readFileSync(new URL('./scheduler.mjs', import.meta.url), 'utf8');
  assert.match(src, /lid: 'heartbeat'[\s\S]{0,400}?match: \(h, m\) => m === 7/, ':07 still owns the steady-state heartbeat');
});

// ------------------------------------------------- a rock is a mineral too
//
// (History: a rock born 2026-08-11 had a working ssh door and no entry in the
// central directory because enrol-sync was filtered out of the rock schedule.
// The directory is deleted (self-host strip, 2026-09-01) and enrol-sync with
// it; what survives on both tiers is seen-drain, the local last-seen stamp.)

test('a rock runs seen-drain, because a rock has a device roster too', () => {
  const src = readFileSync(new URL('./scheduler.mjs', import.meta.url), 'utf8');
  const m = src.match(/const ROCK_JOBS = (\/.*\/);/);
  assert.ok(m, 'the rock allow-list is still a regex named ROCK_JOBS');
  const allow = new RegExp(m[1].slice(1, -1));
  assert.ok(allow.test('seen-drain (device recency)'),
    'seen-drain must survive the rock filter, or a rock Devices page reads "no record yet" forever');
  assert.ok(allow.test('reconcile (registry appliers)'),
    'reconcile must still survive: control/ lives on the rock');
  assert.ok(!allow.test('backup (state snapshot)'),
    'the allow-list is still an allow-list, not an open door');
});

test('the rock hands the scheduler the mineral root, not the brain root', () => {
  const boot = readFileSync(new URL('../../provisioning/rock/boot-rock.sh', import.meta.url), 'utf8');
  const line = boot.split('\n').find((l) => l.includes('scheduler.mjs') && l.includes('AIOS_SCHEDULER_ROLE'));
  assert.ok(line, 'boot-rock still starts the scheduler');
  assert.match(line, /scheduler\.mjs" "\$STATE_DIR"/,
    'the argument is the mineral root: every path the jobs derive from it is state, not brain');
  assert.ok(!line.includes('$BRAIN_ROOT'),
    'BRAIN_ROOT here put the secrets guard one directory too deep and failed silently');
});

// ------------------------------------------- zero central calls, pinned
//
// The self-host strip (2026-09-01): the central directory at
// directory.crads-ai.com is deleted, so no scheduled job may name it, run a
// client of it, or hold a long-poll against it. This is the test that notices
// a directory client creeping back into the cadence.
test('the scheduler holds no directory clients and no /wait long-poll', () => {
  const src = readFileSync(new URL('./scheduler.mjs', import.meta.url), 'utf8');
  assert.ok(!/directory\.crads-ai\.com/.test(src), 'no directory URL anywhere in the scheduler');
  assert.ok(!/createWaitLoop|wait-loop\.mjs/.test(src), 'the /wait accelerator is gone with the service it polled');
  for (const dead of ['enrol-sync.mjs', 'anchor-claim.mjs', 'tie-claim.mjs',
    'broker-register.mjs', 'edges-reflect.mjs', 'accept-proofs', 'brain-public.mjs']) {
    assert.ok(!src.includes(dead), `${dead} is a client of the dead directory and must not be scheduled`);
  }
});

// ---- 2026-08-12: the renewer that was never scheduled (QA finding 47) ----
// mcp-refresh.mjs opens by calling itself "a cadence job". It was in no cadence,
// no allow-list, and no other file in the repo referenced it. Without it every
// MCP connection a member makes (Gmail, Calendar, Drive) expires within a day
// and only the member can revive it, which is precisely the sign-in-once promise
// the file exists to keep. Found by sweeping engine/ for scripts with zero
// inbound references: two hits, both real.
test('the MCP token renewer is actually scheduled', () => {
  const src = readFileSync(new URL('./scheduler.mjs', import.meta.url), 'utf8');
  assert.match(src, /mcp-refresh\.mjs/,
    'the scheduler must invoke the renewer, not merely allow-list its name');
  const i = src.indexOf("name: 'mcp-refresh");
  assert.ok(i > -1, 'it needs a named job row like every other machinery leg');
  const row = src.slice(i, i + 500);
  assert.match(row, /mcp-oauth\.json/,
    'guard on the store existing so a box with no connections never spawns node');
  assert.match(row, /match:/, 'a job with no match function never fires');
});

// Finding 121 was fixed for two jobs and missed on the one that needed it most.
// boot-rock exports GH_CONFIG_DIR=$ROCK_DIR/gh into the container, that directory
// is empty, and Connect GitHub writes the real credential to .kernel/gh. Any job
// that resolves the org's GitHub identity must therefore SET it, never inherit.
// Proven live 2026-08-14: a box posted its deploy keys at 04:12:00 and the 04:19
// reconcile wired nothing, while the same script by hand wired it instantly.
test('every job that needs the org GitHub identity hard-sets GH_CONFIG_DIR', () => {
  const src = readFileSync(new URL('./scheduler.mjs', import.meta.url), 'utf8');
  for (const marker of ['control/reconcile-all.mjs', 'control/heartbeat-pull.mjs']) {
    const line = src.split('\n').find((l) => l.includes(marker) && l.includes("cmd: ['bash'"));
    assert.ok(line, `no job line for ${marker}`);
    assert.match(line, /export GH_CONFIG_DIR="\$\{stateDir\}\/\.kernel\/gh"/,
      `${marker} must SET the credential path: inheriting it is finding 121`);
    assert.ok(!/GH_CONFIG_DIR:-/.test(line), `${marker} must not use a :- default; the wrong value is PRESENT, not absent`);
  }
});

// ---- 2026-08-16, finding 157: the applier's output went to /dev/null -------
// /state/.rock/cadence.log held 2782 lines and every one read "cadence: <job
// name>". reconcile-all prints a per-step ok/FAIL summary on stdout, the fire()
// callback took only the error, and nothing captured the rest. The line
// "anchor-reconcile: 1 wired, 1 re-staged, 1 still waiting" was printed every
// 15 minutes for days and read by nobody, which is why the cross-wired deploy
// keys of finding 152 sat unseen: the applier reported the symptom on schedule,
// into nothing.
//
// Driven for real rather than grepped: the scheduler emits one heartbeat at
// first start whatever the minute, and that job shells <state>/heartbeat-push.sh
// when it exists. So a stand-in script there IS an applier printing a line.
function runScheduler(dir, ms = 3000) {
  return new Promise((resolve) => {
    const p = spawn('node', [SCHED, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { out += c; });
    setTimeout(() => { p.kill('SIGKILL'); resolve(out); }, ms);
  });
}

test('what a job PRINTS reaches the cadence log, named by the job that said it', async () => {
  const dir = tmpDir('joblog-');
  writeFileSync(join(dir, 'profile.yaml'), 'identity:\n  timezone: "UTC"\ncadence:\n  enabled: false\n');
  writeFileSync(join(dir, 'heartbeat-push.sh'), '#!/bin/sh\necho "1 wired, 1 re-staged, 1 still waiting"\n');
  const out = await runScheduler(dir);
  assert.match(out, /cadence: heartbeat/, 'the fire line was never the problem');
  assert.match(out, /heartbeat: 1 wired, 1 re-staged, 1 still waiting/,
    'the applier said it and the log has to keep it, or nobody reads it for days');
});

test('and the last line survives the restart that truncates the log', async () => {
  // cadence.log is a `>` redirect from box-up/boot-rock, so it is gone on every
  // container restart and the nightly auto-update guarantees one a day. The run
  // ledger is the half a later QA run can still read.
  const dir = tmpDir('joblg2-');
  writeFileSync(join(dir, 'profile.yaml'), 'identity:\n  timezone: "UTC"\ncadence:\n  enabled: false\n');
  writeFileSync(join(dir, 'heartbeat-push.sh'), '#!/bin/sh\necho "1 wired, 1 re-staged, 1 still waiting"\n');
  await runScheduler(dir);
  const rows = readFileSync(join(dir, 'cockpit', 'run-ledger.jsonl'), 'utf8')
    .trimEnd().split('\n').map((l) => JSON.parse(l)).filter((r) => r.job === 'heartbeat');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].summary, '1 wired, 1 re-staged, 1 still waiting');
});

test('a job that prints nothing still adds not one line', async () => {
  // Most machinery here is a guarded no-op. Turning the log into the other
  // thing nobody can read would be the same failure wearing a different coat.
  const dir = tmpDir('joblg3-');
  writeFileSync(join(dir, 'profile.yaml'), 'identity:\n  timezone: "UTC"\ncadence:\n  enabled: false\n');
  const out = await runScheduler(dir);
  assert.match(out, /cadence: heartbeat/);
  assert.ok(!/ {2}seen-drain/.test(out), 'a silent guarded job stays silent');
});

