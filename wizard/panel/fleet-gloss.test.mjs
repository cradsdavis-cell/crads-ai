// fleet-gloss.test.mjs — withheld is not zero.
// Run: node --test wizard/panel/fleet-gloss.test.mjs
//
// Why this file exists. A member can switch skill engagement off. The emitter
// then OMITS skills_enabled and skills_installed and sets
// shared.skill_engagement=false, precisely so the rock can tell "they did not
// share this" from "they have none". The fleet card printed
// "0 of 0 skills on" regardless, which an admin reads as a measurement: the
// member may have six installed and four running.
//
// Worse, stallRisk on the SAME card already honoured the flag and printed
// "alive (engagement not shared)", so one card said both things at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');
// lift the helper out of the page and run it for real
const src = html.match(/function skillsGloss\(hb\)\{[\s\S]*?\n  \}/);
assert.ok(src, 'the gloss helper must exist');
// eslint-disable-next-line no-new-func
const skillsGloss = new Function(`${src[0]}; return skillsGloss;`)();

test('a member who withheld engagement is not reported as zero', () => {
  const hb = { generated_at: '2026-08-05T00:00:00Z', shared: { skill_engagement: false, activity: true } };
  assert.equal(skillsGloss(hb), 'engagement not shared');
});

test('a member who shared it is counted exactly', () => {
  const hb = { shared: { skill_engagement: true }, skills_enabled: ['a', 'b', 'c', 'd'], skills_installed: 6 };
  assert.equal(skillsGloss(hb), '4 of 6 skills on');
});

test('a genuine zero still reads as zero', () => {
  const hb = { shared: { skill_engagement: true }, skills_enabled: [], skills_installed: 0 };
  assert.equal(skillsGloss(hb), '0 of 0 skills on');
});

test('a heartbeat from a box older than the shared flag still counts', () => {
  assert.equal(skillsGloss({ skills_enabled: ['a'], skills_installed: 2 }), '1 of 2 skills on');
});

test('the card no longer counts inline, so the two glosses cannot drift apart', () => {
  // Re-pinned 2026-08-10 (third grill): the meta line died with the card's
  // triple-stated health. The count now rides the ONE status sentence, and it
  // must still go through the helper rather than being re-derived there.
  const st = html.match(/function statusRead\(m, y, hb, risk\)\{[\s\S]*?\n  \}/);
  assert.ok(st, 'statusRead must exist');
  assert.match(st[0], /skillsGloss\(hb\)/, 'the healthy sentence goes through the helper');
  assert.doesNotMatch(st[0], /skills_installed/, 'and must not re-derive the count itself');
});
