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

test('the stamp path runs the credential preamble before it reaches the brain', () => {
  const cmd = VERBS['invite-member'].build({ slug: 'jane01', name: 'Jane', email: 'j@x.com' }).command;
  assert.match(cmd, /gh auth token/, 'invite-member must resolve the connected account');
  assert.ok(cmd.indexOf('gh auth token') < cmd.indexOf('stamp-pebble.sh'),
    'the preamble has to run BEFORE stamp-pebble, or the brain sees an empty environment');
});

// stamp-member was deleted 2026-08-10 (ruling 10: the invite link is the only
// birth path); invite-member above is the one way in and carries the preamble.

test('factory-status is a READ: admin-gated, never mutating, never prints a token', () => {
  const v = VERBS['factory-status'];
  assert.equal(v.adminOnly, true);
  assert.notEqual(v.mutating, true, 'a status read must not be classified as mutating');
  const cmd = v.build({}).command;
  // The token may be EXPORTED (that is the point); it must never be printed.
  assert.doesNotMatch(cmd, /(echo|printf)[^;]*ORG_GH_TOKEN/, 'the credential must never reach stdout');
  assert.doesNotMatch(cmd, /JSON\.stringify\([^)]*ORG_GH_TOKEN/, 'nor ride out in the status payload');
});

