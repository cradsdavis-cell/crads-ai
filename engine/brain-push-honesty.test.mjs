// brain-push-honesty.test.mjs — the backup row must not read "ok" when it failed.
// Run: node --test engine/brain-push-honesty.test.mjs
//
// Why this file exists. brain-push.sh exited 0 on EVERY path, including the
// protective-.gitignore refusal and a failed git push. The scheduler classifies
// this job purely by exit code (scheduler.mjs: status: e ? 'fail' : 'ok'), so
// the run ledger recorded "ok" and the member's Cadence row printed
// "· last: ok" for a nightly backup that had never once succeeded. This is the
// one job that carries data off the box.
//
// The member console got it right by scanning brain-push.log for a real
// " pushed to " line, so two screens in the same app contradicted each other.
//
// Exits that must STAY 0: no brain dir, not a git repo, no origin remote. Those
// all mean own-brain has not run yet — there is nowhere to push and nothing has
// gone wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../tests/tmp-dir.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'brain-push.sh');
// say() writes to <state>/cockpit/brain-push.log, never to stdout.
const run = (state) => {
  const r = spawnSync('bash', [SCRIPT, state], { encoding: 'utf8' });
  const log = join(state, 'cockpit', 'brain-push.log');
  r.log = existsSync(log) ? readFileSync(log, 'utf8') : '';
  return r;
};
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function stateWith({ brain = true, repo = false, remote = '', gitignore = null } = {}) {
  const d = tmpDir('bpush-');
  if (brain) mkdirSync(join(d, 'brain'), { recursive: true });
  if (repo) {
    git(join(d, 'brain'), 'init', '-q');
    git(join(d, 'brain'), 'config', 'user.email', 'b@b.local');
    git(join(d, 'brain'), 'config', 'user.name', 'box');
    writeFileSync(join(d, 'brain', 'note.md'), 'x');
    if (gitignore !== null) writeFileSync(join(d, 'brain', '.gitignore'), gitignore);
    git(join(d, 'brain'), 'add', '-A');
    git(join(d, 'brain'), 'commit', '-qm', 'seed');
    if (remote) git(join(d, 'brain'), 'remote', 'add', 'origin', remote);
  }
  return d;
}

test('a box with no brain yet is not a failure', () => {
  const r = run(stateWith({ brain: false }));
  assert.equal(r.status, 0, 'own-brain has not run; there is nowhere to push');
});

test('a brain with no origin remote is not a failure either', () => {
  const r = run(stateWith({ repo: true, gitignore: 'secrets/\n.env\n' }));
  assert.equal(r.status, 0);
  assert.match(r.log, /not connected to a repo yet|no origin remote/);
});

test('a protective-gitignore REFUSAL exits non-zero', () => {
  const r = run(stateWith({ repo: true, remote: 'ssh://git@example.invalid/x.git', gitignore: '# nothing protective\n' }));
  assert.match(r.log, /REFUSED/, `it must still refuse; log was: ${r.log}`);
  assert.notEqual(r.status, 0, 'and the ledger must hear about it');
});

test('a failed push exits non-zero, so the backup row cannot read ok', () => {
  const r = run(stateWith({ repo: true, remote: 'ssh://git@no-such-host.invalid/x.git', gitignore: 'secrets/\n.env\n' }));
  assert.notEqual(r.status, 0, 'the one job that carries data off the box must report its own failure');
});

test('the scheduler still classifies purely by exit code, which is why this matters', () => {
  const sched = spawnSync('grep', ['-n', "status: e ? 'fail' : 'ok'", join(dirname(SCRIPT), 'cron', 'scheduler.mjs')], { encoding: 'utf8' });
  assert.equal(sched.status, 0, 'if this ever stops being true, revisit the exit codes above');
});
