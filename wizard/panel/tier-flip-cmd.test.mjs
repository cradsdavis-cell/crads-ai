// tier-flip-cmd.test.mjs — the promote/demote box-side flips must SURVIVE the
// shell. Run: node --test wizard/panel/tier-flip-cmd.test.mjs
//
// Why this file exists. Both flips are node one-liners built as JS template
// literals and shipped to the box inside `node -e '...'`. Writing `+"\n"` in
// the template puts a REAL newline in the emitted command, inside a
// single-quoted JS string literal, which node refuses to parse:
//
//   fs.writeFileSync(f,JSON.stringify(j,null,2)+"
//   ");                                          <- SyntaxError
//
// So "Retire this rock" answered 500 with a raw node stack trace, and
// promote's flip could never have written a tier either. demote.test.mjs and
// promote-flow.test.mjs both passed throughout, because they stub the bridge
// and assert on the ROUTE — nothing ever handed the built string to a shell.
// That is the gap this file closes: it EXECUTES the command the box would run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEMOTE_CMD, promoteFlipCmd } from './panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

// Run a flip command the way the box does: sh -c, with /state/ownership.json
// redirected at a temp file. The command hardcodes the real path, so the test
// rewrites just that literal — everything else, including the quoting under
// test, is byte-identical to what ships.
function runFlip(cmd, ownership) {
  const dir = tmpDir('flip-');
  const f = join(dir, 'ownership.json');
  writeFileSync(f, JSON.stringify(ownership, null, 2));
  const out = execFileSync('sh', ['-c', cmd.split('/state/ownership.json').join(f)], { encoding: 'utf8' });
  return { out: out.trim(), json: JSON.parse(readFileSync(f, 'utf8')) };
}

test('the emitted commands carry no raw newline (the SyntaxError shape)', () => {
  for (const [name, cmd] of [['demote', DEMOTE_CMD], ['promote', promoteFlipCmd('acme')]]) {
    assert.equal(cmd.includes('\n'), false, `${name} flip embeds a real newline in a quoted JS string`);
  }
});

test('demote flips a rock to a pebble and touches nothing else', () => {
  const before = { owner: 'member', managed_by: 'org', machinery_by: 'crads-ai', tier: 'rock', anchor: 'acme' };
  const { out, json } = runFlip(DEMOTE_CMD, before);
  assert.match(out, /demoted: this mineral is a pebble again/);
  assert.equal(json.tier, 'pebble');
  assert.deepEqual({ ...json, tier: 'x' }, { ...before, tier: 'x' }, 'only tier may change');
});

test('demote is idempotent: an already-pebble exits 0 and says so', () => {
  const { out, json } = runFlip(DEMOTE_CMD, { owner: 'member', tier: 'pebble' });
  assert.match(out, /already a pebble/);
  assert.equal(json.tier, 'pebble');
});

test('promote flips a pebble to a rock and names the org', () => {
  const { out, json } = runFlip(promoteFlipCmd('acme'), { owner: 'member', managed_by: 'org', tier: 'pebble' });
  assert.match(out, /promoted: this mineral is a rock/);
  assert.equal(json.tier, 'rock');
  assert.equal(json.owner, 'org');
  assert.equal(json.owner_slug, 'acme');
});

test('the written file ends with a trailing newline (why the escape exists)', () => {
  const dir = tmpDir('flip-');
  const f = join(dir, 'ownership.json');
  writeFileSync(f, JSON.stringify({ tier: 'rock' }, null, 2));
  execFileSync('sh', ['-c', DEMOTE_CMD.split('/state/ownership.json').join(f)]);
  assert.equal(readFileSync(f, 'utf8').endsWith('}\n'), true);
});

// ---------------------------------------------------------------------------
// The arming phrase must match what the USER IS SHOWN. `label{}` in panel.html
// sets text-transform:uppercase, so the instruction renders as
// "TYPE EXACTLY: RETIRE THIS ROCK". Typing exactly that left the button
// disabled forever, with nothing on screen explaining why: the check compared
// case-sensitively against the lowercase source text. A confirmation gate whose
// pass condition is invisible is not a gate, it is a dead end.
import { readFileSync as rf } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join as pjoin } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));

