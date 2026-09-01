// gh-device-login.test.mjs — the terminal route must not be a menu. Run:
//   node --test engine/gh-device-login.test.mjs
//
// THE TRAP. `connect-github` called a bare `gh auth login`, so anyone who typed
// it landed in the GitHub CLI's interactive picker: "Authenticate Git with your
// GitHub credentials?" then "How would you like to authenticate GitHub CLI?"
// with an arrow-key list. Sam, looking at that on a rock: "pretty intimidating
// for a non-technical user". This product's whole premise is that you do not
// need a terminal, so the fallback path has to be gentle too.
//
// These are structural checks on the script pair, plus a real run of the login
// against a fake `gh` and a fake GitHub, because "it prints two lines and no
// menu" is a behaviour, not a claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SH = readFileSync(join(HERE, 'connect-github.sh'), 'utf8');
const LOGIN = join(HERE, 'gh-device-login.mjs');

test('connect-github never opens the interactive picker', () => {
  // A bare `gh auth login` with no --with-token and no device flow IS the menu.
  const bare = SH.split('\n').filter((l) => !/^\s*#/.test(l))
    .filter((l) => /gh auth login/.test(l) && !/--with-token/.test(l));
  assert.deepEqual(bare, [], `these open the CLI's arrow-key picker:\n${bare.join('\n')}`);
  assert.match(SH, /gh-device-login\.mjs/, 'the promptless device flow is what it calls instead');
});

test('the old menu-driving copy is gone with the menu', () => {
  assert.doesNotMatch(SH, /choose 'Login with a web browser'/,
    'copy that talks someone through a menu is a bug once there is no menu');
});

test('it resolves its sibling through the symlink both images install', () => {
  // /usr/local/bin/connect-github -> /app/engine/connect-github.sh, so a plain
  // dirname "$0" would look in /usr/local/bin and find nothing.
  assert.match(SH, /readlink -f "\$0"/);
});

/**
 * A fake `gh` that records its argv, and a fetch stub standing in for GitHub.
 * NO http server: a background listener under execFileSync never lets the pipe
 * close, which is a hang rather than a test.
 */
function rig({ authed = false, tokenAfter = 1, deny = false } = {}) {
  const dir = tmpDir('ghlogin-');
  const log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'gh'), [
    '#!/usr/bin/env bash',
    `echo "$@" >> ${log}`,
    `[ "$1" = "auth" ] && [ "$2" = "status" ] && exit ${authed ? 0 : 1}`,
    '[ "$1" = "auth" ] && [ "$2" = "login" ] && { cat > /dev/null; exit 0; }',
    '[ "$1" = "auth" ] && exit 0',
    '[ "$1" = "api" ] && { echo "acme-collective"; exit 0; }',
    'exit 0',
  ].join('\n'));
  chmodSync(join(dir, 'gh'), 0o755);

  const shim = join(dir, 'shim.mjs');
  writeFileSync(shim, `
let polls = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  const j = (o) => ({ json: async () => o });
  if (u.includes('/device/code')) {
    return j({ device_code: 'dev123', user_code: 'WXYZ-9876', verification_uri: 'https://github.com/login/device', interval: 0, expires_in: 60 });
  }
  polls += 1;
  if (${deny}) return j({ error: 'access_denied' });
  if (polls >= ${tokenAfter}) return j({ access_token: 'gho_from_fake' });
  return j({ error: 'authorization_pending' });
};
// call main() directly: the module only self-runs when argv[1] IS the script,
// which under a shim it is not (that guard is deliberate, see the module).
const m = await import(${JSON.stringify(LOGIN)});
process.exit(await m.main());
`);
  return { dir, log, shim };
}

function runLogin(r) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [r.shim], {
        encoding: 'utf8', timeout: 30000,
        env: { ...process.env, PATH: `${r.dir}:${process.env.PATH}`, GH_CONFIG_DIR: join(r.dir, 'ghcfg') },
      }),
    };
  } catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
}

test('a fresh box prints a URL and a code, and no menu', () => {
  const r = rig({ authed: false, tokenAfter: 2 });
  const res = runLogin(r);
  assert.match(res.out, /github\.com\/login\/device/, 'where to go');
  assert.match(res.out, /WXYZ-9876/, 'and the code to type');
  assert.match(res.out, /Signed in as acme-collective/);
  assert.doesNotMatch(res.out, /arrows to move|How would you like to authenticate/i);
  // The token goes in over stdin, so it must never appear in gh's argv.
  const calls = readFileSync(r.log, 'utf8');
  assert.match(calls, /auth login --with-token --hostname github\.com/);
  assert.doesNotMatch(calls, /gho_from_fake/, 'a token in argv is in every process list on the box');
});

