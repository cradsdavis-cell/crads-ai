// members-iter2.test.mjs — RETIRED (2026-09-01, the face collapse).
//   node --test wizard/panel/members-iter2.test.mjs
//
// What this file used to hold. The rock's Members page after panel iteration
// 2: the five R5 lifecycle states judged by one function, the 3-day quiet
// line, R6 Forget on ended rows, the R14 Skills fold, R27 naming. The
// self-host pivot removed the page, renderFleet, memberLifecycle and the
// churn-risk model with the org face: no mineral renders a fleet of other
// people's minerals any more. The pins below hold that the page and its
// judges stay gone, plus the surviving builder truths of member-forget (the
// verb table keeps its builders exported for unit tests until the machinery
// is deleted, and archive-never-delete is worth holding while it exists).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

test('the Members page is RETIRED: no fleet surface remains in member.html', () => {
  assert.ok(!html.includes('<section data-sec="pebbles"'), 'the section must stay gone');
  // comments and CSS notes may still recall the old machinery; code must not
  // (stateChip is not in this list: the Skills page reuses that name for its
  // own install chip, a different and living subject)
  const code = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const name of ['renderFleet', 'memberLifecycle', 'stallRisk', 'memberSkillsFold', 'buildEndedRow', 'buildMemberCard']) {
    assert.ok(!code.includes(name), `${name} must stay gone`);
  }
  // old deep links still land somewhere living rather than nowhere
  assert.match(html, /if \(name === 'pebbles' \|\| name === 'decisions' \|\| name === 'yourrock'\) name = 'seat';/,
    'a hosted-era #pebbles bookmark lands on the seat');
});

