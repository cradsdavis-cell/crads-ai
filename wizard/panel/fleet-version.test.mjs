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
//
// RETIRED (2026-09-01, the face collapse). buildState, the fleet summary and
// the per-member version chip lived on the org face's fleet cards, and no
// mineral reads another mineral's build any more. The stamp, the bake wiring,
// the heartbeat read and the stall-board transport above all survive (the box
// still reports ITS OWN build, and the machinery rows read it); what is
// pinned here is that the comparison surface stays gone.
test('the fleet version surface is RETIRED: nothing in the panel judges another box\'s build', () => {
  const html = read('wizard/panel/member.html');
  assert.ok(!html.includes('buildState'), 'the comparison helper must stay gone');
  assert.ok(!html.includes('orgx.selfBuild'), 'and the baseline it compared against');
  assert.ok(!html.includes('older software'), 'and the fleet summary sentence');
});
