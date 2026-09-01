// member-auth-honesty.test.mjs: the stall board must not call a dead mineral
// "active, N skills running".
//   node --test wizard/panel/member-auth-honesty.test.mjs
//
// 2026-08-20 audit. Two fields, one false green: auth_ok was existsSync on a
// credential file (a revoked grant leaves the file in place), and skill_runs
// was the scheduler's fire stamp (written before anything finished). Together
// a mineral whose Claude grant had been revoked rendered as healthy for as
// long as it kept checking in. The fix renamed the fields to what they really
// answer (claude_credential_present, skill_ok_runs) and taught stallRisk the
// vocabulary of completion.
//
// RETIRED (face collapse, 2026-09-01): the stall board and the whole
// churn-risk model died with the org face; no mineral renders another
// mineral's health any more. These pins hold the board gone. The 2026-08-20
// lesson outlives the board: any reborn fleet-health surface must read
// completion, not fire stamps, and must name credential PRESENCE, not
// sign-in health.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');

test('the stall board is RETIRED (2026-09-01): nothing judges another mineral', () => {
  assert.ok(!html.includes('// ---- Churn-risk model'), 'the churn model stays gone');
  assert.ok(!html.includes('function stallRisk('), 'stallRisk stays gone');
  assert.ok(!html.includes('function credentialPresent('), 'and so does its sign-in reading');
  assert.ok(!html.includes('skill_ok_runs'), 'no surface left consumes the completion ledger');
  assert.ok(!html.includes('skills running'), 'the "N skills running" sentence cannot render');
});
