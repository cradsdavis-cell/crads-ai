// promoted-rock-github.test.mjs — the org GitHub resolver reads the credential
// a MEMBER-BORN rock actually has.
// Run: node --test wizard/panel/promoted-rock-github.test.mjs
//
// The lie this pins away (ingrid, 2026-08-17). own-brain.mjs stores the
// member's device-flow token at /state/.kernel/brain-github-token and wires git
// through a credential helper; it never configures the gh CLI. ORG_GH_RESOLVE
// checked env (staged provisioning, which a hosted promoted rock has none of)
// and then `gh auth token` (a config the member flow never wrote), found
// nothing, and factory-status reported "No GitHub account is connected" — on
// the SAME screen session whose Custody card was reporting a successful backup
// push minutes earlier, made with that very token. Two readers, one truth,
// finding 196/107 shape: the org machinery never learned where a member-born
// box keeps things.
//
// Method: slice the REAL resolver out of the built factory-status command and
// run it in bash against a fixture box (the suite's standard technique), so the
// pin exercises the shipped shell, not a paraphrase of it.
//
// The face collapse (2026-09-01): factory-status is no longer SERVED (the one
// verb table is MEMBER_VERBS plus the Catalogue dozen), but its builder stays
// exported for exactly these unit truths until the machinery is deleted, so
// the member-token rung keeps its pins. Fixed the same day: the fixture used
// to leave the REAL gh first on PATH, so on a signed-in machine `gh auth
// token` answered before the member-token rung and PRINTED the developer's
// own PAT into the test output. The gh rung is now shadowed with a stub that
// refuses, which is the promoted-rock reality these tests model anyway (the
// member flow never configures the gh CLI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { VERBS } from './panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const CMD = VERBS['factory-status'].build().command;

// The resolver as shipped: GH_CONFIG_DIR export through the GH_TOKEN export.
function resolverSlice() {
  const a = CMD.indexOf('export GH_CONFIG_DIR=');
  const bMark = 'export GH_TOKEN="${GH_TOKEN:-$ORG_GH_TOKEN}"; ';
  const b = CMD.indexOf(bMark);
  assert.ok(a > -1 && b > a, 'the resolver is present in factory-status');
  return CMD.slice(a, b + bMark.length);
}

// A promoted rock in miniature: a git repo whose origin names the owner, and a
// member token file beside it. The literal /state path is swapped for the
// fixture's — the ONE substitution, everything else runs verbatim.
function fixture({ token = 'ghp_membertoken' } = {}) {
  const box = tmpDir('promoted-');
  const repo = path.join(box, 'brainroot');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:ingrid-owner/ingrid-brain.git'], { cwd: repo });
  const tok = path.join(box, 'brain-github-token');
  if (token != null) writeFileSync(tok, token, { mode: 0o600 });
  // A gh that refuses auth, first on PATH: a member-born rock has no gh login,
  // and the real gh on a developer machine must never answer for the fixture
  // (it did once, and its answer was the developer's own live PAT).
  const bin = path.join(box, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env bash\n[ "$1" = auth ] && exit 1\n[ "$1" = api ] && exit 1\nexit 1\n');
  chmodSync(path.join(bin, 'gh'), 0o755);
  return { repo, tok, bin };
}

function resolve({ repo, tok, bin, env = {} }) {
  const script = resolverSlice().replaceAll('/state/.kernel/brain-github-token', tok)
    + 'printf %s "${ORG_GH_OWNER:-}|${ORG_GH_TOKEN:-}"';
  return execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    // BR set as factory-status sets it (BR_RESOLVE runs before the resolver).
    // The stub gh leads PATH (see fixture); GH_CONFIG_DIR stays pinned to a
    // void as belt and braces against a keyring-backed real gh. HOME is a
    // scratch dir (the runPreamble pattern in factory-arming.test.mjs): with
    // the developer's real HOME, this box's bash sources ~/.bashrc, which
    // sources the operator env file, and the fixture inherits a LIVE
    // GITHUB_TOKEN through that side door. That is how a real PAT reached the
    // test output once (hygiene finding, 2026-09-01). The staged rungs are
    // blanked as well, belt and braces; a test that stages credentials on
    // purpose overrides these via `env`.
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: repo, BR: repo,
           GH_CONFIG_DIR: path.join(repo, 'no-such-gh'),
           ORG_GH_OWNER: '', ORG_GH_TOKEN: '', IC_ORG: '', IC_ORG_TOKEN: '',
           GH_OWNER: '', GITHUB_TOKEN: '', GH_TOKEN: '', ...env },
  });
}

test('factory-status is not SERVED any more: the member table never gained it', async () => {
  // The rung below stays pinned as a builder truth; this pin holds the other
  // half of the collapse: no served surface reaches the org resolver.
  const { MEMBER_VERBS } = await import('./panel-server.mjs');
  assert.equal(MEMBER_VERBS['factory-status'], undefined);
});

test('a member-born rock resolves its GitHub from the member token file', () => {
  const f = fixture();
  assert.equal(resolve(f), 'ingrid-owner|ghp_membertoken',
    'owner from the brain origin remote, token from /state/.kernel/brain-github-token');
});

test('staged provisioning still wins over the member token', () => {
  // The fallback must be a LAST resort: a rock whose operator staged org
  // credentials keeps using them even if a member token also exists.
  const f = fixture();
  assert.equal(resolve({ ...f, env: { ORG_GH_OWNER: 'acme-org', ORG_GH_TOKEN: 'ghp_staged' } }),
    'acme-org|ghp_staged');
});

test('no token file, no gh login: the resolver stays empty and honest', () => {
  const f = fixture({ token: null });
  assert.equal(resolve(f), '|', 'nothing resolves to nothing — never an invented credential');
});

test('the shipped command still verifies the token instead of trusting presence', () => {
  // Presence is not proof (2026-08-10): the resolver hands the token to
  // ORG_GH_VERIFY, which asks GitHub. The fallback must not have reordered that.
  const at = CMD.indexOf('brain-github-token');
  const verify = CMD.indexOf('GHOK=""');
  assert.ok(at > -1, 'the member-token rung is in the shipped command');
  assert.ok(verify > at, 'and ORG_GH_VERIFY still runs after every resolve rung');
});