test('factory-status is org-edition only: a member has no factory to ask about', () => {
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

// --------------------------------------- the refusal an OLD rock actually sees
//
// Sam hit the identical raw guard AFTER the first fix shipped in build 862.
// Resolving the connected account only helps a rock that HAS one; a rock that
// never ran connect-github had nothing to resolve, control fell through to the
// brain, and an old brain printed "ORG_GH_OWNER + ORG_GH_TOKEN required (repo
// .env)" exactly as before. The friendly refusal lives in the brain's preflight,
// which a rock born before 2026-08-10 does not have and can never pull. So the
// app carries it too, and these tests RUN it.

/** The verb's preamble, cut before it reaches the brain, with the box-only
 *  preconditions redirected at fixtures. Nothing here can stamp anything. */
function preambleUpToBrain(verb, args) {
  const cmd = VERBS[verb].build(args).command;
  const cut = cmd.indexOf('cd "$BR"');
  assert.ok(cut > -1, `${verb} no longer cds into the brain; update this probe`);
  const dir = tmpDir('fa-gate-');
  mkdirSync(join(dir, 'secrets'), { recursive: true });
  mkdirSync(join(dir, 'brain'), { recursive: true });
  writeFileSync(join(dir, 'secrets', 'provisioning.env.local'), 'PEBBLE_IMAGE=img:v2\nHCLOUD_TOKEN=hc\n');
  writeFileSync(join(dir, 'deployment.yaml'), `brain_root: "${join(dir, 'brain')}"\n`);
  writeFileSync(join(dir, 'onboarding-state.json'), '{"phase":"done"}');
  const body = cmd.slice(0, cut)
    .replaceAll('/state/secrets/provisioning.env.local', join(dir, 'secrets', 'provisioning.env.local'))
    .replaceAll('/state/deployment.yaml', join(dir, 'deployment.yaml'))
    .replaceAll('"$BR/onboarding-state.json"', join(dir, 'onboarding-state.json'));
  const f = join(dir, 'probe.sh');
  writeFileSync(f, body + '\necho REACHED-THE-BRAIN\n');
  return { f, brain: join(dir, 'brain') };
}

function runGate(verb, args, env = {}) {
  const { f, brain } = preambleUpToBrain(verb, args);
  if (env.REMOTE) {
    execFileSync('git', ['init', '-q', brain]);
    execFileSync('git', ['-C', brain, 'remote', 'add', 'origin', env.REMOTE]);
  }
  const bin = [dirname(process.execPath), '/usr/bin', '/bin'];
  try {
    const out = execFileSync('bash', [f], {
      encoding: 'utf8',
      env: { PATH: [...(env.EXTRA_BIN ? [env.EXTRA_BIN] : []), ...bin].join(':'), HOME: tmpdir(), ...env },
    });
    return { code: 0, out };
  } catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
}

const INVITE = { slug: 'jane01', name: 'Jane', email: 'j@x.com' };

test('THE SECOND MISS: an unconnected rock is refused HERE, in words, never at the brain\'s guard', () => {
  const r = runGate('invite-member', INVITE);
  assert.equal(r.code, 1, 'it must stop before the brain, or the old raw guard speaks instead');
  assert.doesNotMatch(r.out, /REACHED-THE-BRAIN/);
  assert.match(r.out, /no GitHub account connected/i);
  assert.match(r.out, /connect-github/, 'the one action that fixes it has to be IN the message');
  assert.match(r.out, /Nothing has been created/i);
  assert.doesNotMatch(r.out, /—/, 'house style: no em dashes in product copy');
});

test('a connected rock passes the gate untouched', () => {
  const r = runGate('invite-member', INVITE, { EXTRA_BIN: fakeBin(), REMOTE: 'git@github.com:their-org/b.git' });
  assert.equal(r.code, 0);
  assert.match(r.out, /REACHED-THE-BRAIN/);
});

test('a fully staged operator rock passes the gate untouched', () => {
  const r = runGate('invite-member', INVITE, { GH_OWNER: 'platform-org', GITHUB_TOKEN: 'platform-token' });
  assert.equal(r.code, 0);
  assert.match(r.out, /REACHED-THE-BRAIN/);
});

test('every GitHub-dependent factory verb carries the refusal', () => {
  for (const v of ['invite-member', 'join-approve', 'ask-push']) {
    assert.ok(VERBS[v], `${v} exists`);
  }
  const withGate = ['invite-member', 'join-approve'];
  for (const v of withGate) {
    const cmd = VERBS[v].build(v === 'join-approve'
      ? { id: 'abc12345', slug: 'jane01', name: 'Jane', email: 'j@x.com' }
      : { ...INVITE }).command;
    assert.match(cmd, /no GitHub account connected/, `${v} must refuse in words`);
  }
});

test('the SOFT verbs stay soft: teardown must work on a rock with no GitHub', () => {
  // It pushes from the brain clone and already warns-and-continues. A hard
  // refusal here would strand a rock that can no longer tidy up after itself.
  // (member-revoke died 2026-08-10, rulings 6+8: the End flow runs member-leave.)
  const cmd = VERBS['deprovision-member'].build({ slug: 'jane01', confirm: 'jane01' }).command;
  assert.doesNotMatch(cmd, /no GitHub account connected/, 'deprovision-member must not hard-refuse');
});

test('the refusal travels as ONE shell line, because the verb does', () => {
  // A heredoc would put raw newlines inside a command that crosses ssh and a
  // line-oriented bridge. printf keeps it one line in, many lines out.
  const cmd = VERBS['invite-member'].build(INVITE).command;
  assert.doesNotMatch(cmd, /\n/, 'the built command must not contain a raw newline');
});

// ------------------------------------- the headline an owner actually reads
//
// The refusal is worth nothing if it lands inside a collapsed "Show technical
// detail" while the visible headline still says "Something went wrong while
// creating the member". friendlyStampError is the classifier that decides, and
// its GitHub branch must ALSO recognise the OLD raw guard: a rock born before
// 2026-08-10 still runs the brain that prints it and can never pull a newer one,
// so the app is the only place its owner will ever be told what it means.
test('friendlyStampError names the GitHub cause, for the new refusal AND the old raw guard', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');
  const fn = html.match(/function friendlyStampError\(lines\)\{[\s\S]*?\n {2}\}/);
  assert.ok(fn, 'friendlyStampError moved or changed shape');
  const classify = new Function(`${fn[0]}; return friendlyStampError;`)();

  const cases = [
    ['the old raw brain guard', ['ERROR: ORG_GH_OWNER + ORG_GH_TOKEN required (repo .env; IC_ORG/IC_ORG_TOKEN accepted as legacy names)']],
    ['the new panel refusal', ['This rock has no GitHub account connected.', '    connect-github']],
  ];
  for (const [label, lines] of cases) {
    const r = classify(lines);
    assert.match(r.what, /GitHub/, `${label}: the headline must name the cause`);
    assert.doesNotMatch(r.what, /Something went wrong/, `${label}: still the generic fallback`);
    // The action is the BUTTON now, not the shell command (2026-08-10). The
    // copy must point at the thing a person can press.
    assert.match(r.next, /Connect GitHub/, `${label}: the one action must be in the visible copy`);
    assert.match(r.next, /Members page/, `${label}: and where to find it`);
  }
});

test('the GitHub branch does not swallow the other known failures', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');
  const fn = html.match(/function friendlyStampError\(lines\)\{[\s\S]*?\n {2}\}/);
  const classify = new Function(`${fn[0]}; return friendlyStampError;`)();
  assert.match(classify(['resource_limit_exceeded']).what, /machine limit/);
  // both spellings: the panel's own message and an older brain's guard, which
  // used to fall through to "something went wrong" and explain nothing
  assert.match(classify(['ERROR: your hub is missing its one-time setup tokens']).what, /one-time setup tokens/i);
  assert.match(classify(['ERROR: no /app/provisioning/managed/.env.local (this box\'s ai-os provisioning)']).what, /one-time setup tokens/i);
  assert.match(classify(['finish onboarding this rock first']).what, /onboarding/i);
  assert.match(classify(['totally unknown explosion']).what, /Something went wrong/);
});

