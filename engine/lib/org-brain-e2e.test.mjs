// org-brain-e2e.test.mjs — spec §10 acceptance: the enclave trap never reaches the org repo,
// in any file OR in git history; real facts cross with provenance; hub digest includes them.
// Run: node --test engine/lib/org-brain-e2e.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { publish } from './org-publish.mjs';
import { synthesize } from '../ops/org-brain-hub.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const TRAPS = ['TRAP_SALARY_XK91', 'TRAP_GRIPE_ZQ77'];

test('planted enclave content never reaches the org repo; legit facts do, with provenance', async () => {
  // origin: bare init with -b main so the empty-repo clone's symbolic HEAD is deterministically
  // 'main' regardless of the box's git config default-branch, and we push an initial commit
  // before publish runs so refs/heads/main actually exists — an empty bare's HEAD ref is
  // unborn until something lands on it, so a later `git clone` of the bare (for the hub view)
  // would otherwise check out nothing. Mirrors org-publish.test.mjs's seedOrgState() (Task 4).
  const bare = tmpDir('e2e-origin-') + '/org.git';
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
  // member box state
  const state = tmpDir('e2e-state-');
  writeFileSync(path.join(state, 'profile.yaml'), 'identity:\n  timezone: "UTC"\ntimezone: "UTC"\n');
  mkdirSync(path.join(state, 'wiki', 'personal'), { recursive: true });
  mkdirSync(path.join(state, 'wiki', 'projects'), { recursive: true });
  writeFileSync(path.join(state, 'wiki', 'log.md'), '# Log\n- 2026-07-24 ACME quote sent at agreed rate\n');
  writeFileSync(path.join(state, 'wiki', 'projects', 'acme.md'), '# ACME\nQuote sent, awaiting reply.\n');
  writeFileSync(path.join(state, 'wiki', 'personal', 'salary.md'), `my salary is ${TRAPS[0]}\n`);
  writeFileSync(path.join(state, 'wiki', 'vent.md'), `---\nenclave: true\n---\ncolleague vent ${TRAPS[1]}\n`);
  // enrol (mirrors org-brain-setup.sh, inline for hermetic test)
  mkdirSync(path.join(state, 'org'), { recursive: true });
  const clone = path.join(state, 'org', 'brain');
  execFileSync('git', ['clone', '-q', bare, clone]);
  const gitEnv = { ...process.env, GIT_COMMITTER_NAME: 'box', GIT_COMMITTER_EMAIL: 'box@local', GIT_AUTHOR_NAME: 'box', GIT_AUTHOR_EMAIL: 'box@local' };
  execFileSync('git', ['-C', clone, 'commit', '-q', '--allow-empty', '-m', 'init'], { env: gitEnv });
  execFileSync('git', ['-C', clone, 'push', '-q', 'origin', 'HEAD:main']);
  writeFileSync(path.join(state, 'org', 'config.json'), JSON.stringify({ slug: 'boxa', remote: bare }));
  // publish (dry = deterministic extract path) then hub
  const r = await publish(state, { dryRun: true });
  assert.equal(r.ok, true);
  const hubClone = tmpDir('e2e-hub-');
  execFileSync('git', ['clone', '-q', bare, hubClone]);
  const s = synthesize(hubClone);
  assert.deepEqual(s.members, ['boxa']);
  // 1) traps absent from every file AND from all git history
  const tree = execFileSync('grep', ['-rIl', '.', hubClone, '--exclude-dir=.git'], { encoding: 'utf8' });
  for (const f of tree.trim().split('\n')) {
    if (!f) continue;
    const body = execFileSync('cat', [f], { encoding: 'utf8' });
    for (const t of TRAPS) assert.ok(!body.includes(t), `${t} leaked into ${f}`);
  }
  const history = execFileSync('git', ['-C', hubClone, 'log', '-p', '--all'], { encoding: 'utf8' });
  for (const t of TRAPS) assert.ok(!history.includes(t), `${t} leaked into git history`);
  // 2) the legitimate fact crossed, attributed
  const updates = execFileSync('cat', [path.join(hubClone, 'members', 'boxa', 'updates.md')], { encoding: 'utf8' });
  assert.match(updates, /ACME quote sent/);
  assert.match(updates, /^source: boxa\/wiki\/log\.md · \d{4}-\d{2}-\d{2}$/m);
  // 3) digest carries it
  const digest = execFileSync('cat', [s.digestPath], { encoding: 'utf8' });
  assert.match(digest, /boxa/);
});
