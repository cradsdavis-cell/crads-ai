// factory-arming.test.mjs — a door-born rock can arm its own factory. Run:
//   node --test wizard/panel/factory-arming.test.mjs
//
// THE BUG (2026-08-10, test-org-4). New Pebble died at "ORG_GH_OWNER +
// ORG_GH_TOKEN required (repo .env)". A rock born through the door stages no
// GitHub credential on purpose (2026-08-09 ownership ruling), so the only one it
// has is the account its owner authorised with connect-github, and nothing on
// the stamp path knew that account existed.
//
// WHY THE FIX LIVES HERE AND NOT ONLY IN THE BRAIN. brain-template now resolves
// this properly, but a rock cannot pull its own brain after the day it is born,
// so a brain-side fix reaches only rocks stamped from here on. Every rock
// already standing is reached by the APP, which updates. This preamble exports
// the pair, so an old brain's own chain finds it at rung one.
//
// These tests DRIVE the shell rather than reading it: the preamble is a string
// in a JS file, and a string that looks right and does not run is exactly the
// failure being fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERBS, MEMBER_VERBS } from './panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

// ------------------------------------------------------------------ structure

// THE FACE COLLAPSE (2026-09-01). The stamp path itself is retired: nobody
// creates a pebble for anyone else, so invite-member (the last
// create-infrastructure verb) and join-approve are deleted. The resolver and
// the status read they carried live on as exported builders "until the
// machinery is deleted" (panel-server's own words), so their unit truths below
// still run; everything that SERVED or RENDERED them is pinned gone below.
test('the stamp path is RETIRED: the create-infrastructure verbs stay deleted', () => {
  assert.equal(VERBS['invite-member'], undefined, 'invite-member must stay out of VERBS');
  assert.equal(VERBS['join-approve'], undefined, 'join-approve must stay out of VERBS');
  assert.equal(VERBS['stamp-member'], undefined, 'stamp-member died 2026-08-10 and stays dead');
});

test('factory-status is a READ: admin-gated, never mutating, never prints a token', () => {
  const v = VERBS['factory-status'];
  assert.equal(v.adminOnly, true);
  assert.notEqual(v.mutating, true, 'a status read must not be classified as mutating');
  const cmd = v.build({}).command;
  // The token may be EXPORTED (that is the point); it must never be printed.
  assert.doesNotMatch(cmd, /(echo|printf)[^;]*ORG_GH_TOKEN/, 'the credential must never reach stdout');
  assert.doesNotMatch(cmd, /JSON\.stringify\([^)]*ORG_GH_TOKEN/, 'nor ride out in the status payload');
});

test('factory-status never joined the served member table: no mineral has a factory to ask about', () => {
  // Since the one-face collapse the served table is MEMBER_VERBS plus the
  // Catalogue dozen; factory-status must stay out of the member table so it
  // can never ride into the served set by accident.
  assert.equal(MEMBER_VERBS['factory-status'], undefined);
});

test('factory-status prefers the brain\'s own preflight, so status cannot contradict the refusal', () => {
  const cmd = VERBS['factory-status'].build({}).command;
  assert.match(cmd, /stamp-preflight\.mjs"? --json/);
  assert.ok(cmd.indexOf('stamp-preflight.mjs') < cmd.lastIndexOf('else node -e'), 'the brain answers first; inline is the fallback');
});

// --------------------------------------------------------------- behaviour

/** A fake `gh`, so the connected rung is exercised rather than described. */
function fakeBin({ token = 'gh-token-xyz', login = 'personal-login' } = {}) {
  const dir = tmpDir('fa-bin-');
  const gh = join(dir, 'gh');
  writeFileSync(gh, [
    '#!/usr/bin/env bash',
    token ? '[ "$1" = "auth" ] && [ "$2" = "token" ] && { echo "' + token + '"; exit 0; }' : '[ "$1" = "auth" ] && exit 1',
    '[ "$1" = "api" ] && [ "$2" = "user" ] && { echo "' + login + '"; exit 0; }',
    'exit 1',
  ].join('\n'));
  chmodSync(gh, 0o755);
  return dir;
}

function brainWithRemote(url) {
  const dir = tmpDir('fa-brain-');
  execFileSync('git', ['init', '-q', dir]);
  if (url) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url]);
  return dir;
}