test('an already-signed-in box says so and stops', () => {
  const r = rig({ authed: true });
  const res = runLogin(r);
  assert.match(res.out, /Already signed in/);
  assert.doesNotMatch(res.out, /WXYZ-9876/, 'no code is minted when none is needed');
});

test('a declined sign-in says nothing changed, and exits non-zero', () => {
  const r = rig({ authed: false, deny: true });
  const res = runLogin(r);
  assert.match(res.out, /declined/i);
  assert.match(res.out, /Nothing changed/i);
  assert.notEqual(res.code, 0, 'connect-github keys off this to stop before creating anything');
});

// -------------------------------------------------- a retry must not be punished
//
// 2026-08-10: the sign-in finished, the Custody card repainted to "No offsite
// copy yet", and nothing said why. `gh repo create` refuses with "Name already
// exists on this account" the second time, and a second time is exactly what a
// retry is (or someone who ran connect-github by hand and got part-way). Every
// other re-run in this product is the error-recovery contract; this leg was the
// one place that punished it.

/** connect-github with fake gh + git, both recording their argv.
 *
 * `isPrivate` was added 2026-08-20 with the visibility probe. The old fake
 * answered every `gh api` with the login string, which is what let the adopt
 * branch through without ever asking whether the repo it was adopting was
 * private. The two `gh api` forms now answer separately, which is the whole
 * point of the fix: existence and visibility are different questions.
 */
function repoRig({ repoExists, isPrivate = true }) {
  const dir = tmpDir('cgh-');
  const log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'gh'), [
    '#!/usr/bin/env bash',
    `echo "gh $@" >> ${log}`,
    '[ "$1" = "auth" ] && exit 0',
    '[ "$1" = "api" ] && [ "$2" = "user" ] && { echo "acme-collective"; exit 0; }',
    `[ "$1" = "api" ] && { ${repoExists ? `echo "${isPrivate}"; exit 0` : 'exit 1'}; }`,
    `[ "$1" = "repo" ] && [ "$2" = "view" ] && exit ${repoExists ? 0 : 1}`,
    '[ "$1" = "repo" ] && [ "$2" = "create" ] && { echo "created"; exit 0; }',
    'exit 0',
  ].join('\n'));
  writeFileSync(join(dir, 'git'), [
    '#!/usr/bin/env bash',
    `echo "git $@" >> ${log}`,
    // "no origin yet" so the script does not take its already-connected shortcut
    '[ "$1" = "remote" ] && [ "$2" = "get-url" ] && exit 1',
    'exit 0',
  ].join('\n'));
  for (const f of ['gh', 'git']) chmodSync(join(dir, f), 0o755);
  const box = join(dir, 'brain');
  mkdirSync(box, { recursive: true });   // the script cds into it before anything else
  // The guard reads the canonical never-commit set as a sibling of the script,
  // and refuses to push at all when it cannot. Ship the real file into the rig
  // so these tests exercise the list the images actually carry.
  mkdirSync(join(dir, 'lib'), { recursive: true });
  copyFileSync(join(HERE, 'lib', 'brain-ignore.txt'), join(dir, 'lib', 'brain-ignore.txt'));
  writeFileSync(join(dir, 'run.sh'), readFileSync(join(HERE, 'connect-github.sh'), 'utf8'));
  return { dir, log, box };
}

function runConnect(r) {
  try {
    const out = execFileSync('bash', [join(r.dir, 'run.sh')], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PATH: `${r.dir}:/usr/bin:/bin`, STATE_DIR: r.box, HOME: r.dir },
    });
    return { code: 0, out, calls: readFileSync(r.log, 'utf8') };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || ''), calls: readFileSync(r.log, 'utf8') };
  }
}

test('an existing repo is ADOPTED, not treated as a failure', () => {
  const r = repoRig({ repoExists: true });
  const res = runConnect(r);
  assert.doesNotMatch(res.calls, /gh repo create/, 'creating it again is the error this fixes');
  assert.match(res.calls, /git remote (add|set-url) origin/, 'it points the brain at the repo that exists');
  assert.match(res.calls, /git push -u origin HEAD/, 'and pushes to it');
  assert.match(res.out, /already have/i);
});

test('a first run still creates the repo', () => {
  const r = repoRig({ repoExists: false });
  const res = runConnect(r);
  assert.match(res.calls, /gh repo create .*--private/, 'the normal path is unchanged');
});

