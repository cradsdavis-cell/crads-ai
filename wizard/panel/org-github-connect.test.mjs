// org-github-connect.test.mjs — the rock connects its GitHub from the app. Run:
//   node --test wizard/panel/org-github-connect.test.mjs
//
// WHY. A rock born through the door cannot stamp a pebble until its owner
// connects a GitHub account they own, and until 2026-08-10 the only way to do
// that was `connect-github` in a terminal. Sam, twice told that was the answer:
// "is there a more user friendly way of connecting up github rather than using
// the terminal". There was: the MEMBER seat has run the device flow in place
// since 2026-08-05 and the rock simply never got it.
//
// The load-bearing property, and the reason for the stdin tests below: the token
// must never reach argv, a command string, a log line or a response body. A
// credential in argv is one process list away from everybody.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrgGitHubRoutes } from './org-github-routes.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HOST = 'acme-rock';

/** Minimal req/res doubles: these routes only ever answer JSON. A `body`
 *  argument makes the req emit it through .on(data/end), the way the finding-199
 *  readBody consumes it; without one the bare {method,url} shape is kept, which
 *  also pins that readBody tolerates it. */
function reqres(method, path, body) {
  const res = { headers: null, body: null, writeHead(_c, h) { this.headers = h; }, end(b) { this.body = b; } };
  const req = { method, url: path };
  if (body !== undefined) {
    const handlers = {};
    req.on = (ev, cb) => { handlers[ev] = cb; if (ev === 'end') { if (handlers.data) handlers.data(JSON.stringify(body)); cb(); } return req; };
    req.destroy = () => {};
  }
  return [req, res];
}
const parse = (res) => JSON.parse(res.body);

function harness({ token = 'gho_secret_value', installCode = 0, installOut = 'LOGIN=acme-collective', pollResult, flowThrows = false } = {}) {
  const calls = [];
  const opts = {
    deviceFlow: async ({ scope }) => {
      calls.push({ kind: 'deviceFlow', scope });
      if (flowThrows) throw new Error('github unreachable');
      return {
        userCode: 'WXYZ-9876',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        poll: async () => pollResult || { ok: true, token },
      };
    },
    bridge: async (host, command, o = {}) => {
      calls.push({ kind: 'bridge', host, command, stdin: o.stdin });
      return { code: installCode, stdout: installOut, stderr: '' };
    },
  };
  const state = {};
  return { route: createOrgGitHubRoutes({ host: (want) => { calls.push({ kind: 'host', want: want || '' }); return HOST; }, state, opts }), state, calls };
}

/** start, then let the background install settle. */
async function connect(h) {
  const [req, res] = reqres('POST', '/org-github/start');
  assert.equal(h.route(req, res, '/org-github/start'), true);
  for (let i = 0; i < 40 && !['done', 'failed'].includes(h.state.stage); i++) await new Promise((r) => setImmediate(r));
  return res;
}

test('start returns the code and the URL, and nothing else', async () => {
  const h = harness();
  const res = await connect(h);
  const j = parse(res);
  assert.equal(j.userCode, 'WXYZ-9876');
  assert.equal(j.verificationUri, 'https://github.com/login/device');
  assert.equal('token' in j, false, 'the response must not carry a credential');
});

test('THE CREDENTIAL RULE: the token rides stdin, never the command', async () => {
  const h = harness({ token: 'gho_super_secret' });
  await connect(h);
  const install = h.calls.find((c) => c.kind === 'bridge');
  assert.ok(install, 'the token must actually be installed on the rock');
  assert.doesNotMatch(install.command, /gho_super_secret/, 'a token in argv is in every process list on the box');
  assert.equal(install.stdin, 'gho_super_secret\n');
  assert.match(install.command, /gh auth login --with-token/);
});

test('it installs where the factory reads, which is what arming means', async () => {
  const h = harness();
  await connect(h);
  const install = h.calls.find((c) => c.kind === 'bridge');
  assert.equal(install.host, HOST);
  assert.match(install.command, /GH_CONFIG_DIR=\/state\/\.kernel\/gh/,
    'the resolver reads gh under this exact config dir; anywhere else arms nothing');
  assert.match(install.command, /gh api user -q \.login/, 'and it proves the account works before claiming success');
});

test('the scope is the one a stamp actually needs', async () => {
  const h = harness();
  await connect(h);
  // repo creates the private repo and its deploy key; read:org is gh's own
  // requirement before it will store the token at all (2026-08-10 live run).
  assert.equal(h.calls.find((c) => c.kind === 'deviceFlow').scope, 'repo read:org');
});

test('status reports done with the account name, and never the token', async () => {
  const h = harness({ token: 'gho_super_secret' });
  await connect(h);
  const [req, res] = reqres('GET', '/org-github/status');
  h.route(req, res, '/org-github/status');
  const j = parse(res);
  assert.equal(j.stage, 'done');
  assert.equal(j.login, 'acme-collective');
  assert.doesNotMatch(JSON.stringify(j), /gho_super_secret/, 'the status payload must never carry the credential');
});

