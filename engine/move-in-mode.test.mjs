// move-in-mode.test.mjs: while an adopted brain is moving in, nothing acts.
// Run: node --test engine/move-in-mode.test.mjs
//
// Spec docs/superpowers/specs/2026-10-17-adopt-existing-server.md § 2, last
// paragraph: host setup writes `"moving_in": true` into ownership.json before
// the container first starts. Until /move-in clears it the person's own host
// jobs are still the ones running the brain, so the container must not become
// a second actor on the same folder: the scheduler fires no job, the kernel
// drains, commits and syncs nothing, start-comms starts nothing, and box-up
// does not commit on exit. Clearing the flag lets everything run from the next
// start. Each part is proven both ways on the same fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../tests/tmp-dir.mjs';
import { isMovingIn, isAdopted } from './lib/mineral-identity.mjs';
import { enqueue } from './kernel/lib/queue.mjs';

const ENGINE = dirname(fileURLToPath(import.meta.url));
const KERNEL = join(ENGINE, 'kernel', 'kernel.mjs');
const SCHED = join(ENGINE, 'cron', 'scheduler.mjs');
const COMMS = join(ENGINE, 'start-comms.sh');
const IDENT = ['-c', 'user.name=person', '-c', 'user.email=person@x'];

const IS_MOVING_IN_LINE = `is_moving_in() { grep -Eq '"moving_in"[[:space:]]*:[[:space:]]*true([^A-Za-z0-9_]|$)' "$1/ownership.json" 2>/dev/null; }`;

const own = (dir, rec) => writeFileSync(join(dir, 'ownership.json'), JSON.stringify(rec, null, 2) + '\n');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

// An adopted brain on master, moving in, with the credential floor ignored.
function brain({ movingIn = true } = {}) {
  const d = tmpDir('movein-');
  git(d, 'init', '-q', '-b', 'master');
  mkdirSync(join(d, '.claude', 'skills', 'capture'), { recursive: true });
  writeFileSync(join(d, '.claude', 'skills', 'capture', 'SKILL.md'), '---\nname: capture\n---\nTHE PERSON\'S OWN\n');
  writeFileSync(join(d, 'CLAUDE.md'), '# theirs\n');
  writeFileSync(join(d, '.gitignore'), '.kernel/\nsecrets/\n.claude-auth/\n');
  writeFileSync(join(d, 'profile.yaml'), 'cadence:\n  enabled: false\n');
  own(d, movingIn ? { adopted: true, moving_in: true, mineral_id: 'min_0123456789abcdef01234567' } : { adopted: true });
  git(d, 'add', '-A');
  git(d, ...IDENT, 'commit', '-q', '-m', 'the person\'s brain');
  return d;
}

test('is_moving_in: one identical line in every shell reader, and the same answer as isMovingIn()', () => {
  for (const f of ['start-comms.sh', 'box-up.sh']) {
    const src = readFileSync(join(ENGINE, f), 'utf8');
    assert.ok(src.split('\n').includes(IS_MOVING_IN_LINE), `${f} must carry the is_moving_in line verbatim`);
  }
  const cases = [[{ moving_in: true }, true], ['{"adopted":true,"moving_in":true}', true], ['{"moving_in":true}', true],
    [{ moving_in: 'true' }, false], [{ moving_in: 1 }, false], [{ moving_in: false }, false], [{ adopted: true }, false], [null, false]];
  for (const [rec, want] of cases) {
    const d = tmpDir('movein-flag-');
    if (rec) writeFileSync(join(d, 'ownership.json'), typeof rec === 'string' ? rec : JSON.stringify(rec, null, 2));
    const sh = spawnSync('bash', ['-c', `${IS_MOVING_IN_LINE}\nis_moving_in "$1"`, 'x', d]).status === 0;
    assert.equal(isMovingIn(d), want, `isMovingIn(${JSON.stringify(rec)})`);
    assert.equal(sh, want, `is_moving_in for ${JSON.stringify(rec)}`);
  }
  // the two flags are independent: moving in never reads as adopted or back
  const d = tmpDir('movein-flag-');
  own(d, { moving_in: true });
  assert.equal(isAdopted(d), false);
});

