// The persistent command channel (2026-08-14 lag audit, stage S2).
//
// No network: `sshExe` points at a fake that execs bash reading stdin, which is
// exactly what the channel talks to. The pty is a requirement of the BOX's
// ForceCommand, not of the framing, so the framing is fully testable offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SshChannel, SshChannelPool, frameCommand, stripAnsi } from './ssh-channel.mjs';
import { isChannelEligible } from './ssh-bridge.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const skip = process.platform === 'win32';
const ESC = String.fromCharCode(27);

// Every temp dir here is removed. 30 test files in this repo leak mkdtemp dirs
// into /tmp; on 2026-08-14 that had reached 236k entries and 13G. Not adding to it.
function fakeSsh() {
  const dir = tmpDir('sshchan-');
  const fake = join(dir, 'fake-ssh');
  writeFileSync(fake, '#!/bin/sh\nexec bash\n');
  chmodSync(fake, 0o755);
  return { dir, fake, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('stripAnsi removes the bracketed-paste sequences a shell emits on a pty', () => {
  assert.equal(stripAnsi(`${ESC}[?2004hhello${ESC}[?2004l`), 'hello');
  assert.equal(stripAnsi('plain'), 'plain');
});

test('frameCommand keeps the barrier OUTSIDE the command subshell', () => {
  // Regression: with `( CMD ; printf ERREOF )` a command calling `exit` killed
  // the subshell before the barrier ran, so the call hung until the watchdog.
  const f = frameCommand('N1', 'exit 9');
  assert.match(f, /\{ \( exit 9 \)/, 'command is wrapped in its own subshell');
  assert.match(f, /\}\s*2> >\(sed/, 'barrier group carries the stderr redirect');
  assert.ok(f.indexOf('N1_ERREOF') > f.indexOf('( exit 9 )'), 'barrier follows the subshell');
});

test('separates stdout from stderr, which a pty otherwise merges', { skip }, async () => {
  const { fake, cleanup } = fakeSsh();
  const ch = new SshChannel('h', { sshArgs: [], sshExe: fake });
  try {
    const r = await ch.run('echo TO_OUT; echo TO_ERR 1>&2');
    assert.equal(r.stdout.trim(), 'TO_OUT');
    assert.equal(r.stderr.trim(), 'TO_ERR');
    assert.equal(r.code, 0);
  } finally { ch.close(); cleanup(); }
});

test('exit codes propagate, including from a command that calls exit', { skip }, async () => {
  const { fake, cleanup } = fakeSsh();
  const ch = new SshChannel('h', { sshArgs: [], sshExe: fake, hardTimeoutMs: 8000 });
  try {
    assert.equal((await ch.run('true')).code, 0);
    assert.equal((await ch.run('exit 9')).code, 9, 'bare `exit` must not hang the channel');
    assert.notEqual((await ch.run('ls /nope-not-here')).code, 0);
  } finally { ch.close(); cleanup(); }
});

test('each command is isolated: cwd does not leak to the next', { skip }, async () => {
  const { fake, cleanup } = fakeSsh();
  const ch = new SshChannel('h', { sshArgs: [], sshExe: fake });
  try {
    const a = await ch.run('cd /tmp && pwd');
    assert.equal(a.stdout.trim(), '/tmp');
    const b = await ch.run('pwd');
    assert.notEqual(b.stdout.trim(), '/tmp', 'the cd must not survive into command 2');
  } finally { ch.close(); cleanup(); }
});

test('output shaped like a sentinel cannot spoof a frame boundary', { skip }, async () => {
  const { fake, cleanup } = fakeSsh();
  const ch = new SshChannel('h', { sshArgs: [], sshExe: fake });
  try {
    // A fresh random nonce per command is what makes this safe.
    const r = await ch.run('echo C_deadbeef_END_0; echo real-tail');
    assert.match(r.stdout, /real-tail/, 'reading continued past the fake marker');
    assert.equal(r.code, 0);
  } finally { ch.close(); cleanup(); }
});

test('stderr from one command does not bleed into the next', { skip }, async () => {
  const { fake, cleanup } = fakeSsh();
  const ch = new SshChannel('h', { sshArgs: [], sshExe: fake });
  try {
    // The `>(sed)` flushes independently of the parent shell, so a single END
    // sentinel let stderr surface in the FOLLOWING command's window. Both
    // barriers must be seen before a command is considered complete.
    await ch.run('echo noisy 1>&2');
    const r = await ch.run('echo clean');
    assert.equal(r.stdout.trim(), 'clean');
    assert.equal(r.stderr.trim(), '', 'previous command stderr must not appear here');
  } finally { ch.close(); cleanup(); }
});

test('a hung command trips the watchdog and retires its channel', { skip }, async () => {
  const { fake, cleanup } = fakeSsh();
  const ch = new SshChannel('h', { sshArgs: [], sshExe: fake, hardTimeoutMs: 1200 });
  try {
    await assert.rejects(() => ch.run('sleep 30'), /exceeded/);
    assert.equal(ch.dead, true, 'channel is retired so the pool replaces it');
  } finally { cleanup(); }
});

test('the pool runs many commands and each result matches its own command', { skip }, async () => {
  const { fake, cleanup } = fakeSsh();
  const pool = new SshChannelPool('h', { size: 3, sshArgs: [], sshExe: fake });
  try {
    const res = await Promise.all(Array.from({ length: 12 }, (_, i) => pool.run(`echo p${i}`)));
    assert.ok(res.every((r) => r.code === 0));
    res.forEach((r, i) => assert.equal(r.stdout.trim(), `p${i}`, `result ${i} is not crossed over`));
  } finally { pool.closeAll(); cleanup(); }
});

test('more jobs than channels against a COLD pool: every one settles', { skip }, async () => {
  // Regression, and the bug that cost the most to find. `_settle()` cleared
  // `busy` for the OPEN handshake as well as for jobs, so a channel was handed
  // back to the pool the instant it finished opening, while its first run() was
  // still in flight. The pool then dispatched a second job into the same
  // channel, clobbering `pending`: the first command's promise never settled
  // and its watchdog later fired against nothing. It only shows up when jobs
  // outnumber channels at a cold start, which is exactly a panel page load.
  // Raced against a deadline on purpose: the failure mode is a promise that
  // NEVER settles, so without this the test hangs instead of failing, and a
  // hanging test in CI is worse than a failing one.
  const { fake, cleanup } = fakeSsh();
  const pool = new SshChannelPool('h', { size: 2, sshArgs: [], sshExe: fake, hardTimeoutMs: 8000 });
  try {
    const all = Promise.all(Array.from({ length: 6 }, (_, i) =>
      pool.run(`echo j${i}`).then((r) => r.stdout.trim(), (e) => `REJECTED:${e.message}`)));
    const settled = await Promise.race([
      all,
      new Promise((_, rj) => setTimeout(() => rj(new Error('a command never settled: channel was released mid-open and its pending was clobbered')), 15000)),
    ]);
    assert.deepEqual(settled, ['j0', 'j1', 'j2', 'j3', 'j4', 'j5'],
      'all six settled, in order, none lost to a clobbered pending');
    assert.equal(pool.queue.length, 0, 'queue drained');
  } finally { pool.closeAll(); cleanup(); }
});

test('the channel is OFF unless AIOS_SSH_CHANNEL=1, and refuses ineligible calls', () => {
  const prev = process.env.AIOS_SSH_CHANNEL;
  try {
    delete process.env.AIOS_SSH_CHANNEL;
    assert.equal(isChannelEligible('true', {}), false, 'default is the discrete path');

    process.env.AIOS_SSH_CHANNEL = '1';
    assert.equal(isChannelEligible('true', {}), true);
    // A pty is canonical-mode with a ~4KB line limit, so a base64 upload would
    // be truncated; binary output cannot be line-framed either.
    assert.equal(isChannelEligible('true', { stdin: 'payload' }), false, 'stdin stays discrete');
    assert.equal(isChannelEligible('x'.repeat(2001), {}), false, 'oversized command stays discrete');
    assert.equal(isChannelEligible('true', { noChannel: true }), false, 'explicit opt-out honoured');
  } finally {
    if (prev === undefined) delete process.env.AIOS_SSH_CHANNEL; else process.env.AIOS_SSH_CHANNEL = prev;
  }
});
