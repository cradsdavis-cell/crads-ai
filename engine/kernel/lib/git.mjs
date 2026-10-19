// git.mjs — thin git wrapper for the kernel. The kernel is the SOLE committer
// (decisions D9), so all git mutation funnels through here.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isAdopted, isMovingIn } from '../../lib/mineral-identity.mjs';
const exec = promisify(execFile);

// ADOPTED brains (spec 2026-10-17 § Engine changes) are repos a person already
// works in, with other writers pushing the same remote. Three rules differ there,
// and only there (pebbles take every old path unchanged):
//   1. a rebase, merge or cherry-pick in progress is the PERSON'S unless the
//      kernel left KERNEL_REBASE_MARK when it started it; theirs is never aborted
//      and nothing is committed onto it;
//   2. push goes to the branch they are on, not a hard-coded `main`;
//   3. a conflict with the remote STOPS and reports ({ blocked, reason }, which
//      the kernel writes to the run ledger as the `brain-push` row the Health
//      page shows) instead of taking the box's tree with `merge -s ours`.
export const KERNEL_REBASE_MARK = path.join('.kernel', 'rebase-by-kernel');
const GIT_OPS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD'];

/** The git operation in progress in this repo ('rebase-merge', 'MERGE_HEAD', ...), or ''. */
export function gitOpInProgressSync(cwd) {
  let gd = '';
  try { gd = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
  return GIT_OPS.find((op) => existsSync(path.join(gd, op))) || '';
}
const markPath = (cwd) => path.join(cwd, KERNEL_REBASE_MARK);
const markKernelRebase = (cwd) => { mkdirSync(path.dirname(markPath(cwd)), { recursive: true }); writeFileSync(markPath(cwd), String(process.pid) + '\n'); };
const unmarkKernelRebase = (cwd) => rmSync(markPath(cwd), { force: true });

export async function git(cwd, args) {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function ensureRepo(cwd) {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    await git(cwd, ['init', '-q']);
    await git(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main']).catch(() => {});
  }
}

export async function isDirty(cwd) {
  return (await git(cwd, ['status', '--porcelain'])).length > 0;
}

// Commit everything; returns the new SHA, or null if there was nothing to commit.
// Never commits onto rebase state: a commit made on the detached rebase HEAD
// captures conflict markers and gets destroyed by the eventual abort (2026-07-25
// re-review). clearRebase first: untracked new files survive the abort and are
// then committed cleanly on the branch.
export async function commitAll(cwd, message) {
  // Move-in mode, and Move out (which sets moving_in again before it stops
  // anything): nothing commits the person's folder. Checked HERE as well as at
  // the top of a drain, because a drain already running when Move out sets the
  // flag would otherwise commit on its way out (adopt rehearsal T4, finding 1).
  if (isMovingIn(cwd)) return null;
  await clearRebase(cwd);
  // Adopted: whatever clearRebase left is the person's operation. Committing onto
  // it would land on their detached replay HEAD; skip, and the next drain commits.
  if (isAdopted(cwd) && gitOpInProgressSync(cwd)) return null;
  await git(cwd, ['add', '-A']);
  const staged = await git(cwd, ['diff', '--cached', '--name-only']);
  if (!staged) return null;
  await git(cwd, [
    '-c', 'user.name=AI OS kernel',
    '-c', 'user.email=kernel@ai-os.local',
    'commit', '-q', '-m', message,
  ]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

// pull --rebase then push, retrying on conflict. No-op (skipped) if no remote —
// the v0 default for a freshly-provisioned client before GitHub is wired.
// The BOX is the writer of record for its own /state: a concurrent remote edit
// (org-owned brain repos have a second legitimate writer, D60 O2) resolves
// box-wins and converges, instead of wedging every future cycle. Verified
// failure mode without this (2026-07-25 O2 review): one conflicting remote
// write left .git/rebase-merge behind, the next commitAll committed conflict
// markers onto a detached HEAD, and every later pull died with "there is
// already a rebase-merge directory", silently stopping pushes forever.
const IDENT = ['-c', 'user.name=AI OS kernel', '-c', 'user.email=kernel@ai-os.local'];

// Clear rebase state a crashed or conflicted earlier cycle left behind, WITHOUT
// destroying work: if a commit was stranded on the detached rebase HEAD (a crash
// mid-rebase followed by a commit landing there), rebase --abort would hard-reset
// it out of the working tree (verified data-destruction path, 2026-07-25 re-review).
// So: capture the detached HEAD first, abort, then cherry-pick the stranded commit
// back onto the branch. Rescue is SKIPPED when the detached HEAD is existing
// history (a mid-replay position, reachable from the branch or the fetched
// remote): cherry-picking those would resurrect the remote's version over the
// box's. A redundant replay copy cherry-picks empty and no-ops via the abort.
export async function clearRebase(cwd) {
  // Adopted: abort only what the kernel started. No mark means the rebase (if
  // any) is the person's, mid-flight by hand, and it is left exactly as it is.
  if (isAdopted(cwd)) {
    if (!existsSync(markPath(cwd))) return;
    if (!gitOpInProgressSync(cwd)) { unmarkKernelRebase(cwd); return; }
  }
  try { await clearRebaseNow(cwd); } finally { if (isAdopted(cwd)) unmarkKernelRebase(cwd); }
}

async function clearRebaseNow(cwd) {
  const sym = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
  let stray = sym === 'HEAD' ? await git(cwd, ['rev-parse', 'HEAD']).catch(() => null) : null;
  const aborted = await git(cwd, ['rebase', '--abort']).then(() => true).catch(() => false);
  if (!aborted || !stray) return;
  for (const ref of ['HEAD', 'FETCH_HEAD', 'ORIG_HEAD']) {
    const known = await git(cwd, ['merge-base', '--is-ancestor', stray, ref]).then(() => true).catch(() => false);
    if (known) { stray = null; break; }
  }
  if (stray) {
    await git(cwd, [...IDENT, 'cherry-pick', '-X', 'theirs', stray])
      .catch(() => git(cwd, ['cherry-pick', '--abort']).catch(() => {}));
  }
}

export async function syncPush(cwd, { remote = 'origin', branch, retries = 3 } = {}) {
  if (isMovingIn(cwd)) return { pushed: false, reason: 'moving-in' };
  try { await git(cwd, ['remote', 'get-url', remote]); }
  catch { return { pushed: false, reason: 'no-remote' }; }
  if (isAdopted(cwd)) return adoptedPush(cwd, { remote, branch, retries });
  branch = branch || 'main';

  for (let i = 0; i < retries; i++) {
    try {
      await clearRebase(cwd);
      try {
        // -X theirs: during a rebase, "theirs" = the LOCAL commits being replayed,
        // so conflicting hunks resolve to the box's version (box-authoritative).
        await git(cwd, ['pull', '--rebase', '-X', 'theirs', remote, branch]);
      } catch {
        // -X only resolves CONTENT conflicts; modify/delete and friends still
        // fail and would strand the box on silent no-push forever. Fall back to
        // total box authority: a -s ours merge takes the box tree wholesale,
        // always succeeds, preserves both histories, leaves no rebase state.
        await clearRebase(cwd);
        await git(cwd, ['fetch', remote, branch]);
        await git(cwd, [...IDENT, 'merge', '-s', 'ours', '--no-edit', 'FETCH_HEAD']);
      }
      await git(cwd, ['push', remote, branch]);
      return { pushed: true };
    } catch (e) {
      // Never return with rebase state behind: a later commitAll would land on
      // the detached HEAD and the next cycle's abort would destroy it.
      await clearRebase(cwd);
      if (i === retries - 1) return { pushed: false, reason: String(e.stderr || e).slice(0, 200) };
    }
  }
}

// The adopted brain's push (rule 2 and 3 above). Fetch, replay our commits on
// the remote tip under the kernel's mark, push the branch we are on. A replay
// that conflicts is aborted (it is ours) and reported; nothing the remote holds
// is ever overridden. Fetch or push failures that are not conflicts (the network,
// a remote that moved between fetch and push) retry as before.
async function adoptedPush(cwd, { remote, branch, retries }) {
  const blocked = (reason, extra = {}) => ({ pushed: false, blocked: true, reason, ...extra });
  await clearRebase(cwd);
  const op = gitOpInProgressSync(cwd);
  if (op) return blocked(`a ${op} is in progress in this brain, so nothing was pushed; it is left exactly as it is`);
  if (!branch) {
    branch = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
    if (!branch) return blocked('this brain is not on a branch (detached HEAD), so nothing was pushed');
  }
  let last = '';
  for (let i = 0; i < retries; i++) {
    try {
      // Exit 2 = the remote has no such branch yet: nothing to replay onto.
      const onRemote = await exec('git', ['ls-remote', '--exit-code', '--heads', remote, branch], { cwd })
        .then(() => true, (e) => { if (e.code === 2) return false; throw e; });
      if (onRemote) {
        await git(cwd, ['fetch', '-q', remote, branch]);
        const behind = await git(cwd, ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD']).then(() => false, () => true);
        if (behind) {
          markKernelRebase(cwd);
          try {
            await git(cwd, [...IDENT, 'rebase', '-q', 'FETCH_HEAD']);
          } catch (e) {
            const conflicted = !!gitOpInProgressSync(cwd);
            await git(cwd, ['rebase', '--abort']).catch(() => {});
            if (conflicted) {
              return blocked(`${remote}/${branch} has commits that conflict with this brain's; nothing was overridden and nothing was pushed. Merge them by hand, and the next run pushes.`, { conflict: true });
            }
            throw e;
          } finally {
            unmarkKernelRebase(cwd);
          }
        }
      }
      await git(cwd, ['push', '-q', remote, `HEAD:refs/heads/${branch}`]);
      return { pushed: true, branch };
    } catch (e) {
      last = String(e.stderr || e).slice(0, 200);
    }
  }
  return blocked(last || 'push failed');
}
