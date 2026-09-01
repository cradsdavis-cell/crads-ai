// connect-github-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../tests/tmp-dir.mjs';

// Derived from this file's own location, not hardcoded. The previous fallback
// was one operator's literal absolute checkout path, so the tests passed on that
// box and ENOENT'd on every other checkout, CI included: they were red on the
// runner from the day suite.yml started running them and green locally, which
// is the shape that hides a real failure rather than surfacing one.
const HERE = process.env.CGH_ENGINE || dirname(fileURLToPath(import.meta.url));
const LIST = join(HERE, 'lib', 'brain-ignore.txt');
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });

function rig({ gitignore = '', tracked = [], repoExists = false, isPrivate = 'true' } = {}) {
  const dir = tmpDir('cgh-guard-');
  const log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'gh'), [
    '#!/usr/bin/env bash',
    `echo "gh $@" >> ${log}`,
    '[ "$1" = "auth" ] && exit 0',
    `[ "$1" = "api" ] && [ "$2" = "user" ] && { echo "acme-owner"; exit 0; }`,
    `[ "$1" = "api" ] && { ${repoExists ? `echo "${isPrivate}"; exit 0` : 'exit 1'}; }`,
    `[ "$1" = "repo" ] && [ "$2" = "view" ] && exit ${repoExists ? 0 : 1}`,
    '[ "$1" = "repo" ] && [ "$2" = "create" ] && { echo created; exit 0; }',
    'exit 0',
  ].join('\n'));
  // real git, with a recording wrapper; only `push` is intercepted (no network)
  writeFileSync(join(dir, 'git'), [
    '#!/usr/bin/env bash',
    `echo "git $@" >> ${log}`,
    'for a in "$@"; do [ "$a" = "push" ] && exit 0; done',
    'exec /usr/bin/git "$@"',
  ].join('\n'));
  for (const f of ['gh', 'git']) chmodSync(join(dir, f), 0o755);
  mkdirSync(join(dir, 'lib'), { recursive: true });
  if (existsSync(LIST)) copyFileSync(LIST, join(dir, 'lib', 'brain-ignore.txt'));
  const box = join(dir, 'brain');
  mkdirSync(box, { recursive: true });
  git(box, 'init', '-q', '-b', 'main');
  writeFileSync(join(box, 'note.md'), 'content\n');
  writeFileSync(join(box, '.env'), 'ORG_PULL_TOKEN=ghp_thisisthesecret\n');
  writeFileSync(join(box, 'id.key'), 'PRIVATEKEY\n');
  writeFileSync(join(box, '.gitignore'), gitignore);
  for (const f of tracked) git(box, 'add', '-f', f);
  git(box, 'add', 'note.md', '.gitignore');
  git(box, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'seed');
  writeFileSync(join(dir, 'run.sh'), readFileSync(join(HERE, 'connect-github.sh'), 'utf8'));
  return { dir, log, box };
}
function run(r) {
  try {
    const out = execFileSync('bash', [join(r.dir, 'run.sh')], {
      encoding: 'utf8', timeout: 30000,
      env: { PATH: `${r.dir}:/usr/bin:/bin`, HOME: r.dir, STATE_DIR: r.box },
    });
    return { code: 0, out, calls: readFileSync(r.log, 'utf8') };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || ''), calls: existsSync(r.log) ? readFileSync(r.log, 'utf8') : '' };
  }
}
const headTracks = (box, p) => git(box, 'log', '--format=%H', '-1', '--', p).stdout.trim() !== '';

test('A: a brain whose history TRACKS .env never reaches GitHub with it', () => {
  const r = rig({ gitignore: '', tracked: ['.env', 'id.key'], repoExists: false });
  assert.equal(headTracks(r.box, '.env'), true, 'precondition: the seed history holds the token');
  const res = run(r);
  assert.equal(headTracks(r.box, '.env'), false,
    `the pushed history still carries .env. calls:\n${res.calls}\nout:\n${res.out}`);
  assert.equal(headTracks(r.box, 'id.key'), false, 'and the private key');
  assert.ok(existsSync(join(r.box, '.env')), 'the working file survives: this is a history fix, not a delete');
});

test('B: the canonical never-commit set is written before any push', () => {
  const r = rig({ gitignore: '', repoExists: false });
  run(r);
  const gi = readFileSync(join(r.box, '.gitignore'), 'utf8').split('\n');
  for (const need of ['.env', '*.key', '.claude-auth', '.kernel']) {
    assert.ok(gi.some((l) => l.trim() === need || l.trim() === need + '/' || l.trim() === need + '*'),
      `brain-push.sh REFUSES without ${need}, so connect-github must not leave a tree it will refuse. got:\n${gi.join('\n')}`);
  }
});

test('C: a PUBLIC repo of that name is refused, not silently adopted', () => {
  const r = rig({ gitignore: '.env\n*.key\n.claude-auth/\n.kernel/\n', repoExists: true, isPrivate: 'false' });
  const res = run(r);
  assert.doesNotMatch(res.calls, /git push/, `it must not push into a public repo. calls:\n${res.calls}`);
  assert.notEqual(res.code, 0, 'and it must say so with a failing exit');
  assert.match(res.out, /not private/i, `and name the reason. out:\n${res.out}`);
});

test('D: a PRIVATE repo of that name is still adopted', () => {
  const r = rig({ gitignore: '.env\n*.key\n.claude-auth/\n.kernel/\n', repoExists: true, isPrivate: 'true' });
  const res = run(r);
  assert.match(res.calls, /git remote (add|set-url) origin/);
  assert.match(res.out, /already have/i);
});