// A RELOAD MUST NOT LOSE THE CODE (2026-08-13, baseline run two).
//
// The user code lived only in the reply to /org-github/start, so the browser tab
// that asked was the only thing on earth that knew it. Driven as a user: press
// Connect GitHub, get code CA6A-8989, then do what the card itself instructs
// ("On your phone or any browser open github.com/login/device") and come back.
// The card had reset to a bare "Connect GitHub" while `/org-github/status` still
// answered `stage: waiting` and the server was still polling GitHub for that
// exact code. Pressing the button again mints a SECOND device code, which
// invalidates the one the owner is holding.
//
// So: while the flow is pending, status must carry enough to rebuild the screen.
test('a reloaded card can recover the code the server is still waiting on', async () => {
  // A poll that never settles holds the flow in `waiting`, which is where a
  // person actually is while they walk to their phone.
  const h = harness({ pollResult: new Promise(() => {}) });
  const [sreq, sres] = reqres('POST', '/org-github/start');
  h.route(sreq, sres, '/org-github/start');
  await new Promise((r) => setImmediate(r));
  assert.equal(h.state.stage, 'waiting', 'precondition: the flow is still pending');

  const [req, res] = reqres('GET', '/org-github/status');
  h.route(req, res, '/org-github/status');
  const j = parse(res);
  assert.equal(j.stage, 'waiting');
  assert.equal(j.userCode, 'WXYZ-9876', 'the pending code must survive a reload');
  assert.equal(j.verificationUri, 'https://github.com/login/device');
});

// The other half, and the reason the code is cleared rather than left lying
// about: a finished flow that still advertised a code would send someone to
// github.com to type a string that can no longer do anything.
test('a finished flow stops advertising a code that is spent', async () => {
  const h = harness();
  await connect(h);
  const [req, res] = reqres('GET', '/org-github/status');
  h.route(req, res, '/org-github/status');
  const j = parse(res);
  assert.equal(j.stage, 'done');
  assert.equal(j.userCode, '', 'a spent code must not be shown as pending');
});

// THE FIXTURE NOW MATCHES WHAT poll() REALLY RESOLVES. It used to say
// `{ ok:false, error:'access_denied' }`, a shape startDeviceFlow has never
// produced: its poll() resolves `{ ok:false, reason }` on every failing path
// (github-device-flow.mjs:50-57). So this test passed against a route that read
// `grant.error`, while in production that key was undefined and EVERY declined
// sign-in was reported as an expired code. A fixture that agrees with the bug
// proves nothing; this one is copied from the real return values.
test('a declined sign-in says so, and says nothing changed', async () => {
  const h = harness({ pollResult: { ok: false, reason: 'sign-in was denied or cancelled on GitHub' } });
  await connect(h);
  assert.equal(h.state.stage, 'failed');
  assert.match(h.state.reason, /declined/i);
  assert.match(h.state.reason, /Nothing changed/i);
  assert.equal(h.calls.some((c) => c.kind === 'bridge'), false, 'nothing may be written to the rock');
});

test('an expired code says how to get a fresh one', async () => {
  const h = harness({ pollResult: { ok: false, reason: 'the sign-in code expired before it was used; start again' } });
  await connect(h);
  assert.equal(h.state.stage, 'failed');
  assert.match(h.state.reason, /expired/i);
});

test('a failed install never claims success, and never echoes gh output', async () => {
  // gh prints the token back on some error paths, so the reason is written here
  // rather than lifted from stdout.
  const h = harness({ installCode: 11, installOut: 'STEP=login\nerror: token gho_super_secretvalue1234567890 is invalid' });
  await connect(h);
  assert.equal(h.state.stage, 'failed');
  assert.doesNotMatch(h.state.reason, /gho_super_secretvalue/);
  assert.match(h.state.reason, /could not store/i);
});

test('an unreachable rock is reported as unreachable, not as a GitHub problem', async () => {
  const h = harness();
  h.calls.length = 0;
  const route = createOrgGitHubRoutes({
    host: () => HOST,
    state: (h.state.stage = undefined, h.state),
    opts: {
      deviceFlow: async () => ({ userCode: 'X', verificationUri: 'u', poll: async () => ({ ok: true, token: 't' }) }),
      bridge: async () => { throw new Error('Connection timed out'); },
    },
  });
  const [req, res] = reqres('POST', '/org-github/start');
  route(req, res, '/org-github/start');
  for (let i = 0; i < 40 && h.state.stage !== 'failed'; i++) await new Promise((r) => setImmediate(r));
  assert.match(h.state.reason, /reach your rock/i);
});

test('GitHub refusing to start the flow is reported, not swallowed', async () => {
  const h = harness({ flowThrows: true });
  const [req, res] = reqres('POST', '/org-github/start');
  h.route(req, res, '/org-github/start');
  for (let i = 0; i < 20 && !res.body; i++) await new Promise((r) => setImmediate(r));
  assert.match(parse(res).error, /did not start/i);
});

test('with no rock connected it refuses instead of dialling an empty host', async () => {
  const route = createOrgGitHubRoutes({ host: () => null, state: {}, opts: {} });
  const [req, res] = reqres('POST', '/org-github/start');
  route(req, res, '/org-github/start');
  await new Promise((r) => setImmediate(r));
  assert.match(parse(res).error, /not connected to .* rock/i);
});

test('an unrelated path is not handled', () => {
  const h = harness();
  const [req, res] = reqres('GET', '/something-else');
  assert.equal(h.route(req, res, '/something-else'), false);
});

// ------------------------------------------------- one press, both jobs
//
// The Custody & backup card presses this button too. If connecting only armed
// the factory, that card would go on saying "no offsite copy yet" immediately
// after its own button reported success, which is the kind of half-truth the
// strength checklist already refuses to tell.