/** The preamble alone, with the verb body stripped off, plus an echo of the result. */
function preambleScript() {
  const cmd = VERBS['factory-status'].build({}).command;
  const preamble = cmd.replace(/if \[ -f "\$BR\/factory[\s\S]*$/, '');
  const f = join(tmpDir('fa-sh-'), 'probe.sh');
  writeFileSync(f, preamble + '\necho "OWNER=$ORG_GH_OWNER TOKEN=$ORG_GH_TOKEN"\n');
  return f;
}

const runPreamble = (env) => {
  const bin = [dirname(process.execPath), dirname(execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()), '/usr/bin', '/bin'];
  return execFileSync('bash', [preambleScript()], {
    encoding: 'utf8',
    env: { PATH: [...(env.EXTRA_BIN ? [env.EXTRA_BIN] : []), ...bin].join(':'), HOME: tmpdir(), ...env },
  }).trim().split('\n').pop();
};

test('DOOR-BORN ROCK: nothing staged, and the connected account arms it', () => {
  const out = runPreamble({ EXTRA_BIN: fakeBin(), BRAIN_ROOT: brainWithRemote('git@github.com:their-org/ai-os-brain.git') });
  assert.equal(out, 'OWNER=their-org TOKEN=gh-token-xyz',
    'this is the whole fix: the account connect-github holds becomes the factory credential');
});

test('the owner comes from the remote the OWNER chose, not their personal login', () => {
  const out = runPreamble({ EXTRA_BIN: fakeBin({ login: 'personal-login' }), BRAIN_ROOT: brainWithRemote('https://github.com/their-org/b.git') });
  assert.match(out, /OWNER=their-org/, 'an org remote must beat the signed-in personal account');
});

test('with no remote yet, the signed-in login is used', () => {
  const out = runPreamble({ EXTRA_BIN: fakeBin(), BRAIN_ROOT: brainWithRemote(null) });
  assert.match(out, /OWNER=personal-login/);
});

test('THE HALF-PAIR: a staged token with a blank owner never borrows the org\'s owner', () => {
  // provision-rock with platform tokens + a template seed produced exactly
  // this. Mixing the rungs would push the PLATFORM's token at the ORG's repos.
  const out = runPreamble({
    EXTRA_BIN: fakeBin(), BRAIN_ROOT: brainWithRemote('git@github.com:their-org/b.git'),
    GH_OWNER: '', GITHUB_TOKEN: 'platform-token',
  });
  assert.equal(out, 'OWNER=their-org TOKEN=gh-token-xyz', 'both fields must come from the same identity');
});

test('a fully staged operator rock keeps its own credentials and never consults gh', () => {
  const out = runPreamble({
    EXTRA_BIN: fakeBin(), BRAIN_ROOT: brainWithRemote('git@github.com:their-org/b.git'),
    GH_OWNER: 'platform-org', GITHUB_TOKEN: 'platform-token',
  });
  assert.equal(out, 'OWNER=platform-org TOKEN=platform-token');
});

test('explicit ORG_GH_* still wins over everything', () => {
  const out = runPreamble({
    EXTRA_BIN: fakeBin(), BRAIN_ROOT: brainWithRemote('git@github.com:their-org/b.git'),
    ORG_GH_OWNER: 'explicit', ORG_GH_TOKEN: 'explicit-token', GH_OWNER: 'platform-org', GITHUB_TOKEN: 'platform-token',
  });
  assert.equal(out, 'OWNER=explicit TOKEN=explicit-token');
});

test('an unconnected rock resolves nothing rather than half an identity', () => {
  const out = runPreamble({ EXTRA_BIN: fakeBin({ token: '' }), BRAIN_ROOT: brainWithRemote('git@github.com:their-org/b.git') });
  assert.equal(out, 'OWNER= TOKEN=');
});

test('no gh on the box at all is survivable, not a crash', () => {
  const empty = tmpDir('fa-nogh-');
  const out = runPreamble({ EXTRA_BIN: empty, BRAIN_ROOT: brainWithRemote(null) });
  assert.equal(out, 'OWNER= TOKEN=');
});

// ------------------------------------------------- the old-brain status fallback

test('the inline status fallback runs, and names every gap with a fix', () => {
  const cmd = VERBS['factory-status'].build({}).command;
  // take the else-branch program and run it directly
  const prog = cmd.match(/else node -e '([\s\S]*)'; fi$/)[1];
  const out = execFileSync(process.execPath, ['-e', prog], {
    encoding: 'utf8', env: { PATH: process.env.PATH },
  });
  const r = JSON.parse(out);
  assert.equal(r.armed, false);
  assert.deepEqual(r.checks.map((c) => c.id).sort(), ['address', 'github', 'image', 'provisioning', 'server'],
    'one read must name all five, or the admin discovers them one failed stamp at a time');
  for (const c of r.checks) assert.ok(c.fix.length > 10, `check "${c.id}" says what is wrong and not what to do`);
  assert.match(r.checks.find((c) => c.id === 'github').fix, /connect-github/);
});

test('the fallback reports armed when the environment carries everything', () => {
  const prog = VERBS['factory-status'].build({}).command.match(/else node -e '([\s\S]*)'; fi$/)[1];
  const app = tmpDir('fa-app-');
  mkdirSync(join(app, 'provisioning', 'managed'), { recursive: true });
  writeFileSync(join(app, 'provisioning', 'managed', 'provision-pebble.sh'), '#!/bin/sh\n');
  // the provisioning check is pinned to /app on a real box, so on a laptop that
  // one leg is expected to fail; assert the other four flip.
  const r = JSON.parse(execFileSync(process.execPath, ['-e', prog], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, ORG_GH_OWNER: 'acme', ORG_GH_TOKEN: 'tok', GHOK: '1',
      HCLOUD_TOKEN: 'hc', CF_API_TOKEN: 'cf', CF_TUNNEL_ROOT_DOMAIN: 'example.com', PEBBLE_IMAGE: 'img:v2',
    },
  }));
  assert.deepEqual(r.checks.filter((c) => !c.ok).map((c) => c.id), ['provisioning']);
});

