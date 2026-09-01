// org-backup-status.test.mjs — the Custody card's truth verb, driven for real.
// Run: node --test wizard/panel/org-backup-status.test.mjs
//
// FINDINGS 196 + 197 (2026-08-17). The "last push" this verb reports had two
// sources on a rock and both were dead: the ref-refresh fetch added for finding
// 104 ran credential-less against a repo that is private by design, so it could
// only ever fail (196), and brain-push.log is written by a pebble cron absent
// from ROCK_JOBS, so it does not exist there (197). The timestamp was frozen at
// whatever the tracking ref was born with, on the card that answers "if this
// mineral died today, is my brain safe".
//
// The fix is the discipline 104's own near-miss concluded with: ask the far end
// (`gh api repos/<slug>/commits`, with the token the connect flow installed),
// not a local ref that something has to refresh. These tests run the verb's
// EMITTED SHELL for real (a real git history, a stubbed gh) because the
// string-level reading of this command has now been wrong twice (104 shipped a
// fetch that never once succeeded, and nothing noticed for four days).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { VERBS } from './panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const COMMAND = VERBS['org-backup-status'].build().command;

const sh = (cwd, cmd, env = {}) => execFileSync('bash', ['-c', cmd], {
  cwd, encoding: 'utf8', env: { ...process.env, ...env },
});
const git = (cwd, args) => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
}).trim();

/** A world: a brain repo with one commit, a PATH-first stub gh, and a runner
 *  that executes the verb's real command against them. `ghScript` is the stub's
 *  body; empty string means gh exists and fails (unauthenticated / offline). */
function world({ ghScript = 'exit 1', remote = 'https://github.com/acme/acme-brain.git', trackingRef = false } = {}) {
  const root = tmpDir('obs-');
  const brain = join(root, 'brain');
  mkdirSync(brain);
  git(brain, ['init', '-q', '-b', 'main']);
  writeFileSync(join(brain, 'page.md'), 'hello\n');
  git(brain, ['add', '-A']);
  git(brain, ['commit', '-qm', 'first']);
  const tip = git(brain, ['rev-parse', 'HEAD']);
  if (remote) git(brain, ['remote', 'add', 'origin', remote]);
  if (trackingRef) {
    // What a once-successful `git push -u` leaves behind: a remote-tracking ref
    // at some commit, which nothing on a rock ever moves again.
    git(brain, ['update-ref', 'refs/remotes/origin/main', tip]);
    git(brain, ['branch', '-q', '--set-upstream-to=origin/main', 'main']);
  }
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/bin/bash\n${ghScript}\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const run = () => {
    const out = sh(root, COMMAND, {
      // BR_RESOLVE reads /state/deployment.yaml (absent here) then falls back
      // to $BRAIN_ROOT, so the verb targets this world's brain unmodified.
      BRAIN_ROOT: brain,
      PATH: `${bin}:${process.env.PATH}`,
    });
    const line = out.split('\n').find((l) => l.startsWith('ORG_BACKUP '));
    assert.ok(line, `no ORG_BACKUP line in: ${out}`);
    return JSON.parse(line.slice('ORG_BACKUP '.length));
  };
  return { root, brain, tip, run, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('the far end confirms the push, and its date is the one reported (196/197 fixed)', () => {
  const w = world({ trackingRef: true });
  try {
    // The stub answers what GitHub would: this brain's own tip, with the far
    // end's commit date — a date no local file in this world carries, so the
    // assertion below can only pass if the far end is what answered.
    writeFileSync(join(w.root, 'bin', 'gh'),
      `#!/bin/bash\necho "${w.tip} 2026-08-17T06:43:00Z"\n`);
    const st = w.run();
    assert.equal(st.connected, true);
    assert.equal(st.pushed, true);
    assert.equal(st.last, '2026-08-17T06:43:00Z', 'last push comes from the far end, not a frozen ref');
    assert.equal(st.repo, 'https://github.com/acme/acme-brain', 'and the repo is named without its .git tail');
  } finally { w.done(); }
});

test('an unreachable far end falls back to the tracking ref: the pre-fix behaviour, never worse', () => {
  const w = world({ ghScript: 'exit 1', trackingRef: true });
  try {
    const st = w.run();
    assert.equal(st.pushed, true, 'the ref is still proof a push once landed');
    assert.ok(st.last, 'and its date still answers, stale beating blank');
  } finally { w.done(); }
});

test('a tip this brain has never seen reads as NOT backed up, whatever refs a rejected push left (trap 36)', () => {
  const w = world({ trackingRef: true });
  try {
    // A full-length sha that is not an object in this brain: the wired remote
    // is another box's repo. The old verb answered pushed:true here, from a
    // tracking ref alone.
    writeFileSync(join(w.root, 'bin', 'gh'),
      '#!/bin/bash\necho "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2026-08-01T00:00:00Z"\n');
    const st = w.run();
    assert.equal(st.connected, true);
    assert.equal(st.pushed, false, 'the far end just said this brain is not there; believe it');
  } finally { w.done(); }
});

test('no remote reads as not connected, and the far end is never asked', () => {
  const w = world({ remote: '', ghScript: 'echo ASKED >> "$(dirname "$0")/asked"; exit 1' });
  try {
    const st = w.run();
    assert.equal(st.connected, false);
    assert.equal(st.pushed, false);
    assert.throws(() => sh(w.root, 'cat bin/asked'), 'an empty slug must not become a gh api call');
  } finally { w.done(); }
});

test('the command itself: the inert fetch is gone, and the ask carries the connect flow’s token store', () => {
  assert.ok(!/git[^;|]*fetch/.test(COMMAND),
    'the credential-less fetch could only ever fail against a private repo (196)');
  assert.match(COMMAND, /GH_CONFIG_DIR=\/state\/\.kernel\/gh/,
    'gh must read the token connect-github installed, or this read fails exactly like the fetch did');
  assert.match(COMMAND, /gh api "repos\/\$SLUG\/commits\?per_page=1"/, 'ask the far end');
  assert.match(COMMAND, /unset GH_TOKEN GITHUB_TOKEN/,
    'an env token would silently answer as the wrong account (the install leg’s own rule)');
  // the sed that derives the slug is single-quoted: `"s#\.git$##"` in double
  // quotes expands `$#` and the expression dies (the backup leg's own trap,
  // caught there only because its tests drive the shell for real; same here).
  assert.match(COMMAND, /sed -e 's#\^https:/, 'slug sed is single-quoted');
});