function harness2({ backupOut = 'BACKUP_REPO=acme-collective/acme-brain', backupThrows = false } = {}) {
  const calls = [];
  const state = {};
  const opts = {
    deviceFlow: async () => ({
      userCode: 'WXYZ-9876', verificationUri: 'https://github.com/login/device',
      poll: async () => ({ ok: true, token: 'gho_secret_value' }),
    }),
    bridge: async (host, command, o = {}) => {
      calls.push({ host, command, stdin: o.stdin });
      if (/connect-github/.test(command)) {
        if (backupThrows) throw new Error('box went away');
        return { code: 0, stdout: backupOut, stderr: '' };
      }
      return { code: 0, stdout: 'LOGIN=acme-collective', stderr: '' };
    },
  };
  return { route: createOrgGitHubRoutes({ host: () => HOST, state, opts }), state, calls };
}

test('one approval arms the factory AND connects the backup repo', async () => {
  const h = harness2();
  await connect(h);
  assert.equal(h.state.stage, 'done');
  assert.equal(h.state.login, 'acme-collective');
  assert.equal(h.state.repo, 'acme-collective/acme-brain', 'the card needs a repo to stop saying "no offsite copy"');
  assert.equal(h.calls.filter((c) => /connect-github/.test(c.command)).length, 1,
    'the backup leg reuses connect-github rather than reimplementing the repo rules');
});

test('an already-connected brain is recognised, not duplicated', async () => {
  const h = harness2({ backupOut: 'Already backing up to your repo\nBACKUP_REPO=acme-collective/acme-brain\n' });
  await connect(h);
  assert.equal(h.state.repo, 'acme-collective/acme-brain');
});

test('a remote pointing at another box’s repo is repointed, and said out loud', async () => {
  // Sam, 2026-08-12: the wired repo was the 10 Aug test rock's, the push was
  // rejected non-fast-forward, and the card then offered exactly one verb —
  // Push it now — which could only repeat it. Moving the remote is a surprising
  // thing to do silently, so it is a step of its own.
  const h = harness2({ backupOut: 'BACKUP_REPOINTED=1\nBACKUP_REPO=acme-collective/acme-brain-2\n' });
  await connect(h);
  assert.equal(h.state.repo, 'acme-collective/acme-brain-2');
  assert.equal(h.state.repointed, true);
  assert.ok(h.state.steps.some((s) => /another box/i.test(s)), 'the owner is told why the name changed');
});

test('a failed backup is a sentence, never git porcelain', async () => {
  // What Sam was actually shown: "hint: See the 'Note about fast-forwards' in
  // 'git push --help' for details.". A git manpage reference is not a diagnosis
  // for the person this product is for.
  const h = harness2({
    backupOut: 'To https://github.com/acme-collective/ai-os-brain.git\n'
      + ' ! [rejected]        HEAD -> main (non-fast-forward)\n'
      + "error: failed to push some refs\nhint: See the 'Note about fast-forwards' in 'git push --help' for details.\n"
      + 'BACKUP_UNDONE=1\nBACKUP_FAIL=push\n',
  });
  await connect(h);
  assert.doesNotMatch(h.state.backupError, /fast-forward|git push --help|hint:/,
    'no git porcelain reaches the card');
  assert.match(h.state.backupError, /nothing was wired up/i);
  assert.equal(h.state.repo || '', '', 'and it never claims a repo it could not push to');
});

// ---------------------------------------------- the backup half, on its own
//
// A rock that is already signed in and owes only a push has no business being
// sent back through a device code. The card's old answer for that (`org-brain-push`,
// a bare `git push` on the box) had no idea the remote could be the wrong repo,
// so it could only repeat the rejection. Same leg, same repoint, same verify.

test('the backup can be run on its own, without a second device code', async () => {
  const h = harness2();
  const [req, res] = reqres('POST', '/org-github/backup');
  assert.equal(h.route(req, res, '/org-github/backup'), true);
  for (let i = 0; i < 40 && h.state.stage !== 'done'; i++) await new Promise((r) => setImmediate(r));
  assert.equal(parse(res).started, true);   // answered async since the finding-199 body read
  assert.equal(h.state.repo, 'acme-collective/acme-brain');
  assert.equal(h.calls.filter((c) => /deviceFlow/.test(c.kind || '')).length, 0);
  assert.equal(h.calls.length, 1, 'one box round-trip: the backup leg and nothing else');
});

test('the backup half refuses to stack on a run already in flight', async () => {
  const h = harness2();
  h.state.stage = 'backing-up';
  const [req, res] = reqres('POST', '/org-github/backup');
  h.route(req, res, '/org-github/backup');
  await new Promise((r) => setImmediate(r));
  assert.match(parse(res).error, /already/i);
  assert.equal(h.calls.filter((c) => c.kind === 'bridge').length, 0, 'no box is dialled under an in-flight run');
});

test('the backup half with no rock connected refuses instead of dialling an empty host', async () => {
  const state = {};
  const route = createOrgGitHubRoutes({ host: () => null, state, opts: { bridge: async () => { throw new Error('must not dial'); } } });
  const [req, res] = reqres('POST', '/org-github/backup');
  assert.equal(route(req, res, '/org-github/backup'), true);
  await new Promise((r) => setImmediate(r));
  assert.match(parse(res).error, /not connected to .* rock/i);
});

test('FAIL-SOFT: a backup that does not take still leaves the factory armed', async () => {
  // The token landed, which is the job that was blocking pebbles. Calling the
  // whole sign-in failed here would send someone round the loop for nothing.
  const h = harness2({ backupThrows: true });
  await connect(h);
  assert.equal(h.state.stage, 'done');
  assert.equal(h.state.login, 'acme-collective');
  assert.equal(h.state.repo || '', '');
  assert.ok(h.state.steps.some((s) => /did not finish/i.test(s)), 'and it says so rather than implying a backup exists');
});

