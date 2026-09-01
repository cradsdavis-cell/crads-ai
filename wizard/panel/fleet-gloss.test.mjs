// fleet-gloss.test.mjs — RETIRED (2026-09-01, the face collapse).
// Run: node --test wizard/panel/fleet-gloss.test.mjs
//
// What this file used to hold. On the org face's fleet card, a member who
// switched skill engagement off had to read "engagement not shared", never
// "0 of 0 skills on": withheld is not zero. The self-host pivot removed the
// fleet card, its per-member heartbeats and both glosses (skillsGloss,
// statusRead) with the org face; no mineral reads another person's engagement
// any more, which is the privacy ruling behind the old test made structural.
// The pin holds that the helpers and the card stay gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');

test('the fleet glosses are RETIRED: no surface reads another member\'s engagement', () => {
  assert.ok(!html.includes('skillsGloss'), 'the skills gloss must stay gone');
  assert.ok(!html.includes('statusRead'), 'the status sentence helper must stay gone');
  assert.ok(!html.includes('skill_engagement'), 'nothing consumes the shared-engagement flag');
  assert.ok(!html.includes('skills_installed'), 'nothing re-derives a fleet skill count');
});
