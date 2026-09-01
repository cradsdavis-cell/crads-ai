// syncPush hardening (D60 O2 review, 2026-07-25): a second legitimate writer on
// the synced repo (org-owned brains) must not wedge the box. Pins three claims:
// clean push works; a conflicting remote edit converges box-wins; a stale
// rebase-merge dir left by a conflicted earlier cycle is cleared, not fatal.
// Run: node --test engine/kernel/lib/git.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ensureRepo, commitAll, syncPush } from './git.mjs';
import { tmpDir } from '../../../tests/tmp-dir.mjs';

const sh = (cmd) => execFileSync('bash', ['-c', cmd], { encoding: 'utf8' });

function mkOrigin() {
  const bare = tmpDir('sp-origin-') + '.git';
  sh(`git init -q --bare -b main "${bare}"`);
  const seed = tmpDir('sp-seed-');
  sh(`cd "${seed}" && git init -q -b main && echo base > shared.md && git add -A && git -c user.name=x -c user.email=x@x commit -q -m base && git push -q "${bare}" main`);
  return bare;
}

async function mkBox(origin) {
  const box = tmpDir('sp-box-');
  sh(`git clone -q "${origin}" "${box}"`);
  return box;
}

// A second writer (the org) edits shared.md directly on the remote.
const orgEdits = (origin, content) => {
  const w = tmpDir('sp-org-');
  sh(`git clone -q "${origin}" "${w}" && cd "${w}" && echo "${content}" > shared.md && git add -A && git -c user.name=org -c user.email=org@x commit -q -m org-edit && git push -q origin main`);
};

test('clean cycle: commit + syncPush pushes', async () => {
  const origin = mkOrigin(); const box = await mkBox(origin);
  await ensureRepo(box);
  writeFileSync(join(box, 'note.md'), 'hello\n');
  await commitAll(box, 'sync');
  const r = await syncPush(box);
  assert.equal(r.pushed, true, JSON.stringify(r));
});

test('conflicting remote edit converges box-wins instead of wedging', async () => {
  const origin = mkOrigin(); const box = await mkBox(origin);
  orgEdits(origin, 'org-version');
  writeFileSync(join(box, 'shared.md'), 'box-version\n');
  await commitAll(box, 'sync');
  const r = await syncPush(box);
  assert.equal(r.pushed, true, JSON.stringify(r));
  const w = tmpDir('sp-verify-');
  const remote = sh(`git clone -q "${origin}" "${w}/c" && cat "${w}/c/shared.md"`).trim();
  assert.equal(remote, 'box-version', 'box is the writer of record for its own state');
});

test('stale rebase-merge state from a conflicted earlier cycle is cleared, and content written during the stuck window SURVIVES', async () => {
  const origin = mkOrigin(); const box = await mkBox(origin);
  orgEdits(origin, 'org-version');
  writeFileSync(join(box, 'shared.md'), 'box-version\n');
  await commitAll(box, 'wedge-me');
  // reproduce the pre-fix wedge: a plain pull --rebase (no strategy) conflicts
  // and leaves .git/rebase-merge + detached HEAD behind
  try { sh(`cd "${box}" && git pull --rebase origin main`); } catch { /* expected conflict */ }
  assert.ok(existsSync(join(box, '.git', 'rebase-merge')), 'precondition: the wedge state exists');
  // next kernel cycle: another commit lands on the wedged repo (detached HEAD), then syncPush.
  // The 2026-07-25 re-review proved a bare rebase --abort DESTROYS this commit
  // (reset out of the working tree, reflog-only recovery); the rescue must keep it.
  writeFileSync(join(box, 'later.md'), 'member wrote this during the stuck window\n');
  await commitAll(box, 'later');
  const r = await syncPush(box);
  assert.equal(r.pushed, true, `must recover from the wedge (got ${JSON.stringify(r)})`);
  assert.ok(!existsSync(join(box, '.git', 'rebase-merge')), 'rebase state cleared');
  assert.ok(existsSync(join(box, 'later.md')), 'stuck-window content must survive in the working tree');
  const W = tmpDir('sp-check-');
  sh(`git clone -q "${origin}" "${W}/c"`);
  assert.ok(existsSync(join(W, 'c', 'later.md')), 'stuck-window content must reach the remote');
  const remoteShared = sh(`cat "${W}/c/shared.md"`);
  assert.ok(!remoteShared.includes('<<<<<<<'), 'no conflict markers may ever reach the remote');
});

test('modify/delete divergence (org deletes a file the box modified) converges instead of silent no-push', async () => {
  const origin = mkOrigin(); const box = await mkBox(origin);
  // org deletes shared.md on the remote (admin tidying its own repo)
  const w = tmpDir('sp-orgdel-');
  sh(`git clone -q "${origin}" "${w}/c" && cd "${w}/c" && git rm -q shared.md && git -c user.name=org -c user.email=org@x commit -q -m org-delete && git push -q origin main`);
  // box modifies the same file: -X theirs cannot resolve modify/delete, the fallback must
  writeFileSync(join(box, 'shared.md'), 'box-still-cares\n');
  await commitAll(box, 'sync');
  const r = await syncPush(box);
  assert.equal(r.pushed, true, `modify/delete must not strand the box (got ${JSON.stringify(r)})`);
  assert.ok(!existsSync(join(box, '.git', 'rebase-merge')), 'no rebase state left behind');
  const W = tmpDir('sp-check2-');
  sh(`git clone -q "${origin}" "${W}/c"`);
  assert.equal(sh(`cat "${W}/c/shared.md"`).trim(), 'box-still-cares', 'box is the writer of record');
  // and the box keeps syncing afterwards (the wedge class is gone, not deferred)
  writeFileSync(join(box, 'after.md'), 'still alive\n');
  await commitAll(box, 'after');
  const r2 = await syncPush(box);
  assert.equal(r2.pushed, true, `subsequent cycles must keep pushing (got ${JSON.stringify(r2)})`);
});