test('the backup leg never carries the token either', async () => {
  const h = harness2();
  await connect(h);
  const bk = h.calls.find((c) => /connect-github/.test(c.command));
  assert.doesNotMatch(bk.command, /gho_secret_value/);
  assert.equal(bk.stdin, undefined, 'it needs no secret: gh is already signed in on the box');
});

// ------------------------------------- the install step, and why it went dark
//
// Sam's first real run: the device flow worked, he approved the code, and the
// card said "Your rock could not store the account" with nothing else. Four
// different causes produced that one sentence, because the first version
// chained with `set -e` and printed nothing on failure (gh echoes the token back
// on some error paths and I did not want it in a log). Withholding everything is
// not a safety measure, it is an unreadable diagnosis.
//
// The confirmed mechanism: `gh auth login --with-token` EXITS 1 and stores
// nothing when GH_TOKEN or GITHUB_TOKEN is set in the environment, which the
// box's login shell can easily carry (every factory verb exports those names).

import { execFileSync as _x } from 'node:child_process';
import { chmodSync as _chmod, writeFileSync as _write, readFileSync as _read } from 'node:fs';
import { join as _join, dirname as _dirname } from 'node:path';
import { fileURLToPath as _furl } from 'node:url';

const ROUTES_SRC = _read(_join(_dirname(_furl(import.meta.url)), 'org-github-routes.mjs'), 'utf8');
// INSTALL now interpolates GH_DIR, so the extraction carries it too.
const INSTALL_SCRIPT = new Function(
  `${ROUTES_SRC.match(/const GH_DIR = '[^']+';/)[0]}\n`
  + `${ROUTES_SRC.match(/const INSTALL = \[[\s\S]*?\]\.join\('; '\);/)[0]}; return INSTALL;`,
)();

test('THE MECHANISM: the install clears GH_TOKEN before gh ever runs', () => {
  const unset = INSTALL_SCRIPT.indexOf('unset GH_TOKEN GITHUB_TOKEN');
  const login = INSTALL_SCRIPT.indexOf('gh auth login --with-token');
  assert.ok(unset > -1, 'gh refuses to store a token while one is in the environment');
  assert.ok(unset < login, 'and it must be cleared BEFORE the login, not after');
});

test('driven: with GH_TOKEN set, the login still gets a clean environment', () => {
  // A fake gh that fails loudly if the environment still carries a token, which
  // is exactly what the real gh does.
  const dir = tmpDir('inst-');
  _write(_join(dir, 'gh'), [
    '#!/usr/bin/env bash',
    'if [ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then',
    '  echo "The value of the GH_TOKEN environment variable is being used for authentication." >&2; exit 1',
    'fi',
    '[ "$1" = "auth" ] && [ "$2" = "login" ] && { cat >/dev/null; exit 0; }',
    '[ "$1" = "api" ] && { echo "acme-collective"; exit 0; }',
    'exit 0',
  ].join('\n'));
  _chmod(_join(dir, 'gh'), 0o755);
  const script = _join(dir, 'run.sh');
  _write(script, INSTALL_SCRIPT.replaceAll('/state/.kernel/gh', _join(dir, 'ghcfg')));
  const out = _x('bash', [script], {
    encoding: 'utf8', input: 'gho_fake\n',
    env: { PATH: `${dir}:/usr/bin:/bin`, GH_TOKEN: 'already_set', GITHUB_TOKEN: 'also_set' },
  });
  assert.match(out, /LOGIN=acme-collective/, 'the sign-in must survive an environment that carries a token');
});

test('a chmod it cannot do never kills the install', () => {
  // The first version chained with `set -e`, so `chmod 700` on a directory owned
  // by another uid ended the whole thing before gh ran.
  assert.match(INSTALL_SCRIPT, /chmod 700 "\$GH_CONFIG_DIR" 2>\/dev\/null \|\| true/);
  assert.doesNotMatch(INSTALL_SCRIPT, /^set -e/, 'each step reports for itself instead');
});

test('each failure names its own step', () => {
  for (const step of ['gh-missing', 'login', 'whoami']) {
    assert.ok(INSTALL_SCRIPT.includes(`STEP=${step}`), `${step} must be distinguishable`);
  }
});

test('the failure reason carries the detail, redacted, not withheld', async () => {
  const calls = [];
  const state = {};
  const route = createOrgGitHubRoutes({
    host: () => HOST,
    state,
    opts: {
      deviceFlow: async () => ({ userCode: 'X', verificationUri: 'u', poll: async () => ({ ok: true, token: 'gho_realsecrettokenvalue1234567890' }) }),
      bridge: async (h, c, o) => {
        calls.push(c);
        return { code: 11, stdout: 'STEP=login\nerror validating token gho_realsecrettokenvalue1234567890: HTTP 401: Bad credentials\n', stderr: '' };
      },
    },
  });
  const [req, res] = reqres('POST', '/org-github/start');
  route(req, res, '/org-github/start');
  for (let i = 0; i < 40 && state.stage !== 'failed'; i++) await new Promise((r) => setImmediate(r));
  assert.equal(state.stage, 'failed');
  assert.match(state.reason, /could not store the account/i, 'the step, in words');
  assert.match(state.reason, /401|Bad credentials/, 'AND what it actually said, or this is unreadable again');
  assert.doesNotMatch(state.reason, /gho_realsecrettokenvalue/, 'with the credential redacted, not the sentence');
});

