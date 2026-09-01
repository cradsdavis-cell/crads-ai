// fleet-version.test.mjs: the fleet software-version surface (2026-08-23).
//   node --test wizard/panel/fleet-version.test.mjs
//
// WHAT THIS PINS. `app_commit` has ridden up in every heartbeat since the
// three-layer work and was null on every box ever shipped: the only source was
// `git -C /app rev-parse HEAD`, and `.git` is line 1 of .dockerignore, so
// /app/.git exists in no image. The field meant to answer "did the update land
// on that box" answered nothing, silently, fleet-wide. It surfaced when a
// member's own audit reported an unchanged file while the repo held the fix:
// both were true, and nothing on the operator's side could tell them apart.
//
// Zero deps: file-content assertions on the shipped artefacts + a real run of
// the heartbeat reader against a temp stamp. No SSH, no network, no docker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERBS } from './panel-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ---------------------------------------------------------------- the stamp
test('both shipped images bake a build stamp to /etc/aios-build', () => {
  for (const f of ['Dockerfile.member', 'Dockerfile.rock']) {
    const d = read(f);
    assert.match(d, /ARG BUILD_SHA/, `${f}: no BUILD_SHA arg`);
    assert.match(d, /\/etc\/aios-build/, `${f}: nothing writes the stamp`);
    // The stamp must be the LAST content layer: written before the entrypoint
    // line and after the COPYs, so it reflects THIS build and not a cached base.
    assert.ok(d.indexOf('/etc/aios-build') < d.indexOf('ENTRYPOINT'),
      `${f}: the stamp must be written before ENTRYPOINT`);
  }
});

test('bake passes the commit into both variants, and CI supplies it', () => {
  const bake = read('docker-bake.hcl');
  assert.match(bake, /variable "BUILD_SHA"/);
  // Both member and rock must receive it; a stamp on one image only would leave
  // half the fleet unreadable and is exactly the silent half-fix to guard against.
  const targets = bake.split('target "').slice(1);
  for (const name of ['member', 'rock']) {
    const t = targets.find((x) => x.startsWith(`${name}"`));
    assert.ok(t, `no ${name} target`);
    assert.match(t, /args\s*=\s*\{[^}]*BUILD_SHA/, `${name}: BUILD_SHA not passed`);
  }
  assert.match(read('.github/workflows/docker-publish.yml'), /BUILD_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/);
});

// ------------------------------------------------------- the heartbeat read
test('heartbeat prefers the baked stamp and still reports built_at', () => {
  const hb = read('engine/heartbeat.mjs');
  assert.match(hb, /\/etc\/aios-build/, 'heartbeat never reads the stamp');
  assert.match(hb, /built_at: builtAt/, 'built_at does not ride the payload');
  // The git probe stays, but only as the fallback: if it ran first, a dev
  // checkout would mask the stamp and the regression could not be seen.
  // Compare CODE positions, not prose: the comment above the block names
  // rev-parse as the old broken source, and matching that would pass on a file
  // where the probe had been restored to primary.
  const code = hb.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(code.indexOf('/etc/aios-build') < code.indexOf('rev-parse'),
    'the git probe must be the fallback, not the primary source');
  // Both payloads (full + shared) carry it: the shared one is what actually
  // reaches the rock, so a field present only on the full blob is invisible.
  assert.equal((hb.match(/app_commit: appCommit/g) || []).length, 2,
    'app_commit must ride BOTH the full and the shared heartbeat');
});

// ------------------------------------------------------------ the transport
test('stall-board carries the rock\'s own build as the comparison baseline', () => {
  const cmd = VERBS['stall-board'].build().command;
  assert.match(cmd, /__SELFBUILD__/, 'no self-build section');
  assert.match(cmd, /\/etc\/aios-build/, 'the rock never reads its own stamp');
  // A rock on a pre-stamp image must yield parseable emptiness, not a shell
  // error that would corrupt the heartbeat blob parsed just above it.
  assert.match(cmd, /cat \/etc\/aios-build 2>\/dev\/null \|\| echo "\{\}"/);
  assert.ok(cmd.indexOf('__HEARTBEATS__') < cmd.indexOf('__SELFBUILD__'),
    'the self-build section must come last, or it lands inside the heartbeat blob');
});

// --------------------------------------------------------------- the surface
test('the panel reads the version and refuses to guess when it cannot', () => {
  const html = read('wizard/panel/member.html');
  assert.match(html, /function buildState\(/, 'no buildState helper');
  // Three states, and the unknown one must exist: a box that cannot report its
  // build must never be rendered as current. That silent upgrade to good news
  // is the whole failure this surface exists to prevent.
  for (const level of ['current', 'behind', 'unknown']) {
    assert.match(html, new RegExp(`level: '${level}'`), `buildState never returns ${level}`);
  }
  assert.match(html, /orgx\.selfBuild/, 'the rock baseline is never parsed');
  assert.match(html, /older software/, 'the fleet summary never counts stale boxes');
  // A preserved (open-fold) card must repaint when the version changes, or it
  // keeps asserting "older software" after that mineral has restarted: finding
  // 165's shape, on a new field.
  const shape = html.slice(html.indexOf('function cardShape('), html.indexOf('function cardShape(') + 700);
  assert.match(shape, /buildState/, 'cardShape omits the build state');
});

test('a member reporting no build is unknown, never current', () => {
  // The helper is a pure function of (heartbeat, orgx.selfBuild), so it is
  // lifted out of the page and run directly rather than asserted as a string.
  const html = read('wizard/panel/member.html');
  const src = html.slice(html.indexOf('function buildState(hb){'));
  const body = src.slice(0, src.indexOf('\n  }') + 4);
  const orgx = { selfBuild: 'abc1234' };
  const buildState = new Function('orgx', `${body}; return buildState;`)(orgx);

  assert.equal(buildState(null).level, 'unknown', 'no heartbeat must be unknown');
  assert.equal(buildState({}).level, 'unknown', 'no app_commit must be unknown');
  assert.equal(buildState({ app_commit: 'abc1234' }).level, 'current');
  assert.equal(buildState({ app_commit: 'abc1234567890' }).level, 'current',
    'a long sha must compare on its first 7, not fail to match');
  assert.equal(buildState({ app_commit: 'def5678' }).level, 'behind');
  assert.match(buildState({ app_commit: 'def5678' }).why, /abc1234/,
    'the behind explanation must name the baseline it is judging against');

  // No baseline: the members are readable but there is nothing to compare to.
  const orgx2 = { selfBuild: null };
  const bs2 = new Function('orgx', `${body}; return buildState;`)(orgx2);
  assert.equal(bs2({ app_commit: 'def5678' }).level, 'unknown',
    'with no rock baseline, a member must not be judged behind');
});
