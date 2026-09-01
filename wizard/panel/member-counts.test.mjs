// member-counts.test.mjs — RETIRED (2026-09-01, the face collapse).
// Run: node --test wizard/panel/member-counts.test.mjs
//
// What this file used to hold. One fleet, one arithmetic, every surface
// (audit 2026-08-25): the hero, the Members tile and Your rock had to count
// members through the tie-counts oracle, wait for both halves of the snapshot
// (index + ties) and bucket people disjointly so the sub-line summed to the
// headline. The self-host pivot removed every one of those surfaces with the
// org face: no fleet, no Members tile, no orgx snapshot, no hero member
// count. tie-counts.mjs itself survives (tie-counts.test.mjs keeps its unit
// truths); what is pinned here is that the UI consumers stay gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');

test('the fleet arithmetic consumers are RETIRED from member.html', () => {
  for (const name of ['lifecycleCounts', 'lifecycleLine', 'orgCounts', 'tiesLoaded', 'stallRisk']) {
    assert.ok(!html.includes(name), `${name} must stay gone`);
  }
  assert.ok(!html.includes("id: 'pebbles'"), 'the Members tile must stay gone');
  assert.ok(!html.includes('Counting the fleet'), 'and so must its waiting copy');
});

test('the hero no longer counts anyone: it introduces the assistant on the one face', () => {
  const hero = html.match(/function renderHero\(\)\{[\s\S]*?\n {2}\}/);
  assert.ok(hero, 'renderHero moved or changed shape');
  assert.match(hero[0], /heroName/, 'the hero names the assistant');
  assert.ok(!/member/.test(hero[0]), 'no member count rides the hero any more');
});
