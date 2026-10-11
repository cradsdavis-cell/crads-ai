// team-lock.mjs: one writer at a time in the company agent's brain clone.
//
// Three things write org/brain on the hub: the hourly merge (team-hub), the
// owner's decision (team-proposals decide) and a proposal arriving from Slack
// (team-proposals queue). Each pulls, writes, adds and commits; two at once can
// collide on git's index.lock, or `add -A` can sweep up half of another's write
// (found by the teams security review, 2026-10-11). A directory lock is atomic on
// every filesystem the box uses; a lock older than STALE_MS is a crashed holder
// and is broken.
import { mkdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const STALE_MS = 10 * 60 * 1000;

export function withBrainLock(brainDir, fn, { waitMs = 120000, now = () => Date.now(), sleepMs = 200 } = {}) {
  const lock = path.join(brainDir, '..', '.brain.lock');
  const deadline = now() + waitMs;
  for (;;) {
    try { mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = now() - statSync(lock).mtimeMs; } catch { continue; }
      if (age > STALE_MS) { try { rmdirSync(lock); } catch { /* someone else broke it */ } continue; }
      if (now() > deadline) throw new Error('the company brain is busy (another write is still running); try again in a minute');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
    }
  }
  try { writeFileSync(path.join(lock, 'pid'), String(process.pid)); } catch { /* informational */ }
  try { return fn(); } finally {
    try { rmSync(lock, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}
