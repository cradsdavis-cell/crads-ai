// cadence-lock.test.mjs — turning on your FIRST schedule must actually schedule
// something. Run: node --test engine/cron/cadence-lock.test.mjs
//
// Why this file exists. box-up.sh decides the kernel's human-lock ONCE, at boot:
//
//   if [ "$CADENCE_LIVE" = 1 ]; then rm -f .kernel/human-lock
//   else : > .kernel/human-lock; fi
//
// with a comment that names this exact hazard — "WITH cadence on an always-on
// box the lock would block scheduled jobs forever, so let them run". But a box
// boots with no member cadence (every box does: cadence.json starts empty), so
// it takes the else branch and holds the lock for the whole session. The member
// then turns on their first schedule in the app, and every drain from then on
// hits "human-lock present — deferring writes", exits 0, and writes no failure
// anywhere. Reproduced live on a real pebble 2026-08-04: the skill fired at its
// scheduled minute, the job sat undrained in .kernel/queue, and removing the
// lock by hand drained it immediately and wrote a real outcome row.
//
// So the lock must be re-evaluated when cadence goes live, not only at boot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { releaseBootLockForCadence } from './cadence-lock.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

function box({ locked = true } = {}) {
  const dir = tmpDir('cadlock-');
  mkdirSync(join(dir, '.kernel'), { recursive: true });
  if (locked) writeFileSync(join(dir, '.kernel', 'human-lock'), '');
  return dir;
}
const lock = (d) => join(d, '.kernel', 'human-lock');

test('a live skill schedule releases the boot lock', () => {
  const d = box();
  const freed = releaseBootLockForCadence(d, [{ isSkill: true, skill: 'daily' }]);
  assert.equal(freed, true, 'it reports that it freed the lock');
  assert.equal(existsSync(lock(d)), false, 'and the lock is gone');
});

test('no skill jobs means the lock is left exactly alone', () => {
  const d = box();
  const freed = releaseBootLockForCadence(d, [{ isSkill: false, lid: 'heartbeat' }]);
  assert.equal(freed, false);
  assert.equal(existsSync(lock(d)), true, 'an interactive session keeps its lock');
});

test('it is quiet and idempotent when there is no lock', () => {
  const d = box({ locked: false });
  assert.equal(releaseBootLockForCadence(d, [{ isSkill: true, skill: 'daily' }]), false);
  assert.equal(releaseBootLockForCadence(d, [{ isSkill: true, skill: 'daily' }]), false);
});

test('an unreadable state dir never throws into the tick loop', () => {
  assert.doesNotThrow(() => releaseBootLockForCadence('/nonexistent-box-path', [{ isSkill: true, skill: 'x' }]));
});

// ---------------------------------------------------------------------------
// The member's surfaces must not report a run that only got as far as the queue.
import { readFileSync } from 'node:fs';
import { fileURLToPath as f2 } from 'node:url';
import { dirname as d2, join as j2 } from 'node:path';
const MEMBER = readFileSync(j2(d2(f2(import.meta.url)), '..', '..', 'wizard', 'panel', 'member.html'), 'utf8');

test('an enqueue stamp with no outcome is reported as started, not ran', () => {
  const fn = MEMBER.match(/function runHealthChip\([\s\S]{0,1600}?\n  \}/);
  assert.ok(fn, 'the health chip must still exist');
  assert.match(fn[0], /started/, 'a fired-but-undrained skill reads as started');
  assert.match(fn[0], /no result recorded yet/, 'and says the outcome is unknown');
  assert.doesNotMatch(fn[0], /' · last ran '/, 'the enqueue stamp must never be called a run');
});

test('the skill surface passes the ledger-liveness signal', () => {
  // One surface since 2026-08-09 (audit R6): the Cadence page folded into
  // Skills, so the merged row renderer is the single call site.
  const calls = MEMBER.split('\n')
    .filter((l) => l.includes('runHealthChip(') && !l.includes('function runHealthChip('));
  assert.ok(calls.length >= 1, 'the merged Skills page renders run health');
  for (const c of calls) assert.match(c, /ledgerLive\(/, `call site must pass liveness: ${c}`);
});
