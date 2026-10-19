// The MaxStartups defence (2026-07-24): concurrent panel SSH calls are capped and
// queued, so poller bursts can never storm sshd into resetting connections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { runSsh } from './ssh-bridge.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const skip = process.platform === 'win32';

test('at most 6 ssh processes run concurrently; the rest queue and all complete', { skip }, async () => {
  const dir = tmpDir('bridge-');
  const log = join(dir, 'log');
  const fake = join(dir, 'fake-ssh');
  writeFileSync(fake, `#!/bin/sh\necho "S $(date +%s%N)" >> ${log}\nsleep 0.25\necho "E $(date +%s%N)" >> ${log}\n`);
  chmodSync(fake, 0o755);
  const cfg = join(dir, 'config'); writeFileSync(cfg, '');
  const results = await Promise.all(Array.from({ length: 13 }, () =>
    runSsh('anyhost', 'true', { sshExe: fake, configPath: cfg })));
  assert.ok(results.every((r) => r.code === 0), 'all 13 queued calls completed');
  const events = readFileSync(log, 'utf8').trim().split('\n')
    .map((l) => ({ t: Number(l.split(' ')[1]), d: l[0] === 'S' ? 1 : -1 }))
    .sort((a, b) => a.t - b.t);
  let active = 0, peak = 0;
  for (const e of events) { active += e.d; peak = Math.max(peak, active); }
  // 6 up from 3 (2026-08-09 lag audit): still well under sshd's MaxSessions 10.
  assert.ok(peak <= 6, `peak concurrency ${peak} must be <= 6`);
});

test('killing a still-queued call resolves it without ever spawning', { skip }, async () => {
  const dir = tmpDir('bridge2-');
  const fake = join(dir, 'fake-ssh');
  writeFileSync(fake, '#!/bin/sh\nsleep 0.3\n'); chmodSync(fake, 0o755);
  const cfg = join(dir, 'config'); writeFileSync(cfg, '');
  // fill all slots, then queue one and kill it before it can start
  const fillers = Array.from({ length: 6 }, () => runSsh('h', 'true', { sshExe: fake, configPath: cfg }));
  const { streamSsh } = await import('./ssh-bridge.mjs');
  const queued = streamSsh('h', 'true', { sshExe: fake, configPath: cfg });
  const closed = new Promise((res) => queued.on('close', res));
  queued.kill();
  const code = await closed;
  assert.equal(code, -1, 'queued+killed call reports close(-1)');
  await Promise.all(fillers);
});


test('hard watchdog kills a hung ssh promptly so its slot frees', { skip }, async () => {
  // fresh module instance: the concurrency counter is module-global, so isolate from other tests
  const { runSsh: freshRun } = await import('./ssh-bridge.mjs?wd=' + Date.now());
  const dir = tmpDir('bridge-wd-');
  const cfg = join(dir, 'config'); writeFileSync(cfg, '');
  // fake ssh = a node process that idles 30s with no pebble (nothing to orphan the pipes);
  // a real hung ssh behaves the same under SIGKILL.
  const fake = join(dir, 'fake');
  writeFileSync(fake, `#!/bin/sh\nexec ${process.execPath} -e "setTimeout(()=>{},30000)"\n`);
  chmodSync(fake, 0o755);
  const t0 = Date.now();
  const r = await freshRun('h', 'true', { sshExe: fake, configPath: cfg, hardTimeoutMs: 400 });
  const dt = Date.now() - t0;
  assert.ok(dt < 3000, `hung ssh killed at the watchdog (~400ms), took ${dt}ms; not left for LoginGraceTime`);
  assert.notEqual(r.code, 0, 'a killed hung connection does not report success');
});

