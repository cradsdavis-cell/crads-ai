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
// Stop hosting exists only for a mineral upgraded in place on a personal box,
// so the box was a personal pebble before, and a pebble is member-owned by
// definition. demote.test.mjs never caught it because every fixture it seeds
// already says owner:'member'.
//
// The face collapse (2026-09-01): DEMOTE_CMD survives as the box-side half of
// stop hosting, so its truths below still hold. promoteFlipCmd, the write it
// reverses, is deleted with the whole promote machinery; its round-trip test
// became a retirement pin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as panel from './panel-server.mjs';
const { DEMOTE_CMD } = panel;
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

test('the promote flip is RETIRED (2026-09-01): nothing mints a rock in place any more', () => {
  // The round-trip test (promote then demote lands back where it started) lost
  // its first half: promoteFlipCmd and the rest of the promote constants left
  // with the hosted model. The stronger truth is that the panel no longer
  // exports any of them, so no code path can write owner:"org" again; the
  // fixtures above stand in for boxes promoted in the hosted era.
  for (const name of ['promoteFlipCmd', 'PROMOTE_CONSENT', 'PRECOPY_CMD', 'PROMOTE_MINT_CMD',
    'promotePendingWriteCmd', 'PROMOTE_PENDING_CLEAR_CMD', 'PROMOTE_UNANCHOR_CMD', 'unanchorCmd']) {
    assert.equal(panel[name], undefined, `${name} must stay unexported`);
  }
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