test('both paths end on the same success line the app parses', () => {
  const src = readFileSync(join(HERE, 'connect-github.sh'), 'utf8');
  const done = src.split('\n').filter((l) => !/^\s*#/.test(l)).filter((l) => /private GitHub repo/.test(l));
  assert.equal(done.length, 1, 'one success line, reached by both branches, or the app can only read one of them');
  assert.match(src, /^set -euo pipefail$/m, 'and a failed push must abort before it, never print it');
});

// ------------------------------------------- which directory is the brain
//
// Sam ran the connect on test-org-4 and the backup leg reported "/state is not a
// git repository. Run `git -C "/state" init`". It was pointed at the wrong
// directory: the ROCK branch was guarded by `[ -z "${STATE_DIR:-}" ]` under the
// note "STATE_DIR still wins", and STATE_DIR is exported on every box, so the
// guard was never false and the rock branch was dead code from the day it landed.

/** Run only the resolution block, and report what it chose. */
function resolveBox(env, rockRoot = null) {
  const src = readFileSync(join(HERE, 'connect-github.sh'), 'utf8');
  let block = src.slice(src.indexOf('if [ -n "${AIOS_BRAIN_ROOT:-}" ]'), src.indexOf('export GH_CONFIG_DIR="${GH_CONFIG_DIR:-$BOX/.kernel/gh}"'));
  // The rock marker is an absolute path this machine does not have, so for the
  // rock cases the SAME logic is run with that one path pointed at a fixture.
  if (rockRoot) block = block.replaceAll('/state/brain', rockRoot);
  const dir = tmpDir('box-');
  const f = join(dir, 'probe.sh');
  writeFileSync(f, `set -euo pipefail\n${block}\necho "BOX=$BOX"\necho "GHCFG=${'${GH_CONFIG_DIR:-unset}'}"\n`);
  return execFileSync('bash', [f], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } }).trim();
}

test('THE BUG: a rock with STATE_DIR set still resolves to its BRAIN, not /state', () => {
  // Rocks export STATE_DIR=/state. Before the fix that alone sent the whole
  // script at /state, which is not a git repository, and the error told the
  // owner to `git init` it.
  const rock = tmpDir('rock-');
  const brain = join(rock, 'brain');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, 'org-policy.yaml'), 'org:\n  name: "acme"\n');
  const out = resolveBox({ STATE_DIR: rock }, brain);
  assert.match(out, new RegExp(`BOX=${brain}$`, 'm'), 'the marker decides, not a STATE_DIR that is not a brain');
  assert.doesNotMatch(out, new RegExp(`BOX=${rock}$`, 'm'));
});

test('and the rock keeps its gh auth OUTSIDE the repo it pushes', () => {
  // A token inside the brain tree is one `git add -A` away from being uploaded.
  const rock = tmpDir('rockgh-');
  const brain = join(rock, 'brain');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, 'org-policy.yaml'), 'org:\n  name: "acme"\n');
  assert.match(resolveBox({ STATE_DIR: rock }, brain), /GHCFG=\/state\/\.kernel\/gh/);
});

test('a STATE_DIR that IS a brain still wins, so a relocated box keeps working', () => {
  const dir = tmpDir('relocated-');
  writeFileSync(join(dir, 'org-policy.yaml'), 'org:\n  name: "acme"\n');
  assert.match(resolveBox({ STATE_DIR: dir }), new RegExp(`BOX=${dir}$`, 'm'));
});

test('an explicit AIOS_BRAIN_ROOT beats everything', () => {
  const dir = tmpDir('explicit-');
  assert.match(resolveBox({ AIOS_BRAIN_ROOT: dir, STATE_DIR: '/state' }), new RegExp(`BOX=${dir}$`, 'm'));
});

test('a member box, which has no org-policy.yaml anywhere, still gets /state', () => {
  assert.match(resolveBox({ STATE_DIR: '/state' }), /BOX=\/state$/m);
});

test('a brain that is not a git repository is initialised, not diagnosed at the user', () => {
  const src = readFileSync(join(HERE, 'connect-github.sh'), 'utf8');
  assert.match(src, /git rev-parse --git-dir/, 'it checks');
  assert.match(src, /git init -q -b main/, 'and fixes it, rather than printing a command to type');
  assert.ok(src.indexOf('git rev-parse --git-dir') < src.indexOf('git remote get-url origin'),
    'and does so before anything asks about remotes');
});

test('the dead guard is gone for good', () => {
  const src = readFileSync(join(HERE, 'connect-github.sh'), 'utf8');
  assert.doesNotMatch(src, /if \[ -z "\$\{STATE_DIR:-\}" \] && \[ -f \/state\/brain\/org-policy\.yaml \]/,
    'STATE_DIR is set on every box, so this condition never fired');
});
