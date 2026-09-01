// member-stall-heartbeat.test.mjs: `{}` is not a heartbeat.
//
// QA finding 154 (2026-08-16), root cause of finding 129. The operator's Pebbles
// page showed a card reading "Silent Infinityd (mineral not reporting)" because
// an empty heartbeat object slipped past `if (!hb)` and reached the age
// arithmetic, so a freshly wired member was accused of going dark by machinery
// that had not finished wiring them.
//
// RETIRED (face collapse, 2026-09-01): the Pebbles page and the whole
// churn-risk model (stallRisk, seenPhrase, daysSince, ageRank) died with the
// org face. No mineral judges another mineral's liveness any more; the only
// heartbeat left is the box's own local liveness stamp on the machinery rows.
// These pins hold the model gone. If a fleet-health surface is ever reborn for
// the commons era, finding 154's lesson comes back with it: an empty heartbeat
// file is an ABSENT heartbeat, and no card may print Infinity or NaN where a
// day count belongs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');

test('the churn-risk model is RETIRED (2026-09-01): no mineral judges another', () => {
  assert.ok(!html.includes('// ---- Churn-risk model'), 'the model block stays gone');
  for (const fn of ['function stallRisk(', 'function seenPhrase(', 'function ageRank(']) {
    assert.ok(!html.includes(fn), fn + ' stays gone');
  }
  // The word "heartbeat" survives only as the box's own local liveness stamp,
  // never as a verdict about somebody else's silence.
  assert.ok(!/Silent .*not reporting/.test(html), 'the accusation card cannot render');
});