// -------------------------------- the page refuses BEFORE the form, not after
//
// Sam: "Need to be very explicit that github needs to be connected before
// stamping." Explaining a failure well is second best; not letting someone fill
// in a colleague's name and email only to meet it is the point.
test('the New pebble button is blocked, and says why, while the factory is unarmed', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');
  const fn = html.match(/function stArm\(\)\{[\s\S]*?\n {2}\}/);
  assert.ok(fn, 'stArm moved or changed shape');
  // stArm calls emailDerived (naming law, 2026-08-17). On the page both live in
  // the same script scope, so hoisting always defines it; here the page's own
  // definition is lifted into the eval scope so the stub cannot drift.
  const ed = html.match(/function emailDerived\(name, email\)\{[\s\S]*?\n {2}\}/);
  assert.ok(ed, 'emailDerived moved or changed shape');

  const els = {};
  const $ = (id) => (els[id] = els[id] || { value: '', disabled: false, textContent: '', style: {}, trim() { return this.value; } });
  // onboarded defaults to true: this test is about the FACTORY gate, and the
  // onboarding gate below owns its own cases.
  const mk = (armed, filled, onboarded = true) => {
    for (const k of Object.keys(els)) delete els[k];
    const g = (id) => ({ value: filled ? 'x' : '', disabled: false, textContent: '', style: {} });
    els.stampBtn = { disabled: false, textContent: '', style: {} };
    els.st_owner = { value: filled ? 'member' : '' };
    els.st_name = { value: filled ? 'Jane' : '' };
    els.st_email = { value: filled ? 'j@x.com' : '' };
    els.stampBlocked = { style: {} };
    // stArm now also reads which gap it is and what to name it.
    // factoryCanAsk = false here: this test is the BLOCKED case, where the rock
    // cannot build and cannot ask either.
    new Function('$', 'esc', 'factoryArmed', 'factoryNeedsGh', 'factoryGapNames', 'factoryCanAsk', 'rockOnboarded',
      `${ed[0]}; ${fn[0]}; stArm();`)(
      (id) => els[id] || null, (x) => String(x), armed, armed === false, 'server provider', false, onboarded);
    return els;
  };

  let e = mk(false, true);
  assert.equal(e.stampBtn.disabled, true, 'a filled-in form must still be refused while unarmed');
  assert.match(e.stampBtn.textContent, /Connect GitHub first/, 'the button itself states the requirement');
  assert.equal(e.stampBlocked.style.display, 'block', 'and the reason is next to it');

  e = mk(true, true);
  assert.equal(e.stampBtn.disabled, false, 'an armed rock with a filled form stamps');
  assert.match(e.stampBtn.textContent, /New Pebble/);
  assert.equal(e.stampBlocked.style.display, 'none');

  e = mk(true, false);
  assert.equal(e.stampBtn.disabled, true, 'an empty form is still an empty form');

  // null = we have not asked yet (old rock, unreachable box). Ignorance must not
  // block: the refusal still lands at press time, with an explanation.
  e = mk(null, true);
  assert.equal(e.stampBtn.disabled, false, 'not knowing must never block a rock that works');

  // THE OTHER GATE ON THE SAME BUTTON (2026-08-14). ONBOARD_GATE refuses at the
  // far end of stamp-member and join-approve, so a rock with perfect credentials
  // and an un-onboarded brain used to show a live button and fail only after a
  // colleague's name and email had been typed in.
  e = mk(true, true, false);
  assert.equal(e.stampBtn.disabled, true, 'a fully armed factory does not beat an un-onboarded brain');
  assert.match(e.stampBtn.textContent, /Onboard this rock first/, 'and the button names THAT obstacle');
  assert.equal(e.stampBlocked.style.display, 'block');
  assert.match(e.stampBlocked.innerHTML, /\/onboard/, 'with the command that fixes it');

  e = mk(true, true, null);
  assert.equal(e.stampBtn.disabled, false, 'an unread onboarding state is ignorance, and ignorance never blocks');

  // Both broken: naming one and meeting the other on the next press is the same
  // failure twice.
  e = mk(false, true, false);
  assert.match(e.stampBlocked.innerHTML, /\/onboard/);
  assert.match(e.stampBlocked.innerHTML, /GitHub/);
});

