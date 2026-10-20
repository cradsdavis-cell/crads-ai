// adopted-connect-github.test.mjs: Connect GitHub on a brain the server already
// works in, whose origin is an SSH host alias only the server can resolve.
// Run: node --test engine/adopted-connect-github.test.mjs
//
// Found 2026-10-20 on the first adopted server (trap 77): connect-github saw an
// origin, took the already-connected branch, never signed in, ran `git add -A`
// over the whole shared tree, committed it as "box", and then failed to push.
// The fix gives the MINERAL its own HTTPS route (insteadOf in the mineral's own
// git config) and never stages or commits the shared tree. Every test here holds
// the same three things to account: no commit, the server's view of origin
// unchanged, and (where it should) a push that really goes over HTTPS.
//
// No network: `gh` is a stub answering for one made-up repository, and a `git`
// wrapper stands in for GitHub by answering ls-remote and push for the HTTPS url
// only, after asking the real git which url it would use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../tests/tmp-dir.mjs';

const ENGINE = dirname(fileURLToPath(import.meta.url));
const ALIAS = 'git@github-brain:acme-owner/brain.git';
const HTTPS = 'https://github.com/acme-owner/brain.git';
const IDENT = ['-c', 'user.name=person', '-c', 'user.email=person@x'];

const git = (cwd, args, env) => {
  const r = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8', env: env || { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } });
  return { code: r.status, out: (r.stdout || '').trim(), err: r.stderr || '' };
};
const ok = (cwd, ...args) => { const r = git(cwd, args); assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.err}`); return r.out; };

// opts: moving (moving_in), signedIn, isPrivate, canPush, knowsTip, origin, homeOutside, fetched
function rig({ moving = true, signedIn = true, isPrivate = 'true', canPush = 'true', knowsTip = true,
  origin = ALIAS, homeOutside = false, fetched = true } = {}) {
  const dir = tmpDir('adopt-cgh-');
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  // What the alias reaches on the server: a repository with the person's history.
  const bare = join(dir, 'github-copy.git');
  ok('/', 'init', '-q', '--bare', '-b', 'master', bare);
  const brain = join(dir, 'folder');
  mkdirSync(brain);
  ok(brain, 'init', '-q', '-b', 'master');
  writeFileSync(join(brain, 'shared.md'), 'base\n');
  writeFileSync(join(brain, '.gitignore'), '.kernel/\nsecrets/\n');
  writeFileSync(join(brain, 'ownership.json'), JSON.stringify(moving ? { adopted: true, moving_in: true } : { adopted: true }) + '\n');
  ok(brain, 'add', '-A');
  ok(brain, ...IDENT, 'commit', '-q', '-m', 'the person\'s brain');
  ok(brain, 'remote', 'add', 'origin', bare);
  ok(brain, 'push', '-q', 'origin', 'master');
  // The push above already recorded origin/master; a brain that never fetched has none.
  if (fetched) ok(brain, 'fetch', '-q', 'origin'); else ok(brain, 'update-ref', '-d', 'refs/remotes/origin/master');
  ok(brain, 'remote', 'set-url', 'origin', origin);
  // Other people's work in progress, as the server had it that afternoon.
  writeFileSync(join(brain, 'shared.md'), 'half-edited by a session on the server\n');
  writeFileSync(join(brain, 'invoice.pdf'), '%PDF-1.4 not ours\n');
  writeFileSync(join(brain, 'report.crdownload'), 'partial\n');
  const tip = ok(brain, 'rev-parse', 'HEAD');

  const home = homeOutside ? join(dir, 'host-home') : join(brain, '.kernel', 'home');
  mkdirSync(home, { recursive: true });
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), [
    '#!/usr/bin/env bash',
    `echo "gh $*" >> ${log}`,
    `if [ "$1 $2" = "auth status" ]; then [ -f ${dir}/signed-in ] && exit 0; ${signedIn ? 'exit 0' : 'exit 1'}; fi`,
    '[ "$1" = "auth" ] && exit 0',
    'if [ "$1" = "api" ]; then',
    '  case "$2" in',
    `    repos/acme-owner/brain) [ "$4" = ".private" ] && echo "${isPrivate}"; [ "$4" = ".permissions.push" ] && echo "${canPush}"; exit 0 ;;`,
    `    repos/acme-owner/brain/commits/*) ${knowsTip ? 'echo "${2##*/}"; exit 0' : 'echo "{\\"message\\":\\"No commit found\\"}" >&2; exit 1'} ;;`,
    '  esac; exit 1',
    'fi',
    'exit 0',
  ].join('\n'));
  // GitHub, for the https url only. The real git decides which url it would use.
  writeFileSync(join(bin, 'git'), [
    '#!/usr/bin/env bash',
    'case "$1" in ls-remote|push)',
    '  U="$(/usr/bin/git remote get-url --push origin 2>/dev/null)"',
    `  echo "git $* -> $U" >> ${log}`,
    `  [ "$U" = "${HTTPS}" ] && exit 0`,
    `  case "$U" in /*|file://*) exec /usr/bin/git "$@" ;; esac`,
    '  echo "ssh: Could not resolve hostname: Name or service not known" >&2; exit 128 ;;',
    'esac',
    'exec /usr/bin/git "$@"',
  ].join('\n'));
  for (const f of ['gh', 'git']) chmodSync(join(bin, f), 0o755);
  // The device flow, stubbed: it records that it ran and signs in.
  writeFileSync(join(dir, 'gh-device-login.mjs'), `import { writeFileSync, appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, 'device-login\\n');\nwriteFileSync(${JSON.stringify(join(dir, 'signed-in'))}, '');\n`);
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'lib', 'brain-ignore.txt'), readFileSync(join(ENGINE, 'lib', 'brain-ignore.txt')));
  writeFileSync(join(dir, 'run.sh'), readFileSync(join(ENGINE, 'connect-github.sh')));
  return { dir, log, bare, brain, home, bin, tip };
}

