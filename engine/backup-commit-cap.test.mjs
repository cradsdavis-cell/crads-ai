// backup-commit-cap.test.mjs: the nightly backup never puts a snapshot into git
// that GitHub will refuse, and never into a repo that is not the mineral's own.
// Run: node --test engine/backup-commit-cap.test.mjs
//
// Trap 80 (2026-10-22). The first adopted brain (a person's own repo, mounted
// as the mineral's state) had 248 MB of `.claude/worktrees/`. policy.json
// listed `.claude` as a target, so the 03:40 backup tarred all of it into a
// 244 MB blob and committed it to backups/crads/. GitHub refuses any file over
// 100 MB (GH001), so every push of that repo failed for nine hours, and the
// engine's heartbeat never said why. Three fixes, each pinned below:
//   1. an adopted brain's snapshot is never committed, by size or otherwise;
//   2. on a pebble, a snapshot over the cap is kept off the tracked backups/
//      and the heartbeat and the run's last line say so;
//   3. what git already holds and what a tool rebuilds is not archived.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../tests/tmp-dir.mjs';
import { PASS_ENV, decryptArgs } from './lib/snapshot-cipher.mjs';
import { brainIgnores, brainIgnoresAdopted } from './lib/brain-ignore.mjs';
import { summarize } from './lib/run-ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'backup.mjs');
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: { ...process.env, ...ID } }).trim();
const SNAP = 'state-snapshot.tar.gz.enc';

function run(state, { cap, adopted = false } = {}) {
  const env = { ...process.env };
  delete env.AIOS_BACKUP_CAP_BYTES;
  if (cap) env.AIOS_BACKUP_CAP_BYTES = String(cap);
  const r = spawnSync('node', [SCRIPT, state], { encoding: 'utf8', env });
  const hb = join(state, 'backups', ...(adopted ? ['crads'] : []), 'heartbeat.json');
  r.heartbeat = existsSync(hb) ? JSON.parse(readFileSync(hb, 'utf8')) : null;
  return r;
}

// A brain with its own remote, pushed once, the way connect-github leaves one.
function brain({ adopted = false } = {}) {
  const root = tmpDir('aios-backup-cap-');
  const bare = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const d = join(root, 'brain');
  mkdirSync(d);
  git(d, 'init', '-q', '-b', 'main');
  writeFileSync(join(d, 'profile.yaml'), 'slug: test-box\n');
  if (adopted) writeFileSync(join(d, 'ownership.json'), JSON.stringify({ adopted: true }) + '\n');
  // the ignore file box-up and the kernel write for this kind of brain
  writeFileSync(join(d, '.gitignore'), (adopted ? brainIgnoresAdopted() : brainIgnores()).join('\n') + '\n');
  mkdirSync(join(d, 'secrets'), { recursive: true });
  writeFileSync(join(d, 'secrets', 'code_server_password'), 'pw\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'the brain');
  git(d, 'remote', 'add', 'origin', bare);
  git(d, 'push', '-q', '-u', 'origin', 'main');
  return { d, bare };
}

// Incompressible bytes, so a few KB of secret is a few KB of snapshot.
const bulk = (d, kb) => writeFileSync(join(d, 'secrets', 'bulk.bin'), randomBytes(kb * 1024));

function members(state, blob) {
  const out = join(tmpDir('aios-backup-cap-x-'), 'state.tar.gz');
  const pass = readFileSync(join(state, 'secrets', 'backup_passphrase'), 'utf8').trim();
  execFileSync('openssl', decryptArgs(blob, out), { env: { ...process.env, [PASS_ENV]: pass } });
  return execFileSync('tar', ['tzf', out], { encoding: 'utf8' }).split('\n').filter(Boolean).map((m) => m.replace(/\/$/, ''));
}

// ---- 1. adopted: never committed --------------------------------------------

test('adopted brain: the snapshot is written and verified but never committed or pushed, whatever its size', () => {
  const { d, bare } = brain({ adopted: true });
  const head = git(d, 'rev-parse', 'HEAD');
  const remote = git(bare, 'rev-parse', 'refs/heads/main');
  const r = run(d, { adopted: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(d, 'backups', 'crads', SNAP)), 'the snapshot is still made');
  assert.equal(git(d, 'rev-parse', 'HEAD'), head, 'no commit in the person\'s repo');
  assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), remote, 'nothing pushed to their remote');
  assert.equal(git(d, 'diff', '--cached', '--name-only'), '', 'nothing left staged either');
  const hb = r.heartbeat;
  assert.equal(hb.ok, true, 'not committing is by design here, not a failure');
  assert.equal(hb.offsite, false);
  assert.equal(hb.snapshot, `backups/crads/${SNAP}`);
  assert.ok(hb.notCommitted, 'the heartbeat says why it is not offsite');
  assert.equal(summarize(r.stdout + r.stderr), `backup: NOT COMMITTED: ${hb.notCommitted}`, 'and so does the line the run ledger keeps');

  // over the cap too: still where it always was, still not committed, still ok
  bulk(d, 8);
  const big = run(d, { adopted: true, cap: 4000 });
  assert.equal(big.status, 0, big.stderr);
  assert.ok(big.heartbeat.bytes > 4000);
  assert.equal(big.heartbeat.snapshot, `backups/crads/${SNAP}`);
  assert.equal(git(d, 'rev-parse', 'HEAD'), head);
});