test('the retire gate accepts the phrase as the user sees it (uppercased by CSS)', () => {
  const html = rf(pjoin(HERE, 'member.html'), 'utf8');
  const arm = html.match(/rt_confirm'\)\.addEventListener\('input',[\s\S]{0,600}?\}\);/);
  assert.ok(arm, 'the arming handler must still exist');
  assert.match(arm[0], /toLowerCase\(\)/, 'client arming must fold case');
  const srv = rf(pjoin(HERE, 'panel-server.mjs'), 'utf8');
  const check = srv.match(/form\.confirm[\s\S]{0,160}?retire this rock/);
  assert.ok(check, 'the server check must still exist');
  assert.match(check[0], /toLowerCase\(\)/, 'server check must fold case');
});

// ---------------------------------------------------------------------------
// THE UNANCHOR DETACH, EXECUTED (promote ruling 2026-08-10). Same reason this
// file exists at all: the detach is a shell string assembled in JS, with nested
// single quotes around two `node -e` one-liners and a `.` source in the middle,
// and nothing else in the suite ever hands it to a shell. The route tests stub
// the bridge, so a quoting defect would pass every one of them and fail on the
// first real promotion.
import { PROMOTE_UNANCHOR_CMD } from './panel-server.mjs';
import { mkdirSync, existsSync } from 'node:fs';
import { execFileSync as execSync2 } from 'node:child_process';

// Run the detach the way the box does, with /state redirected at a temp dir.
function runDetach({ anchored = true, channel = true } = {}) {
  const dir = tmpDir('unanchor-');
  mkdirSync(join(dir, 'secrets'), { recursive: true });
  const remote = join(dir, 'heartbeat.git');
  if (anchored) {
    // ORG_GH_OWNER + SLUG are what the real conf carries; HEARTBEAT_REMOTE_URL
    // is the documented override, pointed at a LOCAL bare repo so the publish
    // leg is genuinely exercised without a network or a key.
    writeFileSync(join(dir, 'org-inbox.conf'),
      `ORG_GH_OWNER=harriets-rock\nSLUG=jane01\nHEARTBEAT_REMOTE_URL=${remote}\n`);
  }
  if (channel) {
    writeFileSync(join(dir, 'heartbeat.conf'), 'ORG_GH_OWNER=harriets-rock\nSLUG=jane01\n');
    writeFileSync(join(dir, 'secrets', 'heartbeat_deploy_key'), 'not-a-real-key\n');
    execSync2('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    // a bare repo with no commits refuses a --depth 1 clone, so seed one
    const seed = tmpDir('seed-');
    execSync2('git', ['init', '-q', '-b', 'main', seed]);
    writeFileSync(join(seed, 'README'), 'heartbeat\n');
    execSync2('git', ['-C', seed, 'add', '-A']);
    execSync2('git', ['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
    execSync2('git', ['-C', seed, 'push', '-q', remote, 'main']);
  }
  const out = execFileSync('sh', ['-c', PROMOTE_UNANCHOR_CMD.split('/state').join(dir)], { encoding: 'utf8' });
  return { out: out.trim(), dir, remote };
}

test('unanchor: publishes the leave marker, then detaches the channel', () => {
  const { out, dir, remote } = runDetach();
  assert.match(out, /UNANCHOR-OK/);
  // the marker reached the rock's channel: this is what its leave-reconcile reads
  const log = execSync2('git', ['-C', remote, 'show', '--name-only', '--format=%s', 'HEAD'], { encoding: 'utf8' });
  assert.match(log, /leave: anchor dropped on promotion/);
  assert.match(log, /leave\.json/);
  // and the box has stopped talking to them: both jobs self-guard on these confs
  for (const gone of ['heartbeat.conf', 'org-inbox.conf', 'org-contact.json',
    'secrets/heartbeat_deploy_key', 'secrets/org_inbox_deploy_key']) {
    assert.equal(existsSync(join(dir, gone)), false, `${gone} must be gone`);
  }
  assert.equal(existsSync(join(dir, 'left.json')), true, 'the box keeps its own record of the departure');
});

test('unanchor: an unanchored mineral is a clean no-op (the flip is retryable)', () => {
  const { out, dir } = runDetach({ anchored: false, channel: false });
  assert.match(out, /UNANCHOR-NONE/);
  assert.equal(existsSync(join(dir, 'left.json')), false, 'nothing to leave, nothing written');
});

test('unanchor: no channel left (already half-detached) still completes the detach', () => {
  const { out, dir } = runDetach({ anchored: true, channel: false });
  assert.match(out, /UNANCHOR-OK/);
  assert.equal(existsSync(join(dir, 'org-inbox.conf')), false);
});