test('an unreadable step still says something a person can act on', async () => {
  const state = {};
  const route = createOrgGitHubRoutes({
    host: () => HOST,
    state,
    opts: {
      deviceFlow: async () => ({ userCode: 'X', verificationUri: 'u', poll: async () => ({ ok: true, token: 't' }) }),
      bridge: async () => ({ code: 10, stdout: 'STEP=gh-missing\n', stderr: '' }),
    },
  });
  const [req, res] = reqres('POST', '/org-github/start');
  route(req, res, '/org-github/start');
  for (let i = 0; i < 40 && state.stage !== 'failed'; i++) await new Promise((r) => setImmediate(r));
  assert.match(state.reason, /Restart the rock/i);
});

// ------------------------------------------------------------ the scope list
//
// Sam's second real run, with the diagnostics in place, said exactly what was
// wrong: "error validating token: missing required scope 'read:org'". A scope
// list is the kind of thing that cannot fail in a unit test and only fails on a
// live approval, so it gets pinned here with the reason attached.
import { GH_SCOPES } from './org-github-routes.mjs';

test('the sign-in asks for read:org, which gh REQUIRES before it will store a token', async () => {
  assert.match(GH_SCOPES, /\bread:org\b/,
    "gh auth login --with-token refuses without it: \"missing required scope 'read:org'\"");
  assert.match(GH_SCOPES, /\brepo\b/, 'and repo is what creates the private repository');

  // asked for, not merely declared
  let asked = '';
  const state = {};
  const route = createOrgGitHubRoutes({
    host: () => HOST,
    state,
    opts: {
      deviceFlow: async ({ scope }) => { asked = scope; return { userCode: 'X', verificationUri: 'u', poll: async () => ({ ok: true, token: 't' }) }; },
      bridge: async () => ({ code: 0, stdout: 'LOGIN=acme-collective', stderr: '' }),
    },
  });
  const [req, res] = reqres('POST', '/org-github/start');
  route(req, res, '/org-github/start');
  for (let i = 0; i < 40 && state.stage !== 'done'; i++) await new Promise((r) => setImmediate(r));
  assert.equal(asked, GH_SCOPES);
});

test('and asks for nothing wider than it uses', () => {
  // repo creates the repository and registers its deploy key; read:org lets the
  // preflight ask `gh api user/orgs` whether this account can act for an org
  // owner. Anything else would be permission we never exercise.
  assert.deepEqual(GH_SCOPES.split(' ').sort(), ['read:org', 'repo']);
});

test('the terminal route asks for the same scopes as the app', () => {
  // Two implementations of one flow drift silently, and the symptom is a live
  // sign-in that works from one surface and fails from the other.
  const box = _read(_join(_dirname(_furl(import.meta.url)), '..', '..', 'engine', 'gh-device-login.mjs'), 'utf8');
  const m = box.match(/const SCOPES = '([^']+)'/);
  assert.ok(m, 'engine/gh-device-login.mjs must declare its scopes in one place');
  assert.equal(m[1], GH_SCOPES);
});

// ---------------------------------- the backup leg names the brain explicitly
//
// trap 24: the box-side script picked its directory with `[ -z "$STATE_DIR" ]`,
// and STATE_DIR is exported on every box, so the rock branch never fired and it
// backed up /state. Fixed in the image, but a rock cannot pull a new image
// without a promote and a restart, and the app updates today. So the app names
// the brain, which takes the OLD script's else-branch to the right place.

test('the backup leg hands connect-github the resolved brain root', async () => {
  const seen = [];
  const state = {};
  const route = createOrgGitHubRoutes({
    host: () => HOST,
    state,
    opts: {
      deviceFlow: async () => ({ userCode: 'X', verificationUri: 'u', poll: async () => ({ ok: true, token: 't' }) }),
      bridge: async (h, c) => {
        seen.push(c);
        if (/connect-github/.test(c)) return { code: 0, stdout: "✓ Done. Your brain is backed up to your private GitHub repo 'acme-brain'.", stderr: '' };
        return { code: 0, stdout: 'LOGIN=acme-collective', stderr: '' };
      },
    },
  });
  const [req, res] = reqres('POST', '/org-github/start');
  route(req, res, '/org-github/start');
  for (let i = 0; i < 40 && state.stage !== 'done'; i++) await new Promise((r) => setImmediate(r));

  const backup = seen.find((c) => /connect-github/.test(c));
  assert.match(backup, /STATE_DIR="\$BR" .*connect-github/, 'the brain is named, never left to the box to guess');
  assert.match(backup, /brain_root/, 'and resolved the way boot-rock and the panel resolve it');
  assert.ok(backup.indexOf('BR=') < backup.indexOf('connect-github'), 'resolved before it is used');
});

test('the resolution shell it emits actually runs', async () => {
  // A shell string that looks right and does not parse is the failure mode this
  // whole sequence keeps producing. The fragment is the SHARED resolver now
  // (engine/lib/brain-root.mjs — its own suite pins the four box shapes on
  // fixtures); here we pin that THIS module emits that fragment and that it
  // runs, agreeing with the JS form on whatever shape this machine has.
  const { BRAIN_ROOT_SH, resolveBrainRoot } = await import('../../engine/lib/brain-root.mjs');
  const src = _read(_join(_dirname(_furl(import.meta.url)), 'org-github-routes.mjs'), 'utf8');
  assert.match(src, /const BRAIN_ROOT_RESOLVE = BRAIN_ROOT_SH;/, 'the routes emit the shared fragment, not a hand copy');
  const dir = tmpDir('br-');
  const f = _join(dir, 'br.sh');
  _write(f, `${BRAIN_ROOT_SH}\necho "BR=$BR"\n`);
  const out = _x('bash', [f], { encoding: 'utf8', env: { PATH: process.env.PATH } }).trim();
  assert.equal(out, `BR=${resolveBrainRoot('/state', { env: {} })}`, 'shell and JS resolution must agree');
});