// ------------------------------- "is it still loading?" must be answerable
//
// Sam, watching a backup run: "I don't know if this is still loading because
// Connect GitHub is selectable again". Disabling the button was a one-off DOM
// write, so any repaint rebuilt it in its default enabled state. Same lesson as
// the erased outcome (trap 23), one attribute over: what you render comes from
// state, never from a mutation a paint can undo.
test('the button is rendered FROM the flow state, not disabled by a one-off write', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');
  const fn = html.match(/function renderRockBackup\(\)\{[\s\S]*?\n {2}\}/);
  assert.ok(fn, 'renderRockBackup moved or changed shape');
  assert.match(fn[0], /orgGhBusy/, 'the paint has to know whether a flow is running');
  assert.match(fn[0], /Connecting…/, 'and say so on the control itself');
  // and the same for the readiness notice on the Pebbles page
  const notice = html.match(/function loadFactoryStatus\(\)\{[\s\S]*?\n {2}\}/);
  assert.match(notice[0], /orgGhBusy/, 'both surfaces render from the same state');
});

test('every exit from the flow clears the busy state', () => {
  // A stuck-busy button is worse than a lying one: it cannot be retried at all.
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');
  const region = html.slice(html.indexOf('function orgGhStart'), html.indexOf('function loadFleetHealth'));
  const sets = (region.match(/orgGhBusy = true/g) || []).length;
  const clears = (region.match(/orgGhBusy = false/g) || []).length;
  assert.equal(sets, 1, 'one place starts a flow');
  assert.ok(clears >= 4, `every terminal path clears it (start error, network error, done, failed); found ${clears}`);
});

test('what the flow says is remembered, so a repaint cannot silence it mid-run', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');
  assert.match(html, /function orgGhSay\(html\)\{ orgGhOutcome = html;/,
    'saying something and remembering it must be the same act, or they drift');
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

test('the connected branch no longer throws anyone at a terminal', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');
  const fn = html.match(/function renderRockBackup\(\)\{[\s\S]*?\n {2}\}/)[0];
  // orgGhBackup since 2026-08-12: the same backup leg the connect flow runs, so
  // it can repoint a remote that turns out to be another box's repo. The bare
  // push it replaced could only repeat the rejection that remote guarantees.
  assert.match(fn, /if \(st\.connected\) \{ orgGhBackup\(\); return; \}/);
  assert.doesNotMatch(fn, /openTerm\(\{ autorun: 'connect-github' \}\)/, 'no terminal hop survives on this card');
});

// ------------------------------- the notice must name the gap it actually has
//
// Sam, on a rock whose GitHub was connected and whose metal was not: "But I do
// have a github account connected". The box was right (factory-status reported
// github ok, server and address failing); the UI was hardcoded to the GitHub
// sentence because that was the only case when it was written. Copy written for
// one gap must not survive as copy for every gap.
test('the headline branches on whether GitHub is actually one of the gaps', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');
  const fn = html.match(/function loadFactoryStatus\(\)\{[\s\S]*?\n {2}\}/)[0];
  assert.match(fn, /if \(needsGh\) noticeHead\(/, 'the headline is chosen, not fixed');
  assert.match(fn, /This rock cannot build a pebble yet/, 'and there is a non-GitHub headline to choose');
  assert.match(fn, /hosting side/, 'which names the side that IS missing');
});

test('the button label and the line beside it follow the same fact', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');
  const fn = html.match(/function stArm\(\)\{[\s\S]*?\n {2}\}/)[0];
  assert.match(fn, /factoryNeedsGh \? 'Connect GitHub first' : 'Not ready to build'/,
    'sending someone to connect an account that is already connected is a dead end');
  assert.match(fn, /factoryGapNames/, 'and the reason names the real gaps');
});

test('stArm reads state, so the two surfaces cannot disagree', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');
  assert.match(html, /var factoryNeedsGh = false;/);
  assert.match(html, /factoryNeedsGh = gaps\.some/, 'set from the same gaps the notice renders');
  assert.match(html, /factoryNeedsGh = false; factoryGapNames = '';/, 'and cleared when the answer is unknown');
});

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