// A RECYCLED ADDRESS SELF-HEALS ONCE (finding 82's second site, fixed 2026-08-13).
//
// forgetHost runs at stamp and re-install, which covers a box we just built. It
// did not cover a box pinned days ago whose provider handed that address to a
// different new box. Every verb then died on a changed host key, and the failure
// never reached the UI: org-backup-status returned NO output on qa-baseline-gmail
// and the Custody card went on showing the PREVIOUS rock's repository, telling an
// owner their brain was backed up to another organisation's repo (finding 89).
test('a changed host key is forgotten and retried exactly once', { skip }, async () => {
  const { streamSsh: freshStream } = await import('./ssh-bridge.mjs?hk=' + Date.now());
  const dir = tmpDir('bridge-hostkey-');
  const cfg = join(dir, 'config');
  writeFileSync(cfg, 'Host recycled\n  HostName 203.0.113.9\n');
  const counter = join(dir, 'attempts');
  writeFileSync(counter, '');
  // Fake ssh: fails the FIRST attempt the way OpenSSH does on a changed key,
  // succeeds on the second. Counting attempts in a file survives the respawn.
  const fake = join(dir, 'fake-ssh');
  writeFileSync(fake, `#!/bin/sh
n=$(wc -c < "${counter}")
printf x >> "${counter}"
if [ "$n" -eq 0 ]; then
  echo "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@" >&2
  echo "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @" >&2
  exit 255
fi
echo OK
exit 0
`);
  chmodSync(fake, 0o755);

  const seen = [];
  const p = freshStream('recycled', 'true', {
    sshExe: fake, configPath: cfg,
    onStdout: (l) => seen.push(l),
    onStderr: () => {},
  });
  const code = await new Promise((res) => p.on('close', res));
  assert.equal(code, 0, 'the retry should succeed after the stale pin is dropped');
  assert.ok(seen.includes('OK'), `expected the retry's output, got ${JSON.stringify(seen)}`);
  assert.equal(readFileSync(counter, 'utf8').length, 2, 'exactly two attempts: one retry, never a loop');
});

test('a host key that keeps changing is NOT retried forever', { skip }, async () => {
  // The retry must be once. A box genuinely being tampered with, or a fake that
  // always fails, must not become an infinite respawn against the concurrency cap.
  const { streamSsh: freshStream } = await import('./ssh-bridge.mjs?hk2=' + Date.now());
  const dir = tmpDir('bridge-hostkey2-');
  const cfg = join(dir, 'config');
  writeFileSync(cfg, 'Host recycled\n  HostName 203.0.113.10\n');
  const counter = join(dir, 'attempts');
  writeFileSync(counter, '');
  const fake = join(dir, 'fake-ssh');
  writeFileSync(fake, `#!/bin/sh
printf x >> "${counter}"
echo "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @" >&2
exit 255
`);
  chmodSync(fake, 0o755);
  const p = freshStream('recycled', 'true', { sshExe: fake, configPath: cfg, onStderr: () => {} });
  const code = await new Promise((res) => p.on('close', res));
  assert.notEqual(code, 0);
  assert.equal(readFileSync(counter, 'utf8').length, 2, 'two attempts total, then it gives up');
});

// ---- ControlPath length (adopt rehearsal T4, 2026-10-18) -------------------
// A long home made the mux socket path overflow sun_path and every panel verb
// failed. The decision is pure; the private-dir check is exercised on scratch.
import { muxPathCandidates, muxControlPath, ensurePrivateDir, sunPathLimit, MUX_SUFFIX_BYTES } from './ssh-bridge.mjs';
import { mkdirSync, statSync, symlinkSync } from 'node:fs';

const expanded = (p) => Buffer.byteLength(p) - 2 + MUX_SUFFIX_BYTES;

test('mux path: an ordinary home keeps the socket in ~/.ssh as before', () => {
  for (const platform of ['linux', 'darwin']) {
    const c = muxPathCandidates({ home: '/home/pat', platform, tmp: '/tmp', uid: 1000 });
    assert.equal(c[0].path, '/home/pat/.ssh/crads-mux-%C');
    assert.equal(c[0].own, false);
    assert.equal(muxControlPath({ home: '/Users/samuel', platform, tmp: '/tmp', uid: 501, ensureDir: () => assert.fail('no dir needed') }),
      '/Users/samuel/.ssh/crads-mux-%C');
  }
});

test('mux path: a long home falls back to a short per-user dir, and every choice fits sun_path', () => {
  const long = '/tmp/claude-1002/-home-sam-second-brain--claude-worktrees-x/scratch/home';
  for (const platform of ['linux', 'darwin']) {
    const all = muxPathCandidates({ home: long, platform, tmp: '/tmp', uid: 1002 });
    assert.ok(!all.some((c) => c.path.startsWith(long)), 'the long home is not offered');
    assert.equal(all[0].path, '/tmp/crads-1002/%C');
    assert.equal(all[0].own, true);
    for (const c of all) assert.ok(expanded(c.path) <= sunPathLimit(platform));
  }
  const made = [];
  assert.equal(muxControlPath({ home: long, platform: 'linux', tmp: '/tmp', uid: 1002, ensureDir: (d) => { made.push(d); return true; } }),
    '/tmp/crads-1002/%C');
  assert.deepEqual(made, ['/tmp/crads-1002']);
});

