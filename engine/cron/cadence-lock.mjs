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
import { existsSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
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

// ---- one run at a time, per scheduled script --------------------------------
// A script on "every 5 minutes" whose run takes seven must not start a second
// copy on top of the first. The lock is a file per script under .kernel/locks,
// taken exclusively (O_EXCL), holding who took it and when. It is stale, and
// is taken over, once its holder is gone or it is older than the script's own
// time limit plus a minute: the run it guarded has been killed by then.

const lockFile = (stateDir, id) => join(stateDir, '.kernel', 'locks', `script-${id}.lock`);

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function runLockHeld(stateDir, id, { now = Date.now() } = {}) {
  let l;
  try { l = JSON.parse(readFileSync(lockFile(stateDir, id), 'utf8')); } catch { return false; }
  if (!l || !Number.isInteger(l.pid) || !alive(l.pid)) return false;
  const limitMs = ((Number(l.timeout_s) || 600) + 60) * 1000;
  return now - Date.parse(l.started || 0) < limitMs;
}

// Returns true when this caller now holds the lock.
export function takeRunLock(stateDir, id, { timeout_s = 600, pid = process.pid, now = Date.now() } = {}) {
  const f = lockFile(stateDir, id);
  try { mkdirSync(join(stateDir, '.kernel', 'locks'), { recursive: true }); } catch { return false; }
  const body = JSON.stringify({ pid, started: new Date(now).toISOString(), timeout_s });
  for (let i = 0; i < 2; i++) {
    try { writeFileSync(f, body, { flag: 'wx' }); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') return false;
      if (runLockHeld(stateDir, id, { now })) return false;
      try { rmSync(f, { force: true }); } catch { return false; }   // stale: its run is over
    }
  }
  return false;
}

export function releaseRunLock(stateDir, id) {
  try { rmSync(lockFile(stateDir, id), { force: true }); } catch { /* never throw into the tick loop */ }
}