test('adopted brain: the never-commit list keeps the snapshot out of the person\'s own `git add -A`', () => {
  const { d } = brain({ adopted: true });
  assert.equal(run(d, { adopted: true }).status, 0);
  writeFileSync(join(d, 'backups', 'crads', `${SNAP}.tmp`), 'mid-write\n');
  git(d, 'add', '-A');
  const staged = git(d, 'diff', '--cached', '--name-only').split('\n');
  assert.ok(!staged.some((p) => p.endsWith('.enc') || p.endsWith('.enc.tmp')), `a snapshot was staged: ${staged.join(', ')}`);
  // a pebble's backups/ is tracked on purpose: restore reads it from the repo
  assert.ok(!brainIgnores().some((p) => p.startsWith('backups/')), 'the pebble set must not ignore its backups/');
});

// ---- 2. pebble: the cap -----------------------------------------------------

test('pebble: a snapshot over the cap never reaches backups/, git or the remote, and the run says so', () => {
  const { d, bare } = brain();
  // night 1: fits, committed and pushed as always
  const first = run(d);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.heartbeat.offsite, true);
  assert.ok(!first.heartbeat.notCommitted);
  const fit = git(d, 'rev-parse', `HEAD:backups/${SNAP}`);

  // night 2: the state grew past the cap
  bulk(d, 8);
  const r = run(d, { cap: 4000 });
  assert.equal(r.status, 1, 'a backup that could not leave the box is a failed run');
  const hb = r.heartbeat;
  assert.equal(hb.ok, false);
  assert.equal(hb.capBytes, 4000);
  assert.ok(hb.bytes > 4000);
  assert.equal(hb.offsite, false);
  assert.equal(hb.snapshot, `.kernel/backups/${SNAP}`, 'kept on the machine, off the tracked dir');
  assert.ok(hb.notCommitted);
  assert.equal(summarize(r.stdout + r.stderr), `backup: NOT COMMITTED: ${hb.notCommitted}`);
  assert.ok(existsSync(join(d, '.kernel', 'backups', SNAP)));
  assert.ok(statSync(join(d, '.kernel', 'backups', SNAP)).size > 4000);
  // last night's, the last one that fit, is untouched in the tree, the repo and the remote
  assert.equal(git(d, 'hash-object', `backups/${SNAP}`), fit);
  assert.equal(git(d, 'rev-parse', `HEAD:backups/${SNAP}`), fit);
  assert.equal(git(bare, 'rev-parse', `refs/heads/main:backups/${SNAP}`), fit);
  // and the 03:50 brain-push's `git add -A` cannot pick the big one up
  git(d, 'add', '-A');
  const staged = git(d, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
  for (const p of staged) assert.ok(statSync(join(d, p)).size <= 4000, `${p} would be committed over the cap`);
  assert.ok(!staged.some((p) => p.startsWith('.kernel/')));
  git(d, 'reset', '-q');

  // night 3: back under it, committed again, and the waiting copy is superseded
  const third = run(d);
  assert.equal(third.status, 0, third.stderr);
  assert.equal(third.heartbeat.offsite, true);
  assert.notEqual(git(d, 'rev-parse', `HEAD:backups/${SNAP}`), fit);
  assert.ok(!existsSync(join(d, '.kernel', 'backups', SNAP)));
});

test('pebble: a first-ever snapshot over the cap is not written into backups/ at all', () => {
  const { d } = brain();
  bulk(d, 8);
  const r = run(d, { cap: 4000 });
  assert.equal(r.status, 1);
  assert.ok(!existsSync(join(d, 'backups', SNAP)));
  assert.ok(!existsSync(join(d, 'backups', `${SNAP}.tmp`)));
  assert.ok(!git(d, 'log', '--all', '--name-only', '--format=').includes(SNAP), 'and never committed');
});

