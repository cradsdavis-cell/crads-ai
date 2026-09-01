// cadence-lock.mjs — the kernel's human-lock must not outlive the reason it was taken.
//
// box-up.sh takes the lock at boot when the box has no member cadence, so an
// interactive session can work in /state without the kernel writing underneath
// it. Its own comment records the ruling for the other case: "WITH cadence on an
// always-on box the lock would block scheduled jobs forever, so let them run."
//
// The hole is that the decision is made ONCE, at boot, and every box boots with
// no member cadence (cadence.json starts empty). So the moment a member turns on
// their first schedule, the lock from boot is still there, every drain answers
// "human-lock present — deferring writes" and exits 0, and nothing records that
// the run did not happen. The scheduler already re-reads cadence.json every
// minute, which makes it the one place that knows cadence has gone live.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Release the boot-time lock once cadence is actually live. Returns true only
// when it removed a lock, so the caller can say so exactly once.
export function releaseBootLockForCadence(stateDir, jobs) {
  try {
    if (!Array.isArray(jobs) || !jobs.some((j) => j && j.isSkill)) return false;
    const lock = join(stateDir, '.kernel', 'human-lock');
    if (!existsSync(lock)) return false;
    rmSync(lock, { force: true });
    return true;
  } catch {
    return false;   // never throw into the tick loop
  }
}
