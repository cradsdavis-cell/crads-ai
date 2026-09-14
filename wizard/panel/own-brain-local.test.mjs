// own-brain-local.test.mjs: the GitHub backup of a local brain folder
// (2026-09-11). GitHub is a fake fetcher; the push goes to a bare repo on disk,
// which proves the local git half end to end without a network.
//   node --test wizard/panel/own-brain-local.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { ownBrainLocal, pushLocalBrains, TOKEN_FILE } from './own-brain-local.mjs';

const fakeGh = (calls, { userOk = true } = {}) => async (url, init = {}) => {
  calls.push([init.method || 'GET', url.replace('https://api.github.com', '')]);
  const ok = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
  if (url.endsWith('/user')) return userOk ? ok({ login: 'mel' }) : ok({ message: 'bad' }, 401);
  if (url.endsWith('/user/repos')) return ok({ full_name: 'mel/idris-brain' }, 201);
  return ok({ message: 'nope' }, 404);
};

// git that pushes to a bare repo on disk instead of github: the remote url
// is rewritten for the test, everything else is the real command
const gitTo = (bare) => (cwd, args, opts = {}) => {
  const a = args.slice();
  const i = a.findIndex((x) => /^https:\/\/github\.com\//.test(x));
  if (i > -1) a[i] = bare;
  return spawnSync('git', a, { cwd, encoding: 'utf8', timeout: opts.timeout || 60000, stdio: ['ignore', 'pipe', 'pipe'] });
};

const brain = () => {
  const box = join(tmpDir('obl-'), 'idris');
  mkdirSync(join(box, 'wiki'), { recursive: true });
  mkdirSync(join(box, 'secrets'), { recursive: true });
  writeFileSync(join(box, 'wiki', 'me.md'), '# me\n');
  writeFileSync(join(box, 'secrets', 'telegram_bot_token'), 'SECRET');
  writeFileSync(join(box, '.env'), 'X=1\n');
  return box;
};
const bareRepo = () => { const d = join(tmpDir('bare-'), 'idris-brain.git'); execFileSync('git', ['init', '-q', '--bare', d]); return d; };

test('proves the token, creates the private repo, stores the token in the folder 0600, pushes with credentials excluded', async () => {
  const box = brain(); const bare = bareRepo(); const calls = []; const log = [];
  const r = await ownBrainLocal({ slug: 'idris', path: box, token: 'tok', fetcher: fakeGh(calls), git: gitTo(bare), log: (l) => log.push(l) });
  assert.deepEqual(r, { ok: true, repo: 'mel/idris-brain', pushed: true });
  assert.deepEqual(calls.slice(0, 2), [['GET', '/user'], ['POST', '/user/repos']]);
  const tok = join(box, TOKEN_FILE);
  assert.equal(readFileSync(tok, 'utf8'), 'tok');
  assert.equal(statSync(tok).mode & 0o777, 0o600);
  const tracked = execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(tracked.includes('wiki/me.md'), 'the brain is in the remote');
  for (const f of tracked) assert.ok(!/^(secrets\/|\.env|\.kernel\/)/.test(f), `${f} must not reach the remote`);
  assert.ok(log.some((l) => /pushed to mel\/idris-brain/.test(l)));
});

test('a refused token never touches the folder', async () => {
  const box = brain(); const calls = [];
  const r = await ownBrainLocal({ slug: 'idris', path: box, token: 'bad', fetcher: fakeGh(calls, { userOk: false }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not accepted \(HTTP 401\)/);
  assert.ok(!existsSync(join(box, TOKEN_FILE)));
  assert.ok(!existsSync(join(box, '.git')));
});

test('a missing folder or a bad slug is refused before any network call', async () => {
  const calls = [];
  assert.equal((await ownBrainLocal({ slug: 'Bad Slug', path: '/nope', token: 't', fetcher: fakeGh(calls) })).ok, false);
  assert.equal((await ownBrainLocal({ slug: 'ok', path: join(tmpDir('gone-'), 'nope'), token: 't', fetcher: fakeGh(calls) })).ok, false);
  assert.deepEqual(calls, []);
});

test('pushLocalBrains syncs only folders that have an origin, and never throws', async () => {
  const box = brain(); const bare = bareRepo(); const calls = [];
  const unowned = join(tmpDir('unowned-'), 'x'); mkdirSync(unowned, { recursive: true });
  await ownBrainLocal({ slug: 'idris', path: box, token: 'tok', fetcher: fakeGh(calls), git: gitTo(bare) });
  writeFileSync(join(box, 'wiki', 'later.md'), '# later\n');
  const r = await pushLocalBrains({ git: gitTo(bare), targets: [
    { host: 'idris-local', org: 'idris', kind: 'local', path: box },
    { host: 'x-local', org: 'x', kind: 'local', path: unowned },
    { host: 'acme-box', org: 'acme', kind: 'member' },
    null,
  ] });
  assert.deepEqual(r.pushed, ['idris-local']);
  assert.deepEqual(r.failed, []);
  const tracked = execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' });
  assert.ok(tracked.includes('wiki/later.md'));
});