test('the cap can be lowered, never raised past what GitHub accepts', () => {
  const { d } = brain();
  const r = run(d, { cap: 500 * 1000 * 1000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.heartbeat.capBytes <= 90 * 1000 * 1000, `cap ${r.heartbeat.capBytes} is too close to GitHub's 100 MB`);
  const policy = JSON.parse(readFileSync(join(HERE, 'policy.json'), 'utf8')).backup;
  assert.ok(policy.max_commit_bytes <= 90 * 1000 * 1000);
});

// ---- 3. what goes in --------------------------------------------------------

test('the snapshot leaves out worktrees, caches, packages and tracked files, and keeps the state it exists for', () => {
  const { d } = brain({ adopted: true });
  const put = (rel, body = 'x\n') => { mkdirSync(join(d, dirname(rel)), { recursive: true }); writeFileSync(join(d, rel), body); };
  // the person's tracked .claude/, which their repo already holds
  put('.claude/skills/capture/SKILL.md', '---\nname: capture\n---\n');
  put('.claude/settings.json', '{}\n');
  git(d, 'add', '-f', '.claude');
  git(d, 'commit', '-q', '-m', 'their .claude');
  // what the 2026-10-22 snapshot was made of: a worktree, plugin clones and caches, packages
  put('.claude/worktrees/wt1/.git', 'gitdir: ../../../.git/worktrees/wt1\n');
  put('.claude/worktrees/wt1/references/email/big.eml');
  put('.claude-auth/plugins/marketplaces/m/README.md');
  put('.claude-auth/plugins/cache/m/p/1.0/plugin.json');
  put('.claude-auth/cache/changelog.md');
  put('.opencode-auth/cache/opencode/bin/x');
  put('.opencode-auth/config/opencode/node_modules/pkg/index.js');
  put('.claude/hooks/__pycache__/h.cpython-312.pyc');
  // saved chats: not recovery state, and retention must not be undone by the snapshot (2026-10-26)
  put('.claude-auth/projects/p/0d1e.jsonl', '{}\n');
  put('.claude-auth/projects/p/0d1e/subagents/a.jsonl', '{}\n');
  // what it exists to protect
  put('.claude-auth/.credentials.json', '{"token":"t"}\n');
  put('.claude-auth/plugins/installed_plugins.json', '{}\n');
  put('.claude-auth/projects/p/memory/MEMORY.md', '# memory\n');
  put('.opencode-auth/config/opencode/opencode.json', '{}\n');
  put('.claude/settings.local.json', '{}\n');
  put('.claude/hooks/h.py', 'print(1)\n');
  put('.mcp.json', '{}\n');
  put('secrets/telegram_bot_token', 'tok\n');
  put('.kernel/gh/hosts.yml', 'github.com: {}\n');

  const r = run(d, { adopted: true });
  assert.equal(r.status, 0, r.stderr);
  const got = new Set(members(d, join(d, 'backups', 'crads', SNAP)));
  for (const gone of ['.claude/worktrees', '.claude-auth/plugins/marketplaces', '.claude-auth/plugins/cache',
    '.claude-auth/cache', '.opencode-auth/cache', '.opencode-auth/config/opencode/node_modules', '.claude/hooks/__pycache__',
    '.claude/skills/capture/SKILL.md', '.claude/settings.json', '.claude-auth/projects/p/0d1e.jsonl', '.claude-auth/projects/p/0d1e/subagents/a.jsonl']) {
    assert.ok(![...got].some((m) => m === gone || m.startsWith(gone + '/')), `${gone} is in the snapshot`);
  }
  for (const kept of ['profile.yaml', 'secrets/code_server_password', 'secrets/telegram_bot_token',
    '.claude-auth/.credentials.json', '.claude-auth/plugins/installed_plugins.json', '.claude-auth/projects/p/memory/MEMORY.md',
    '.opencode-auth/config/opencode/opencode.json', '.claude/settings.local.json', '.claude/hooks/h.py', '.mcp.json', '.kernel/gh/hosts.yml']) {
    assert.ok(got.has(kept), `${kept} is missing from the snapshot`);
  }
  assert.ok(r.heartbeat.leftOut.includes('.claude/worktrees'), 'the heartbeat names what it left out');
  assert.equal(r.heartbeat.trackedLeftOut, 2);
});

test('a pebble keeps its whole ignored .claude/, minus the same regenerable paths', () => {
  const { d } = brain();
  mkdirSync(join(d, '.claude', 'skills', 'mine'), { recursive: true });
  writeFileSync(join(d, '.claude', 'skills', 'mine', 'SKILL.md'), 'mine\n');
  mkdirSync(join(d, '.claude', 'worktrees', 'w'), { recursive: true });
  writeFileSync(join(d, '.claude', 'worktrees', 'w', 'f'), 'copy\n');
  const r = run(d);
  assert.equal(r.status, 0, r.stderr);
  const got = members(d, join(d, 'backups', SNAP));
  assert.ok(got.includes('.claude/skills/mine/SKILL.md'));
  assert.ok(!got.some((m) => m.startsWith('.claude/worktrees')));
});