// ------------------------------------------- long is not hung
//
// "ssh to test-org-4-rock exceeded 25000ms; killed (box busy?)". The bridge
// kills any command over 25 seconds, which is right for a hang (it holds a
// concurrency slot and a box-side connection, and hangs compound) and wrong for
// a first push of an entire brain. invite-member and the member seat's own push
// both already carried their own timeout; this route was written from that
// flow's shape without its settings.

test('the backup leg is given minutes, because a first push takes minutes', async () => {
  const opts = [];
  const state = {};
  const route = createOrgGitHubRoutes({
    host: () => HOST,
    state,
    opts: {
      deviceFlow: async () => ({ userCode: 'X', verificationUri: 'u', poll: async () => ({ ok: true, token: 't' }) }),
      bridge: async (h, c, o = {}) => {
        opts.push({ c, ms: o.hardTimeoutMs });
        return /connect-github/.test(c)
          ? { code: 0, stdout: "✓ Done. Your brain is backed up to your private GitHub repo 'acme-brain'.", stderr: '' }
          : { code: 0, stdout: 'LOGIN=acme-collective', stderr: '' };
      },
    },
  });
  const [req, res] = reqres('POST', '/org-github/start');
  route(req, res, '/org-github/start');
  for (let i = 0; i < 40 && state.stage !== 'done'; i++) await new Promise((r) => setImmediate(r));

  const backup = opts.find((o) => /connect-github/.test(o.c));
  const install = opts.find((o) => !/connect-github/.test(o.c));
  assert.ok(backup.ms >= 10 * 60 * 1000, `the backup leg must survive a real push, got ${backup.ms}ms`);
  assert.ok(install.ms > 25000, `the install leg must beat the 25s default too, got ${install.ms}ms`);
});