test('the status copy is prose for an owner, with no shell and no em dashes', () => {
  const prog = VERBS['factory-status'].build({}).command.match(/else node -e '([\s\S]*)'; fi$/)[1];
  const r = JSON.parse(execFileSync(process.execPath, ['-e', prog], { encoding: 'utf8', env: { PATH: process.env.PATH } }));
  for (const c of r.checks) {
    assert.doesNotMatch(c.detail + c.fix, /—/, `check "${c.id}" carries an em dash`);
    assert.doesNotMatch(c.detail + c.fix, /\$\{|exit 1/, `check "${c.id}" reads like a script`);
  }
});

// --------------------------------------- the refusal an OLD rock actually saw
//
// RETIRED (2026-09-01). The in-app refusal ("no GitHub account connected",
// with connect-github as the fix) guarded the stamp path, and the stamp path
// is gone: invite-member and join-approve are deleted above, so there is no
// gate left to drive. The one-shell-line rule and the gate fixtures went with
// them. What remains testable is the SOFT posture of the verbs that survive.

test('the SOFT verbs stay soft: teardown must work on a rock with no GitHub', () => {
  // It pushes from the brain clone and already warns-and-continues. A hard
  // refusal here would strand a rock that can no longer tidy up after itself.
  // (member-revoke died 2026-08-10, rulings 6+8: the End flow runs member-leave.)
  const cmd = VERBS['deprovision-member'].build({ slug: 'jane01', confirm: 'jane01' }).command;
  assert.doesNotMatch(cmd, /no GitHub account connected/, 'deprovision-member must not hard-refuse');
});

// ('the refusal travels as ONE shell line' rode invite-member and retired with
// it: with no stamp verb there is no built command to keep newline-free.)

// ------------------------------------- the headline an owner actually read
//
// RETIRED (2026-09-01). friendlyStampError, stArm, the New Pebble form, the
// factory notice (loadFactoryStatus), the busy-state flow (orgGhStart /
// orgGhBusy / orgGhSay) and renderRockBackup all lived on the org face, and
// the org face is gone from member.html. The pin below holds that none of
// them comes back: a one-face app has no stamp form to gate and no factory
// notice to word.
test('the factory UI is RETIRED: none of its functions or state survive in member.html', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');
  for (const name of ['friendlyStampError', 'stArm', 'renderRockBackup', 'loadFactoryStatus',
    'orgGhStart', 'orgGhBusy', 'orgGhSay', 'loadFleetHealth', 'stampBtn', 'stampBlocked']) {
    assert.ok(!html.includes(name), `${name} must stay out of the page`);
  }
  // comments may still recall the old copy; rendered strings must not
  const code = html.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!code.includes('Connect GitHub first'), 'the stamp-gate button copy is gone');
  assert.ok(!code.includes('New Pebble'), 'and so is the form it guarded');
});