test('mux path: the boundary is exact (108 on Linux, 104 elsewhere, NUL and the 17-byte temp suffix counted)', () => {
  // home + "/.ssh/crads-mux-" (16) + 40 + 17 + 1 must be <= limit
  const fits = (n, platform) => muxPathCandidates({ home: '/' + 'h'.repeat(n - 1), platform, tmp: '', uid: 1 })
    .some((c) => !c.own);
  assert.equal(fits(108 - 16 - 58, 'linux'), true);
  assert.equal(fits(108 - 16 - 58 + 1, 'linux'), false);
  assert.equal(fits(104 - 16 - 58, 'darwin'), true);
  assert.equal(fits(104 - 16 - 58 + 1, 'darwin'), false);
});

test('mux path: macOS long temp dir is skipped for /tmp; nothing that fits means no sharing at all', () => {
  const macTmp = '/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T';
  const c = muxPathCandidates({ home: '/Users/' + 'x'.repeat(80), platform: 'darwin', tmp: macTmp, uid: 501 });
  assert.deepEqual(c.map((x) => x.path), ['/tmp/crads-501/%C']);
  // the dir cannot be made ours: drop ControlMaster rather than fail every verb
  assert.equal(muxControlPath({ home: '/Users/' + 'x'.repeat(80), platform: 'darwin', tmp: macTmp, uid: 501, ensureDir: () => false }), null);
  // a /tmp that is itself impossible: none
  assert.deepEqual(muxPathCandidates({ home: '/h'.repeat(60), platform: 'linux', tmp: '/t'.repeat(60), uid: 7 })
    .filter((x) => !x.path.startsWith('/tmp/')).length, 0);
});

test('private dir: made 0700, a loose one tightened, a symlink refused', { skip }, () => {
  const base = tmpDir('mux-');
  const d = join(base, 'crads-me');
  assert.equal(ensurePrivateDir(d, process.getuid()), true);
  assert.equal(statSync(d).mode & 0o777, 0o700);
  const loose = join(base, 'loose'); mkdirSync(loose, { mode: 0o755 }); chmodSync(loose, 0o755);
  assert.equal(ensurePrivateDir(loose, process.getuid()), true);
  assert.equal(statSync(loose).mode & 0o777, 0o700);
  const link = join(base, 'link'); symlinkSync(loose, link);
  assert.equal(ensurePrivateDir(link, process.getuid()), false, 'a pre-planted symlink is never used');
  assert.equal(ensurePrivateDir(d, process.getuid() + 1), false, 'someone else’s dir is never used');
});

test('every verb under a long home gets a ControlPath that fits (the rehearsal failure, end to end)', { skip }, async () => {
  const dir = tmpDir('muxlong-');
  const home = join(dir, 'a-very-long-scratch-home-directory-name-like-the-rehearsal-one', 'home');
  mkdirSync(home, { recursive: true });
  const argsLog = join(dir, 'args');
  const fake = join(dir, 'fake-ssh');
  writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > ${argsLog}\n`);
  chmodSync(fake, 0o755);
  const cfg = join(dir, 'config'); writeFileSync(cfg, '');
  const was = process.env.HOME;
  process.env.HOME = home;
  try {
    const r = await runSsh('anyhost', 'true', { sshExe: fake, configPath: cfg });
    assert.equal(r.code, 0);
  } finally { process.env.HOME = was; }
  const args = readFileSync(argsLog, 'utf8').split('\n');
  const cp = args.find((a) => a.startsWith('ControlPath='));
  if (cp) {
    const p = cp.slice('ControlPath='.length);
    assert.ok(!p.startsWith(home), `socket must not sit under the long home: ${p}`);
    assert.ok(Buffer.byteLength(p) - 2 + MUX_SUFFIX_BYTES <= sunPathLimit(process.platform), p);
  } else {
    assert.ok(!args.includes('ControlMaster=auto'), 'no ControlPath means no ControlMaster either');
  }
});