test('both legs override the default, so neither is left on 25 seconds', async () => {
  const src = _read(_join(_dirname(_furl(import.meta.url)), 'org-github-routes.mjs'), 'utf8')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');   // comments quote it too
  const calls = src.match(/await bridge\(/g) || [];
  const timed = src.match(/hardTimeoutMs:/g) || [];
  assert.equal(calls.length, timed.length,
    'every bridge call in this module names its own timeout, or the 25s default kills a long one');
});

// ------------------------------- the credential must survive the brain override
//
// Read off Sam's box, 2026-08-10. Naming only STATE_DIR fixed the directory and
// broke the credential: the on-box script derives GH_CONFIG_DIR from whichever
// brain it picked, so with STATE_DIR handed in it looked at <brain>/.kernel/gh,
// found nothing, and started a FRESH interactive device login that sat waiting
// for input until the 15-minute watchdog. That was the "Connecting…" that never
// finished, and the box confirmed it: /state/brain/.kernel/gh absent,
// /state/.kernel/gh/hosts.yml holding the real token.

test('the backup leg names the gh config dir as well as the brain', async () => {
  const seen = [];
  const state = {};
  const route = createOrgGitHubRoutes({
    host: () => HOST,
    state,
    opts: {
      deviceFlow: async () => ({ userCode: 'X', verificationUri: 'u', poll: async () => ({ ok: true, token: 't' }) }),
      bridge: async (h, c) => {
        seen.push(c);
        return /connect-github/.test(c)
          ? { code: 0, stdout: "✓ Done. Your brain is backed up to your private GitHub repo 'ai-os-brain'.", stderr: '' }
          : { code: 0, stdout: 'LOGIN=cradsdavis-cell', stderr: '' };
      },
    },
  });
  const [req, res] = reqres('POST', '/org-github/start');
  route(req, res, '/org-github/start');
  for (let i = 0; i < 40 && state.stage !== 'done'; i++) await new Promise((r) => setImmediate(r));

  const backup = seen.find((c) => /connect-github/.test(c));
  const install = seen.find((c) => !/connect-github/.test(c));
  assert.match(backup, /GH_CONFIG_DIR=\/state\/\.kernel\/gh/, 'or it hunts for a token that is not there');
  assert.match(backup, /STATE_DIR="\$BR"/, 'and still names the brain');
  // the two legs must agree on the path, which is why it is one constant
  const dirOf = (c) => (c.match(/GH_CONFIG_DIR=([^\s;]+)/) || [, ''])[1];
  assert.equal(dirOf(backup), dirOf(install), 'the leg that writes the token and the leg that reads it must agree');
});

test('stdin is closed, so an interactive prompt fails in seconds instead of hanging', async () => {
  const src = _read(_join(_dirname(_furl(import.meta.url)), 'org-github-routes.mjs'), 'utf8');
  assert.match(src, /connect-github <\/dev\/null/,
    'a prompt on the far end of an ssh with an open stdin waits for the full watchdog');
});

// FINDING 199 (2026-08-17): the flow ran against the FIRST rock the app
// manages, whatever the picker showed. These routes took no body at all, so the
// page had no way to say which mineral it was on, and panel-server's host()
// was `t[0].host` unconditionally. With one rock that is the selected rock by
// definition; the day the picker held two, Connect GitHub pressed while viewing
// institute-of-shenanigans installed the token on qa-r2-gmail, the green line
// truthfully named qa-r2's repo, and the card's status read (which follows the
// picker) kept saying "No offsite copy yet". Sam: "it appears to connect but
// doesn't register that it has connected".
test('199: start hands the body’s host to the target gate', async () => {
  const h = harness();
  const [req, res] = reqres('POST', '/org-github/start', { host: 'second-rock' });
  assert.equal(h.route(req, res, '/org-github/start'), true);
  for (let i = 0; i < 40 && !['done', 'failed'].includes(h.state.stage); i++) await new Promise((r) => setImmediate(r));
  const asked = h.calls.find((c) => c.kind === 'host');
  assert.ok(asked, 'the target gate was consulted');
  assert.equal(asked.want, 'second-rock', 'with the mineral the page is showing, not a default');
  assert.equal(h.state.target, HOST, 'and the flow records which rock it ran against');
});

test('199: backup hands the body’s host to the target gate too', async () => {
  const h = harness();
  const [req, res] = reqres('POST', '/org-github/backup', { host: 'second-rock' });
  assert.equal(h.route(req, res, '/org-github/backup'), true);
  for (let i = 0; i < 40 && !['done', 'failed'].includes(h.state.stage); i++) await new Promise((r) => setImmediate(r));
  const asked = h.calls.find((c) => c.kind === 'host');
  assert.equal(asked && asked.want, 'second-rock');
});

test('199: a refused host answers an error, and no flow starts', async () => {
  const calls = [];
  const route = createOrgGitHubRoutes({
    host: (want) => (want === 'managed-rock' ? want : null),   // panel-server’s shape: named-but-unmanaged is REFUSED
    state: {},
    opts: { deviceFlow: async () => { calls.push('deviceFlow'); throw new Error('must not be reached'); },
      bridge: async () => { calls.push('bridge'); return { code: 0, stdout: '', stderr: '' }; } },
  });
  const [req, res] = reqres('POST', '/org-github/start', { host: 'stranger-rock' });
  assert.equal(route(req, res, '/org-github/start'), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.match(parse(res).error, /not connected to that rock/,
    'a host this app does not manage is refused, never silently swapped for the first one');
  assert.deepEqual(calls, [], 'and neither GitHub nor any box is touched');
});

test('199 page half is RETIRED (2026-09-01): panel-server no longer mounts /org-github/*', () => {
  // The page's connect and backup cards died with the org face, and the panel
  // server no longer mounts createOrgGitHubRoutes at all, which is the
  // stronger form of the finding-199 fix: with no mounted route there is no
  // host to swap. The module keeps its own contract (host named, refused when
  // unmanaged) pinned by the tests above, for the day a commons-era caller
  // mounts it again.
  const html = _read(_join(_dirname(_furl(import.meta.url)), 'member.html'), 'utf8');
  assert.ok(!html.includes("'/org-github/"), 'no page fetch aims at the dead mount');
  const server = _read(_join(_dirname(_furl(import.meta.url)), 'panel-server.mjs'), 'utf8');
  assert.ok(!server.includes('createOrgGitHubRoutes'), 'the mount stays out of panel-server');
});

// ==========================================================================
// DRIVEN: the backup shell, run for real against real git repositories.
//
// This is the leg that has burned twice, and both times the harness could not
// see it: the tests above check the STRING the app sends, and every failure so
// far has been in what that string DOES on the box. `_hot`'s standing note on
// the stamp path says the same thing in general ("shell/yaml on a prod path no
// harness covers"). So these run it: a real brain repo, a real second history
// standing in for another box's repo, and stubbed `gh` + `connect-github` on
// PATH. The assertions are about the git state left behind, not about wording.
//
// The scenario named `A` below IS Sam's 2026-08-12 screenshot, reproduced.

const FOREIGN = 'b7a5c1d0e2f34567890123456789012345678901';   // a sha this brain has never held

/** Build a box: a brain repo, a fake GitHub ("hub"), and stubs on PATH. */
function box({ wired = '', hubTips = {}, connectFails = false } = {}) {
  const dir = tmpDir('backup-');
  const brain = _join(dir, 'brain'); const hub = _join(dir, 'hub'); const bin = _join(dir, 'bin');
  const key = (slug) => slug.replace(/\//g, '_');
  const setup = [
    `set -e`,
    `mkdir -p "${brain}" "${hub}" "${bin}"`,
    `cd "${brain}"`,
    `git init -q -b main`,
    `printf 'org:\\n  name: "acme"\\n  display_name: "Acme Collective"\\n' > org-policy.yaml`,
    `git -c user.email=t@t -c user.name=t add -A`,
    `git -c user.email=t@t -c user.name=t commit -qm brain`,
    wired ? `git remote add origin "https://github.com/${wired}.git"` : ':',
    ...Object.entries(hubTips).map(([slug, sha]) => `printf '%s' "${sha}" > "${hub}/${key(slug)}"`),
  ].join('\n');
  _x('bash', ['-c', setup], { encoding: 'utf8' });

  // A fake GitHub: one file per repo, holding its tip sha (an empty file is a
  // repo that exists with no commits). Answers the three questions the backup
  // shell asks, and nothing else.
  _write(_join(bin, 'gh'), `#!/usr/bin/env bash
slugfile(){ printf %s "${hub}/$(printf %s "\$1" | tr / _)"; }
if [ "\$1" = api ]; then
  case "\$2" in
    user) echo acme-collective; exit 0;;
    repos/*/commits*) s="\${2#repos/}"; s="\${s%%/commits*}"; f="\$(slugfile "\$s")"; [ -f "\$f" ] || exit 1; cat "\$f"; exit 0;;
  esac
  exit 1
fi
if [ "\$1" = repo ] && [ "\$2" = view ]; then [ -f "\$(slugfile "\$3")" ]; exit \$?; fi
exit 1
`);
  // The real one: wires origin FIRST, then pushes. That order is the whole of
  // fault 3, so the stub keeps it.
  _write(_join(bin, 'connect-github'), `#!/usr/bin/env bash
REPO="\${1:-ai-os-brain}"
# Faithful to the real script: an existing origin is pushed to, not replaced.
# Only an unwired brain gets a remote added, and it gets one BEFORE the push.
if EXIST="\$(git remote get-url origin 2>/dev/null)"; then
  REPO="\$(printf %s "\$EXIST" | sed -e 's#^https://[^/]*/##' -e 's#\\.git$##' -e 's#^[^/]*/##')"
else
  git remote add origin "https://github.com/acme-collective/\$REPO.git"
fi
${connectFails ? `echo "To https://github.com/acme-collective/\$REPO.git"
echo " ! [rejected]        HEAD -> main (non-fast-forward)"
echo "error: failed to push some refs to 'https://github.com/acme-collective/\$REPO.git'"
echo "hint: See the 'Note about fast-forwards' in 'git push --help' for details."
exit 1` : `git rev-parse HEAD > "${hub}/\$(printf %s "acme-collective/\$REPO" | tr / _)"
echo "✓ Done. Your brain is backed up to your private GitHub repo '\$REPO'."`}
`);
  _chmod(_join(bin, 'gh'), 0o755); _chmod(_join(bin, 'connect-github'), 0o755);
  return { dir, brain, hub, bin };
}

/** The exact command the route sends, run on that box. */
async function drive(b) {
  let sent = '';
  const state = {};
  const route = createOrgGitHubRoutes({
    host: () => HOST, state, opts: { bridge: async (h, c) => { sent = c; return { code: 0, stdout: '' }; } },
  });
  const [req, res] = reqres('POST', '/org-github/backup');
  route(req, res, '/org-github/backup');
  for (let i = 0; i < 40 && state.stage !== 'done'; i++) await new Promise((r) => setImmediate(r));
  const out = _x('bash', ['-c', sent], {
    encoding: 'utf8',
    env: { PATH: `${b.bin}:${process.env.PATH}`, HOME: b.dir, BRAIN_ROOT: b.brain, GIT_CONFIG_NOSYSTEM: '1' },
  });
  const origin = _x('bash', ['-c', `cd "${b.brain}" && git remote get-url origin 2>/dev/null || true`], { encoding: 'utf8' }).trim();
  return { out, origin };
}

test('A — Sam’s screenshot: a remote holding another box’s brain is dropped, not pushed to', async () => {
  // 2026-08-12. cradsdavis-cell/ai-os-brain survived the 10 Aug blank slate as a
  // repo (the box PAT cannot delete repos) and still held janet-jackson and
  // bob-jones. The fresh rock adopted it by name and was rejected non-fast-forward.
  const b = box({ wired: 'acme-collective/ai-os-brain', hubTips: { 'acme-collective/ai-os-brain': FOREIGN } });
  const { out, origin } = await drive(b);
  assert.match(out, /BACKUP_REPOINTED=1/, 'it recognised the far end as another box’s history');
  assert.match(out, /BACKUP_REPO=acme-collective\/acme-brain$/m, 'and gave this rock its own, named for the org');
  assert.equal(origin, 'https://github.com/acme-collective/acme-brain.git');
});

test('B — a taken name is stepped over, never adopted on faith', async () => {
  const b = box({ hubTips: { 'acme-collective/acme-brain': FOREIGN } });
  const { out, origin } = await drive(b);
  assert.match(out, /BACKUP_REPO=acme-collective\/acme-brain-2$/m);
  assert.equal(origin, 'https://github.com/acme-collective/acme-brain-2.git');
});

test('C — a push that does not land leaves NO remote behind', async () => {
  // The third fault: connect-github wires origin before it pushes, so a rejected
  // push left the card reading "connected" with one button that could only fail.
  const b = box({ connectFails: true });
  const { out, origin } = await drive(b);
  assert.match(out, /BACKUP_UNDONE=1/);
  assert.match(out, /BACKUP_FAIL=push/);
  assert.equal(origin, '', 'the card must fall back to "no offsite copy", which offers Connect GitHub again');
});

test('D — a healthy brain re-runs as a plain push, with no repoint and no new repo', async () => {
  const b = box({ wired: 'acme-collective/acme-brain' });
  const head = _x('bash', ['-c', `cd "${b.brain}" && git rev-parse HEAD`], { encoding: 'utf8' }).trim();
  _write(_join(b.hub, 'acme-collective_acme-brain'), head);
  const { out, origin } = await drive(b);
  assert.doesNotMatch(out, /BACKUP_REPOINTED/, 'its own history is not another box’s');
  assert.match(out, /BACKUP_REPO=acme-collective\/acme-brain$/m);
  assert.equal(origin, 'https://github.com/acme-collective/acme-brain.git');
});

test('E — a brain with nothing committed says so, instead of failing at the push', async () => {
  const dir = tmpDir('backup-empty-');
  _x('bash', ['-c', `mkdir -p "${dir}/brain" "${dir}/bin" && cd "${dir}/brain" && git init -q -b main`], { encoding: 'utf8' });
  _write(_join(dir, 'bin', 'gh'), '#!/usr/bin/env bash\nexit 1\n'); _chmod(_join(dir, 'bin', 'gh'), 0o755);
  const { out } = await drive({ dir, brain: _join(dir, 'brain'), hub: dir, bin: _join(dir, 'bin') });
  assert.match(out, /BACKUP_FAIL=empty-brain/);
});