// ---------------------------------------- "Push it now" is a verb, not a hop
//
// Sam pressed it and got a terminal running the SIGN-IN script to do a push,
// which then targeted the wrong directory: "/state is not a git repository".
// The push lane already exists in the image, resolves the brain correctly on
// its own, refuses while credential-shaped material is unguarded, and writes
// the log the Custody card reads for "last push".
test('the push runs engine/brain-push.sh as a verb, never a terminal autorun', () => {
  const v = VERBS['org-brain-push'];
  assert.ok(v, 'the verb exists');
  assert.equal(v.adminOnly, true);
  assert.equal(v.mutating, true);
  const cmd = v.build({}).command;
  assert.match(cmd, /engine\/brain-push\.sh/, 'the box\'s own push lane, not connect-github');
  assert.doesNotMatch(cmd, /connect-github/, 'a sign-in script is not a push');
  assert.match(cmd, /GH_CONFIG_DIR=\/state\/\.kernel\/gh/, 'the credential helper shells out to gh (trap 26)');
  assert.match(cmd, /brain-push\.log/, 'and it surfaces the log the card reads');
});

test('an image too old to have the push lane says so instead of failing oddly', () => {
  const cmd = VERBS['org-brain-push'].build({}).command;
  assert.match(cmd, /\[ -f \/app\/engine\/brain-push\.sh \]/);
  assert.match(cmd, /Restart it to pick up the latest published software/);
});

// (The connected-branch, gap-headline, button-label and stArm-state tests all
// rendered the org face's backup card and factory notice; the retirement pin
// above already holds that none of those functions survive in member.html.)

// ------------------------------------------------ presence is not proof
//
// Sam revoked a leaked token and the app went on saying GitHub was connected.
// `gh auth token` keeps handing over a REVOKED token forever, so every check
// that asked "is there a token?" answered yes for a credential GitHub had
// already killed. This is the same shape as trap 5 (a scoped not-found means
// "not visible to me", never "gone") pointed the other way: a string being
// present never meant it worked.
test('the status verb ASKS GitHub rather than trusting a stored string', () => {
  const cmd = VERBS['factory-status'].build({}).command;
  assert.match(cmd, /gh api user/, 'the credential is exercised, not merely found');
  assert.ok(cmd.indexOf('gh api user') < cmd.indexOf('GHOK'), 'and the answer drives the check');
  assert.match(cmd, /GH_TOKEN="\$ORG_GH_TOKEN" gh api user/,
    'it must verify the RESOLVED token, not whatever gh happens to be signed in as');
});

test('a revoked credential is told apart from an absent one', () => {
  const prog = VERBS['factory-status'].build({}).command.match(/else node -e '([\s\S]*)'; fi$/)[1];
  const revoked = execFileSync(process.execPath, ['-e', prog], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ORG_GH_OWNER: 'acme', ORG_GH_TOKEN: 'dead-token' },   // no GHOK
  });
  const gone = execFileSync(process.execPath, ['-e', prog], {
    encoding: 'utf8', env: { PATH: process.env.PATH },
  });
  const gh = (out) => JSON.parse(out).checks.find((c) => c.id === 'github');
  assert.equal(gh(revoked).ok, false);
  assert.match(gh(revoked).detail, /revoked or expired/i, 'reconnecting is the fix, and it says which problem it is');
  assert.match(gh(gone).detail, /No GitHub account is connected/i, 'never connected reads differently');
});

test('a working credential still passes', () => {
  const prog = VERBS['factory-status'].build({}).command.match(/else node -e '([\s\S]*)'; fi$/)[1];
  const out = execFileSync(process.execPath, ['-e', prog], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ORG_GH_OWNER: 'acme', ORG_GH_TOKEN: 'live', GHOK: '1' },
  });
  assert.equal(JSON.parse(out).checks.find((c) => c.id === 'github').ok, true);
});

test('GitHub being unreachable is NOT read as a bad credential', () => {
  // The same posture the brain-side preflight takes: a timeout cannot prove a
  // negative, and blocking a rock on our network weather is the worse failure.
  const cmd = VERBS['factory-status'].build({}).command;
  const verify = cmd.slice(cmd.indexOf('GHOK=""'), cmd.indexOf('export GHOK'));
  assert.match(verify, /Bad credentials/, 'only an explicit rejection counts');
  assert.match(verify, /\*\) GHOK=1;;/, 'anything else leaves it passing');
});
