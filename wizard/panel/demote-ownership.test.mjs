// demote-ownership.test.mjs — retiring a rock must give the box back.
// Run: node --test wizard/panel/demote-ownership.test.mjs
//
// Why this file exists. Promotion writes THREE fields:
//   j.tier="rock"; j.owner="org"; j.owner_slug="<handle>";
// and demotion reversed exactly one of them, with a comment saying so on
// purpose ("touches ONLY the tier field"). So a retired rock kept
// owner:"org" and a pointer to a handle that no longer exists.
//
// What that costs the person: their seat reads "This pebble is owned and
// managed by your rock", the backup line says their brain lives "in
// <retired handle>'s GitHub account, every night", and pressing Connect my
// GitHub answers "the brain belongs to the rock. Ask them to grant the
// transfer" (own-brain.mjs gates on owner === 'org' and then requires a grant
// file). There is no rock left to ask, and no other route to custody,
// so take-ownership dead-ends permanently on a box the person owns outright.
//
// Retire exists only for "a rock started in place on a personal box"
// — the Danger-zone copy says exactly that — so the box was a personal pebble
// before, and a pebble is member-owned by definition. demote.test.mjs never
// caught it because every fixture it seeds already says owner:'member'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMOTE_CMD, promoteFlipCmd } from './panel-server.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';

// Run a /state-shaped command against a temp dir by retargeting the path.
function runOn(cmd, ownership) {
  const dir = tmpDir('demote-');
  mkdirSync(join(dir, 'state'), { recursive: true });
  const f = join(dir, 'state', 'ownership.json');
  writeFileSync(f, JSON.stringify(ownership, null, 2));
  const out = execFileSync('bash', ['-c', cmd.split('/state/ownership.json').join(f)], { encoding: 'utf8' });
  return { out, rec: JSON.parse(readFileSync(f, 'utf8')) };
}

const promoted = () => ({ tier: 'rock', owner: 'org', owner_slug: 'acme', managed_by: 'org', machinery_by: 'crads-ai', anchor: 'acme' });

test('demote gives ownership back to the member, not just the tier', () => {
  const { rec } = runOn(DEMOTE_CMD, promoted());
  assert.equal(rec.tier, 'pebble');
  assert.equal(rec.owner, 'member', 'a pebble is member-owned by definition');
  assert.ok(!rec.owner_slug, 'and it must not still point at the retired handle');
});

test('it exactly reverses what promotion wrote', () => {
  const before = { tier: 'pebble', owner: 'member', owner_slug: '', managed_by: 'org', machinery_by: 'crads-ai', anchor: 'crads-ai' };
  const { rec: up } = runOn(promoteFlipCmd('acme'), before);
  assert.deepEqual({ tier: up.tier, owner: up.owner, owner_slug: up.owner_slug }, { tier: 'rock', owner: 'org', owner_slug: 'acme' });
  const { rec: down } = runOn(DEMOTE_CMD, up);
  assert.deepEqual(
    { tier: down.tier, owner: down.owner, owner_slug: down.owner_slug || '' },
    { tier: before.tier, owner: before.owner, owner_slug: before.owner_slug },
    'a promote then a demote must land back where it started',
  );
});

test('the facts demote has no business touching survive', () => {
  const { rec } = runOn(DEMOTE_CMD, promoted());
  assert.equal(rec.machinery_by, 'crads-ai', 'who runs the machinery is not a demotion question');
  assert.equal(rec.anchor, 'acme', 'the anchor is moved by re-anchor and evict, never by retire');
});

test('demoting a box that is already a pebble changes nothing', () => {
  const already = { tier: 'pebble', owner: 'member', anchor: 'crads-ai' };
  const { out, rec } = runOn(DEMOTE_CMD, already);
  assert.match(out, /already a pebble/);
  assert.deepEqual(rec, already, 'idempotent: no field is rewritten on a no-op');
});