// Everything about the shared folder that the server would notice.
function serverView(r) {
  return {
    head: ok(r.brain, 'rev-parse', 'HEAD'),
    status: ok(r.brain, 'status', '--porcelain', '--untracked-files=all'),
    index: ok(r.brain, 'ls-files', '-s'),
    gitconfig: readFileSync(join(r.brain, '.git', 'config'), 'utf8'),
    gitignore: readFileSync(join(r.brain, '.gitignore'), 'utf8'),
    origin: git(r.brain, ['remote', 'get-url', '--push', 'origin'], { PATH: '/usr/bin:/bin', HOME: join(r.dir, 'server-home') }).out,
  };
}
const mineralUrl = (r) => git(r.brain, ['remote', 'get-url', '--push', 'origin'], { PATH: '/usr/bin:/bin', HOME: r.home }).out;
const mineralCfg = (r) => (existsSync(join(r.home, '.gitconfig')) ? readFileSync(join(r.home, '.gitconfig'), 'utf8') : '');

function run(r) {
  const res = spawnSync('bash', [join(r.dir, 'run.sh')], {
    encoding: 'utf8', timeout: 60000,
    env: { PATH: `${r.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: r.home, STATE_DIR: r.brain },
  });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || ''), calls: readFileSync(r.log, 'utf8') };
}

test('moving in, alias origin: the mineral gets an HTTPS route; no commit, nothing pushed, the server\'s origin untouched', () => {
  const r = rig({ moving: true });
  const before = serverView(r);
  assert.equal(before.origin, ALIAS, 'precondition: the server sees its alias');
  assert.equal(mineralUrl(r), ALIAS, 'precondition: so does the mineral, which cannot resolve it');
  const res = run(r);
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(serverView(r), before, `the shared folder changed:\n${res.out}`);
  assert.equal(mineralUrl(r), HTTPS, `the mineral reaches the same repo over HTTPS:\n${mineralCfg(r)}`);
  assert.match(mineralCfg(r), /gh auth git-credential/, 'with gh as its credential helper');
  assert.match(mineralCfg(r), /GH_CONFIG_DIR=/, 'naming gh\'s config dir itself (app verbs run without box-up\'s env)');
  assert.doesNotMatch(res.calls, /^git push/m, `nothing is pushed while moving in:\n${res.calls}`);
  assert.match(res.out, /acme-owner\/brain over HTTPS/);
  assert.match(res.out, /still moving in/i);
});

test('moved in: existing commits push over HTTPS to the branch they are on; still no commit of anyone\'s work', () => {
  const r = rig({ moving: false });
  const before = serverView(r);
  const res = run(r);
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(serverView(r), before, res.out);
  assert.match(res.calls, new RegExp(`^git push -q origin HEAD:refs/heads/master -> ${HTTPS.replace(/\./g, '\\.')}$`, 'm'), res.calls);
  assert.doesNotMatch(res.calls, /push.*(-u|--force|--set-upstream)/, 'no force, no upstream written into the shared config');
});

test('not signed in yet: the device flow runs first, then the route is made', () => {
  const r = rig({ signedIn: false });
  const res = run(r);
  assert.equal(res.code, 0, res.out);
  assert.match(res.calls, /^device-login$/m, res.calls);
  assert.equal(mineralUrl(r), HTTPS);
});

test('a second press changes nothing more: one route, same server view', () => {
  const r = rig();
  run(r);
  const before = serverView(r);
  const cfg = mineralCfg(r);
  const res = run(r);
  assert.equal(res.code, 0, res.out);
  assert.equal(mineralCfg(r), cfg, 'the mineral config is stable across re-runs');
  assert.equal((cfg.match(/insteadOf/gi) || []).length, 1, cfg);
  assert.deepEqual(serverView(r), before);
});

for (const [name, opts, why] of [
  ['a repo GitHub does not show as private', { isPrivate: 'false' }, /private/],
  ['an account that cannot push to it', { canPush: 'false' }, /cannot push/],
  ['a GitHub repo without the commit the server last fetched (not the same repository)', { knowsTip: false }, /not have|same repository/],
  ['a brain that never fetched origin (nothing to prove it with)', { fetched: false }, /git fetch/],
  ['git settings outside the mineral (run by hand on the server)', { homeOutside: true }, /not running inside your mineral/],
]) {
  test(`fails closed on ${name}: nothing written anywhere, nothing pushed`, () => {
    const r = rig({ moving: false, ...opts });
    const before = serverView(r);
    const res = run(r);
    assert.notEqual(res.code, 0, res.out);
    assert.match(res.out, why, res.out);
    assert.deepEqual(serverView(r), before);
    assert.doesNotMatch(mineralCfg(r), /insteadOf/i, `no route left behind:\n${mineralCfg(r)}`);
    assert.doesNotMatch(res.calls, /^git push/m, res.calls);
  });
}

test('a folder on the server as origin: stops and says why, nothing written', () => {
  const r = rig({ origin: '/home/someone/backups/brain.git', moving: false });
  const before = serverView(r);
  const res = run(r);
  assert.notEqual(res.code, 0, res.out);
  assert.match(res.out, /folder on your server/, res.out);
  assert.deepEqual(serverView(r), before);
  assert.equal(mineralCfg(r), '');
  assert.doesNotMatch(res.calls, /^gh api/m, 'it does not even ask GitHub');
});

test('the pebble path is untouched: a non-adopted brain still takes the already-connected branch', () => {
  const src = readFileSync(join(ENGINE, 'connect-github.sh'), 'utf8');
  const guard = src.indexOf('if is_adopted "$BOX"; then adopted_connect; exit 0; fi');
  assert.ok(guard > 0, 'the adopted branch is one guarded line');
  assert.ok(guard < src.indexOf('# already connected? guard, then push.'), 'and it runs before the already-connected branch');
  assert.ok(guard < src.indexOf('git init -q -b main'), 'and before anything could start a repository');
  const body = src.slice(src.indexOf('adopted_connect() {'), guard);
  assert.doesNotMatch(body, /git (add|commit|rm)\b|>> *\.gitignore|remote (add|set-url)/, 'the adopted branch never stages, commits, untracks, edits .gitignore or rewrites origin');
});