test('kernel: moving in drains nothing scheduled, commits nothing, syncs no skill but /move-in; cleared, it runs', async () => {
  const d = brain();
  const head = git(d, 'rev-parse', 'HEAD');
  const gi = readFileSync(join(d, '.gitignore'), 'utf8');
  await enqueue(d, { skill: 'daily', args: {}, source: 'cli' });
  const out = execFileSync('node', [KERNEL, d, '--once', '--dry-run'], { encoding: 'utf8' });
  assert.match(out, /move-in mode/, 'it says why it did nothing');
  const queued = () => readdirSync(join(d, '.kernel', 'queue')).filter((f) => f.endsWith('.json'));
  assert.equal(queued().length, 1, 'the job is still waiting');
  const done = () => readdirSync(join(d, '.kernel', 'done')).filter((f) => f.endsWith('.json'));
  assert.equal(done().length, 0, 'nothing was drained');
  assert.equal(git(d, 'rev-parse', 'HEAD'), head, 'no commit');
  assert.equal(readFileSync(join(d, '.gitignore'), 'utf8'), gi, 'no ignore repair either');
  assert.ok(!existsSync(join(d, '.claude', 'skills', 'crads-capture')), 'no skill sync');
  assert.equal(git(d, 'status', '--porcelain'), '?? .claude/skills/move-in/', 'the tree is exactly as the person left it, apart from the /move-in skill');

  // cleared: the very next drain runs the job, syncs the skills and commits
  own(d, { adopted: true, mineral_id: 'min_0123456789abcdef01234567' });
  git(d, ...IDENT, 'commit', '-q', '-am', 'move-in done');
  const after = git(d, 'rev-parse', 'HEAD');
  execFileSync('node', [KERNEL, d, '--once', '--dry-run'], { encoding: 'utf8' });
  assert.ok(existsSync(join(d, '.claude', 'skills', 'crads-capture')), 'skills sync once moved in (clash installs as crads-<name>)');
  assert.notEqual(git(d, 'rev-parse', 'HEAD'), after, 'the drain committed');
  assert.equal(queued().length, 0, 'the waiting job ran');
  assert.equal(done().length, 1);
});

