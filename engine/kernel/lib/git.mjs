// git.mjs — thin git wrapper for the kernel. The kernel is the SOLE committer
// (decisions D9), so all git mutation funnels through here.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

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
  await clearRebase(cwd);
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

export async function syncPush(cwd, { remote = 'origin', branch = 'main', retries = 3 } = {}) {
  try { await git(cwd, ['remote', 'get-url', remote]); }
  catch { return { pushed: false, reason: 'no-remote' }; }

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