// Scheduler: a first start fires the heartbeat at once (it never waits for
// :07 on a box that has never emitted one), which makes "did anything fire"
// observable without waiting for a minute boundary.
function runScheduler(dir, ms = 2500) {
  return new Promise((resolve) => {
    const p = spawn('node', [SCHED, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { out += c; });
    setTimeout(() => { p.kill('SIGTERM'); }, ms);
    p.on('close', () => resolve(out));
  });
}

test('scheduler: moving in fires no job at all and says so once; cleared, the next start fires again', async () => {
  const d = brain();
  const out = await runScheduler(d);
  assert.match(out, /scheduler up/);
  assert.equal((out.match(/move-in mode/g) || []).length, 1, 'logged once, not per job');
  // mcp-refresh is the one job that runs while moving in (test below); a run
  // that lands on its :14/:44 minute may fire it, so it is the one exclusion
  assert.doesNotMatch(out, /cadence: (?!mcp-refresh)/, 'nothing fired, not even the first-start heartbeat');
  assert.ok(!existsSync(join(d, 'cockpit', 'heartbeat.json')), 'the heartbeat never ran');

  own(d, { adopted: true });
  const out2 = await runScheduler(d);
  assert.doesNotMatch(out2, /move-in mode/);
  assert.match(out2, /cadence: heartbeat/, 'the first-start heartbeat fires once moved in');
});

// The renewer is machinery that keeps the mineral's own sign-ins alive, and an
// adopted brain shares .mcp.json with the host, so holding it lapsed the HOST's
// connections too (idris, 2026-10-20). --at runs the same heldByMoveIn() as
// fire(), so the minute it is due shows what really runs.
test('scheduler: moving in still renews connections (mcp-refresh) and holds every other job due that minute', () => {
  const d = brain();
  const at = (dir, when) => execFileSync('node', [SCHED, dir, '--at', when], { encoding: 'utf8' });
  const moving = at(d, '10:14 Mon');
  assert.match(moving, /At 10:14 \(dow 1\): mcp-refresh \(connections\)$/m, 'only the renewer runs');
  assert.match(moving, /Held by move-in: .+/, 'the rest due at :14 are held, and named');
  assert.doesNotMatch(moving.match(/Held by move-in: (.*)/)[1], /mcp-refresh/);
  const other = at(d, '10:07 Mon');
  assert.match(other, /At 10:07 \(dow 1\): \(nothing\)/, 'a minute without the renewer runs nothing');
  assert.match(other, /Held by move-in: .*heartbeat/);

  own(d, { adopted: true });
  const done = at(d, '10:14 Mon');
  assert.doesNotMatch(done, /Held by move-in/, 'moved in, nothing is held');
  assert.match(done, /At 10:14 \(dow 1\): .*mcp-refresh \(connections\)/);
});

// start-comms: Remote Control is on by default and needs no Telegram, so with a
// signed-in account and a `claude` on PATH it launches on any normal mineral.
function comms(dir) {
  mkdirSync(join(dir, '.claude-auth'), { recursive: true });
  writeFileSync(join(dir, '.claude-auth', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"x"}}');
  const bin = tmpDir('movein-bin-');
  const rec = join(bin, 'calls.log');
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env bash\necho "$*" >> "${rec}"\nexec -a "claude remote-control" sleep 30\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  return { env, rec, run: () => execFileSync('bash', [COMMS, dir], { env, encoding: 'utf8' }) };
}
const waitFor = (fn, n = 60) => { for (let i = 0; i < n && !fn(); i++) execFileSync('sleep', ['0.05']); return fn(); };

test('start-comms: moving in starts nothing (no Remote Control, no kernel, no Telegram bridge); cleared, it starts', () => {
  const d = brain();
  // Telegram connected too, as a moved-in Oracle-like brain would be: the
  // host's own bot reader is still polling it, so a second reader must not start.
  mkdirSync(join(d, 'secrets'), { recursive: true });
  writeFileSync(join(d, 'secrets', 'telegram_bot_token'), '123:abc');
  writeFileSync(join(d, 'secrets', 'telegram_chat_id'), '42');
  const c = comms(d);
  c.run();
  execFileSync('sleep', ['0.4']);
  assert.ok(!existsSync(c.rec), 'claude was never launched');
  for (const pf of ['remote-control.pid', 'kernel.pid', 'telegram.pid']) {
    assert.ok(!existsSync(join(d, '.kernel', pf)), `${pf}: nothing started`);
  }

  // Cleared (and no Telegram, so nothing here reaches the network): Remote
  // Control comes up on the next run, which is what the scheduler's two-minute
  // supervisor does on its own.
  own(d, { adopted: true });
  for (const f of ['telegram_bot_token', 'telegram_chat_id']) writeFileSync(join(d, 'secrets', f), '');
  c.run();
  try {
    assert.ok(waitFor(() => existsSync(c.rec)), 'Remote Control launched once moved in');
    assert.match(readFileSync(c.rec, 'utf8'), /^remote-control /);
  } finally {
    const pf = join(d, '.kernel', 'remote-control.pid');
    if (existsSync(pf)) { const pid = Number(readFileSync(pf, 'utf8')); try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
  }
});

test('box-up: commit-on-exit returns early while moving in, before any git work', () => {
  const src = readFileSync(join(ENGINE, 'box-up.sh'), 'utf8');
  const body = src.slice(src.indexOf('commit_brain(){'), src.indexOf('\n}', src.indexOf('commit_brain(){')));
  const gate = body.indexOf('is_moving_in "$BOX" && return 0');
  assert.ok(gate > 0, 'commit_brain is gated on move-in mode');
  assert.ok(gate < body.indexOf('git -C'), 'the gate comes before the first git call (no commit, no push)');
});

// ---- follow-up (2026-10-18): what the kernel still does during a move-in ----

// A fake `claude` on PATH: records its arguments, writes a file into the brain
// the way a real skill would, and answers. Nothing reaches a model.
function fakeClaude(brainDir) {
  const bin = tmpDir('movein-claude-');
  const rec = join(bin, 'calls.log');
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env bash\necho "$*" >> "${rec}"\necho "written by the run" > "${brainDir}/ran.md"\necho "the run is done"\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, rec };
}
const queuedIn = (d, sub) => { try { return readdirSync(join(d, '.kernel', sub)).filter((f) => f.endsWith('.json')); } catch { return []; } };
const runsOf = (d) => { try { return readFileSync(join(d, 'cockpit', 'run-ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

test('kernel, moving in: the adopted-only /move-in skill is installed, and no other skill', () => {
  const d = brain();
  execFileSync('node', [KERNEL, d, '--once', '--dry-run'], { encoding: 'utf8' });
  assert.ok(existsSync(join(d, '.claude', 'skills', 'move-in', 'SKILL.md')), '/move-in is there for the move-in it serves');
  assert.ok(existsSync(join(d, '.claude', 'skills', 'move-in', '.crads-engine')), 'and marked as the engine\'s');
  const skills = readdirSync(join(d, '.claude', 'skills')).sort();
  assert.deepEqual(skills, ['capture', 'move-in'], 'nothing else synced: no crads-capture, no onboard, no daily');
  assert.equal(readFileSync(join(d, '.claude', 'skills', 'capture', 'SKILL.md'), 'utf8'), '---\nname: capture\n---\nTHE PERSON\'S OWN\n');
});

test('kernel, moving in: a run started by hand from the app runs and is recorded; nothing is committed; scheduled jobs stay queued', async () => {
  const d = brain();
  const head = git(d, 'rev-parse', 'HEAD');
  // box-up holds the boot human-lock on every brain with no live cadence,
  // which is every brain that is moving in
  mkdirSync(join(d, '.kernel'), { recursive: true });
  writeFileSync(join(d, '.kernel', 'human-lock'), '');
  // what panel-server.mjs skill-run does: enqueue with --source=dashboard, then --once
  execFileSync('node', [join(ENGINE, 'kernel', 'enqueue.mjs'), d, 'capture', '--source=dashboard'], { encoding: 'utf8' });
  await enqueue(d, { skill: 'daily', args: {}, source: 'cron' });
  await enqueue(d, { skill: 'message', args: { text: 'hi' }, source: 'telegram', reply_to: '42' });
  const c = fakeClaude(d);

  // box-up's boot drain is a dry run: it must not finish the hand job with made-up output
  execFileSync('node', [KERNEL, d, '--once'], { encoding: 'utf8', env: { ...c.env, DRY_RUN: '1' } });
  assert.equal(queuedIn(d, 'queue').length, 3, 'a dry run runs nothing, not even the hand job');
  assert.equal(runsOf(d).length, 0, 'and records no success');

  const out = execFileSync('node', [KERNEL, d, '--once'], { encoding: 'utf8', env: c.env });
  assert.match(out, /started by hand/);
  assert.ok(existsSync(c.rec), 'the hand job really ran');
  const runs = runsOf(d);
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].skill, runs[0].status, runs[0].source], ['capture', 'ok', 'dashboard'], 'the run ledger row the cutover check reads');
  assert.equal(queuedIn(d, 'done').length, 1);
  const left = queuedIn(d, 'queue').map((f) => JSON.parse(readFileSync(join(d, '.kernel', 'queue', f), 'utf8')).source).sort();
  assert.deepEqual(left, ['cron', 'telegram'], 'scheduled and Telegram jobs are not drained during a move-in');
  assert.equal(git(d, 'rev-parse', 'HEAD'), head, 'nothing committed');
  assert.ok(existsSync(join(d, 'ran.md')), 'what the run wrote stays in the tree, for the person\'s own jobs');
  assert.ok(existsSync(join(d, '.kernel', 'human-lock')), 'the boot lock is left as it was');

  // the scheduler's own drain is --once too, so the gate is the source, not --once
  execFileSync('node', [KERNEL, d, '--once'], { encoding: 'utf8', env: c.env });
  assert.equal(queuedIn(d, 'queue').length, 2, 'a second --once with no hand job runs nothing');
  // the daemon (no --once) never runs even a hand job
  execFileSync('node', [join(ENGINE, 'kernel', 'enqueue.mjs'), d, 'capture', '--source=dashboard'], { encoding: 'utf8' });
  const daemon = spawn('node', [KERNEL, d], { env: { ...c.env, KERNEL_POLL_MS: '100' }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1200));
  daemon.kill('SIGKILL');
  assert.equal(queuedIn(d, 'queue').length, 3, 'the long-running kernel drains nothing during a move-in');
});

// start-comms with a fake `node` in front of the real one: the Telegram bridge
// and the kernel daemon it would launch are recorded and parked on a sleep, so
// no test ever reaches Telegram. Everything else passes through to node.
function commsWithFakeBridge(dir) {
  const bin = tmpDir('movein-node-');
  const rec = join(bin, 'launched.log');
  // `telegram-send` is telegram.mjs --send-only (rehearsal T4 finding 6): the sender that never reads the bot
  writeFileSync(join(bin, 'node'), `#!/usr/bin/env bash\ncase "$1" in\n  */comms/telegram.mjs) case " $* " in *' --send-only '*) echo telegram-send >> "${rec}" ;; *) echo telegram >> "${rec}" ;; esac; exec -a crads-fake-telegram sleep 30 ;;\n  */kernel/kernel.mjs) echo kernel >> "${rec}"; exec -a crads-fake-kernel sleep 30 ;;\nesac\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(bin, 'node'), 0o755);
  mkdirSync(join(dir, 'secrets'), { recursive: true });
  writeFileSync(join(dir, 'secrets', 'telegram_bot_token'), '123:abc');
  writeFileSync(join(dir, 'secrets', 'telegram_chat_id'), '42');
  writeFileSync(join(dir, 'secrets', 'remote_control_disabled'), '');   // Remote Control is not what this test is about
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const launched = () => (existsSync(rec) ? readFileSync(rec, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { env, launched, run: () => execFileSync('bash', [COMMS, dir], { env, encoding: 'utf8' }) };
}
const alivePid = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const killPidFiles = (d) => { for (const f of ['kernel.pid', 'telegram.pid', 'telegram-send.pid']) { const pf = join(d, '.kernel', f); if (existsSync(pf)) { try { process.kill(Number(readFileSync(pf, 'utf8')), 'SIGKILL'); } catch { /* gone */ } } } };

test('start-comms: while .kernel/telegram-reader says host, no Telegram reader starts, and a running one is stopped', () => {
  const d = brain({ movingIn: false });
  const c = commsWithFakeBridge(d);
  try {
    // finished moving in, but the host program still answers the bot
    mkdirSync(join(d, '.kernel'), { recursive: true });
    writeFileSync(join(d, '.kernel', 'telegram-reader'), 'host\n');
    // a reader already running (started before the marker appeared)
    const old = spawn('bash', ['-c', 'exec -a crads-fake-telegram sleep 30'], { detached: true, stdio: 'ignore' });
    writeFileSync(join(d, '.kernel', 'telegram.pid'), String(old.pid));
    c.run();
    assert.ok(waitFor(() => !alivePid(old.pid) || readFileSync(`/proc/${old.pid}/stat`, 'utf8').split(' ')[2] === 'Z'), 'the running reader was stopped');
    assert.ok(!existsSync(join(d, '.kernel', 'telegram.pid')), 'and its pidfile is gone');
    assert.ok(!c.launched().includes('telegram'), 'no reader started: two readers on one bot steal each other\'s messages');
    assert.ok(waitFor(() => c.launched().includes('kernel')), 'the kernel daemon still starts (it is not a reader)');
    assert.ok(waitFor(() => c.launched().includes('telegram-send')), 'the send-only sender starts, so results still reach Telegram');
    c.run();
    assert.ok(!c.launched().includes('telegram'), 'nor on the supervisor\'s next pass');
    assert.equal(c.launched().filter((l) => l === 'telegram-send').length, 1, 'and the sender is not started twice');

    // the Telegram cutover step removes the marker: the next pass stops the sender and starts Crads-AI's reader
    const senderPid = Number(readFileSync(join(d, '.kernel', 'telegram-send.pid'), 'utf8'));
    rmSync(join(d, '.kernel', 'telegram-reader'));
    c.run();
    assert.ok(waitFor(() => c.launched().includes('telegram')), 'reader started once the host no longer answers');
    assert.ok(waitFor(() => !alivePid(senderPid) || readFileSync(`/proc/${senderPid}/stat`, 'utf8').split(' ')[2] === 'Z'), 'the sender is stopped: one sender at a time');
    assert.ok(!existsSync(join(d, '.kernel', 'telegram-send.pid')));
  } finally { killPidFiles(d); }
});

test('start-comms: in move-in mode not even the send-only sender starts', () => {
  const d = brain();
  const c = commsWithFakeBridge(d);
  try {
    mkdirSync(join(d, '.kernel'), { recursive: true });
    writeFileSync(join(d, '.kernel', 'telegram-reader'), 'host\n');
    c.run();
    execFileSync('sleep', ['0.3']);
    assert.deepEqual(c.launched(), [], 'nothing launched: no reader, no sender, no kernel');
    assert.ok(!existsSync(join(d, '.kernel', 'telegram-send.pid')));
  } finally { killPidFiles(d); }
});

// ---- Move out (adopt rehearsal T4, finding 1) ---------------------------------
//
// The rehearsal brain ended two commits ahead after Move out: box-up's exit trap
// ("AI OS kernel" session) and the nightly brain-push ("box"), because Move out
// stopped the container after the flag was cleared. Move out now writes
// `"moving_out": true` AND `"moving_in": true` before it stops anything, so every
// committer sees move-in mode on the way down. These run each committer the way a
// container stop does and prove nothing reaches the person's repo or remote.

const MOVING_OUT = { adopted: true, moving_in: true, moving_out: true, mineral_id: 'min_0123456789abcdef01234567' };

function movingOutBrain() {
  const d = brain({ movingIn: false });
  const bare = tmpDir('moveout-origin-') + '.git';
  git('/', 'init', '-q', '--bare', '-b', 'master', bare);
  git(d, 'remote', 'add', 'origin', bare);
  git(d, 'push', '-q', '-u', 'origin', 'master');
  own(d, MOVING_OUT);
  // what a running mineral leaves in the tree: the person's half-made edit and
  // engine files the kernel or a job just wrote
  writeFileSync(join(d, 'note.md'), 'half-written\n');
  mkdirSync(join(d, 'cockpit'), { recursive: true });
  writeFileSync(join(d, 'cockpit', 'run-ledger.jsonl'), '{"job":"x"}\n');
  writeFileSync(join(d, 'custody-log.jsonl'), '{"event":"baseline"}\n');
  return { d, bare, head: git(d, 'rev-parse', 'HEAD'), remote: git(bare, 'rev-parse', 'refs/heads/master') };
}

// box-up's exit trap, run from its real text: is_moving_in, then commit_brain.
function runCommitBrain(d, { adopted = 1 } = {}) {
  const src = readFileSync(join(ENGINE, 'box-up.sh'), 'utf8');
  const fn = src.slice(src.indexOf('commit_brain(){'), src.indexOf('# ---- optional per-box cadence'));
  assert.ok(fn.startsWith('commit_brain(){') && fn.length > 100, 'box-up.sh: commit_brain moved');
  const r = spawnSync('bash', ['-c', `BOX="$1"; ADOPTED=${adopted}\n${IS_MOVING_IN_LINE}\n${fn}\ncommit_brain`, 'box-up', d], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

test('Move out: a container stop commits and pushes nothing (box-up exit trap, brain-push, kernel, backup)', async () => {
  const { d, bare, head, remote } = movingOutBrain();
  runCommitBrain(d);
  const bp = spawnSync('bash', [join(ENGINE, 'brain-push.sh'), d], { encoding: 'utf8' });
  assert.equal(bp.status, 0);
  await enqueue(d, { skill: 'daily', args: {}, source: 'cron' });
  execFileSync('node', [KERNEL, d, '--once', '--dry-run'], { encoding: 'utf8' });
  const bk = spawnSync('node', [join(ENGINE, 'backup.mjs'), d], { encoding: 'utf8' });
  assert.equal(bk.status, 0, bk.stderr);
  // a drain already running when Move out set the flag reaches these two last
  const { commitAll, syncPush } = await import('./kernel/lib/git.mjs');
  assert.equal(await commitAll(d, 'job(daily): in flight'), null, 'an in-flight drain commits nothing');
  assert.equal((await syncPush(d)).pushed, false, 'and pushes nothing');
  assert.equal(git(d, 'rev-parse', 'HEAD'), head, 'the person\'s repo is exactly where Move out found it');
  assert.equal(git(bare, 'rev-parse', 'refs/heads/master'), remote, 'and so is their remote');
  assert.match(git(d, 'status', '--porcelain'), /note\.md/, 'their half-made edit is still uncommitted, for them');
});

test('Move out, control: the same stop with the flags cleared does commit a pebble (the slice really is the exit trap)', () => {
  const { d, head } = movingOutBrain();
  own(d, {});
  runCommitBrain(d, { adopted: 0 });
  assert.notEqual(git(d, 'rev-parse', 'HEAD'), head);
});

test('box-up exit trap, adopted and moved in: still no commit of the shared folder (trap 77), only the push', () => {
  const { d, head } = movingOutBrain();
  own(d, { adopted: true });
  runCommitBrain(d);
  assert.equal(git(d, 'rev-parse', 'HEAD'), head, 'a stop never snapshots the person\'s folder');
  assert.match(git(d, 'status', '--porcelain'), /note\.md/, 'their half-made edit is still theirs');
});

test('Move out: the scheduler fires nothing and commits nothing on its way down', async () => {
  const { d, head } = movingOutBrain();
  const out = await runScheduler(d, 1500);
  assert.match(out, /move-in mode/);
  assert.doesNotMatch(out, /cadence: (?!mcp-refresh)/);
  assert.equal(git(d, 'rev-parse', 'HEAD'), head);
});
