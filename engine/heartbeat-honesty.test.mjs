// heartbeat-honesty.test.mjs: the metadata a mineral sends its rock must not
// claim more than the mineral can see.
//   node --test engine/heartbeat-honesty.test.mjs
//
// 2026-08-20 audit, two halves of one lie.
//
// `auth_ok` was existsSync on the Claude credential file, and the rock's stall
// board read it as "their sign-in works". A revoked or unrefreshable grant
// leaves that file exactly where it is, so a mineral that could not reach Claude
// at all reported auth_ok:true.
//
// The fallback that should have caught it was reading `skill_runs`, which the
// scheduler stamps BEFORE it enqueues (and the app's Run button stamps on the
// click), so a box whose every run failed still looked busy. Between them: a
// dead mineral that rendered, permanently, as "active, N skills running".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EMITTER = join(HERE, 'heartbeat.mjs');
const TOKEN = 'sk-ant-oat01-THIS-MUST-NEVER-LEAVE-THE-BOX';
const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString();

/**
 * A mineral that is signed in, has two skills switched on, fired both an hour
 * ago, and has had exactly one of them FINISH, eight days back. That is the
 * shape of a box whose Claude grant died a week ago and which nothing noticed.
 */
function mineral({ signedIn = true, sharing = null, ledger = null } = {}) {
  const dir = tmpDir('hbhonest-');
  mkdirSync(join(dir, 'cockpit'), { recursive: true });
  mkdirSync(join(dir, '.claude-auth'), { recursive: true });
  if (signedIn) {
    writeFileSync(join(dir, '.claude-auth', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: 1 } }));
    writeFileSync(join(dir, '.claude-auth', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'member@example.com' } }));
  }
  const entry = (t) => ({ enabled: true, deliver: false, schedule: { kind: 'times', days: [], times: [t] } });
  writeFileSync(join(dir, 'cockpit', 'cadence.json'),
    JSON.stringify({ version: 2, jobs: { daily: entry('07:00'), weekly: entry('17:00') } }));
  writeFileSync(join(dir, 'cockpit', 'skill-runs.json'), JSON.stringify({ daily: iso(1), weekly: iso(1) }));
  writeFileSync(join(dir, 'cockpit', 'run-ledger.jsonl'), (ledger || [
    { ts: iso(24 * 8), job: 'skill /weekly', skill: 'weekly', source: 'cron', status: 'ok', summary: 'done' },
    { ts: iso(24 * 8), job: 'skill /daily', skill: 'daily', source: 'cron', status: 'ok', summary: 'done' },
    { ts: iso(1), job: 'skill /daily', skill: 'daily', source: 'cron', status: 'fail', error: 'Invalid API key' },
  ]).map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (sharing) writeFileSync(join(dir, 'cockpit', 'sharing.json'), JSON.stringify(sharing));
  return dir;
}
const emit = (dir) => {
  execFileSync('node', [EMITTER, dir], { encoding: 'utf8' });
  return {
    sent: JSON.parse(readFileSync(join(dir, 'cockpit', 'heartbeat.json'), 'utf8')),
    full: JSON.parse(readFileSync(join(dir, 'cockpit', 'heartbeat-full.json'), 'utf8')),
  };
};

test('the sign-in field is named after the test it performs', () => {
  const { sent } = emit(mineral());
  assert.equal(sent.claude_credential_present, true,
    'a credential file is on the box, and that is the whole of what this field may say');
  assert.equal(sent.auth_ok, sent.claude_credential_present,
    'auth_ok rides on only as a mirror, for rocks whose engine predates the rename');
});

test('and it is false, under both names, when no sign-in has happened', () => {
  const { sent } = emit(mineral({ signedIn: false }));
  assert.equal(sent.claude_credential_present, false);
  assert.equal(sent.auth_ok, false,
    'dropping the mirror would make a never-signed-in mineral read as fine on an older rock');
});

test('THE REGRESSION: what STARTED and what FINISHED are two different fields', () => {
  const { sent } = emit(mineral());
  // The fire stamp is unchanged, and it is still a fair record of intent.
  assert.deepEqual(Object.keys(sent.skill_runs).sort(), ['daily', 'weekly'],
    'both skills were asked to run an hour ago, which is all skill_runs ever meant');
  // The outcome is the new half, and on this mineral it is the whole story: the
  // last thing that actually completed was eight days ago.
  assert.deepEqual(Object.keys(sent.skill_ok_runs).sort(), ['daily', 'weekly']);
  const ageDays = (t) => (Date.now() - Date.parse(t)) / 86400000;
  assert.ok(ageDays(sent.skill_ok_runs.daily) > 7,
    'daily fired an hour ago and FAILED; its last completion is eight days old, and that is the number that matters');
  assert.ok(ageDays(sent.skill_runs.daily) < 1, 'while the fire stamp still says an hour, as it should');
});

test('a failure never overwrites the last success, and a success always does', () => {
  const dir = mineral({ ledger: [
    { ts: iso(50), job: 'skill /daily', skill: 'daily', source: 'cron', status: 'ok', summary: 'done' },
    { ts: iso(2), job: 'skill /daily', skill: 'daily', source: 'cron', status: 'ok', summary: 'done' },
    { ts: iso(1), job: 'skill /daily', skill: 'daily', source: 'cron', status: 'fail', error: 'boom' },
  ] });
  const { sent } = emit(dir);
  const hours = (Date.now() - Date.parse(sent.skill_ok_runs.daily)) / 3600000;
  assert.ok(hours > 1.5 && hours < 3, 'the newest run that WORKED, not the newest run: ' + sent.skill_ok_runs.daily);
});

test('a mineral that has never finished anything says so by omission, not by silence', () => {
  const dir = mineral({ ledger: [
    { ts: iso(1), job: 'skill /daily', skill: 'daily', source: 'cron', status: 'fail', error: 'Invalid API key' },
  ] });
  const { sent } = emit(dir);
  assert.deepEqual(sent.skill_ok_runs, {},
    'nothing has completed, so nothing is claimed; the reader treats a missing id as never');
  assert.ok(sent.skill_runs.daily, 'and the fire stamp still shows it trying, which is the contrast that reads as broken');
});

test('the new field rides on the same consent toggle as the old one', () => {
  // skill_ok_runs is the same disclosure as skill_runs (which skills, and when)
  // with a truthful verb, so it must not become a way for engagement data to
  // leave a box that switched engagement off.
  const { sent, full } = emit(mineral({ sharing: { skill_engagement: false } }));
  assert.equal(sent.skill_ok_runs, undefined, 'withheld');
  assert.equal(sent.skill_runs, undefined, 'exactly as its pair is');
  assert.equal(sent.shared.skill_engagement, false);
  assert.ok(full.skill_ok_runs, 'the local preview still shows the member what that category would reveal');
  assert.equal(sent.claude_credential_present, true, 'while the health floor is unaffected');
});

test('nothing from the credential file rides up', () => {
  const { sent, full } = emit(mineral());
  for (const [name, o] of [['pushed', sent], ['local', full]]) {
    const dump = JSON.stringify(o);
    assert.ok(!dump.includes(TOKEN), `a token reached the ${name} heartbeat`);
    assert.ok(!/accessToken|sk-ant/.test(dump), `credential material reached the ${name} heartbeat`);
  }
});



// ---------------------------------------------------------------------------
// R2 (panel iteration 2, 2026-08-23): install receipts are on the floor.
// {id, rock, version} per rock-published skill, read from the .origin.json
// catalog-install writes, in BOTH files, and NOT withheld when the member turns
// skill engagement off. The receipts say which and what version; skill_runs
// (gated) says when. A dir with no .origin.json is the member's own and is
// never listed; a malformed one is skipped rather than reported as a rock's.
test('skills_from_rocks rides the floor, in both files, regardless of the toggle', () => {
  const dir = mineral({ sharing: { skill_engagement: false, activity: false } });
  const sk = (id, origin) => {
    mkdirSync(join(dir, '.claude', 'skills', id), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', id, 'SKILL.md'), '---\ntitle: x\n---\n');
    if (origin != null) writeFileSync(join(dir, '.claude', 'skills', id, '.origin.json'), origin);
  };
  sk('pulse-plus', JSON.stringify({ rock: 'acme', version: 3, installed: '2026-08-20' }));
  sk('weekly-pack', JSON.stringify({ rock: 'acme', version: 1, installed: '2026-08-21' }));
  sk('my-own', null);
  sk('broken', '{not json');
  const { sent, full } = emit(dir);
  const want = [{ id: 'pulse-plus', rock: 'acme', version: 3 }, { id: 'weekly-pack', rock: 'acme', version: 1 }];
  assert.deepEqual(sent.skills_from_rocks, want, 'the pushed file carries the receipts even with engagement off');
  assert.deepEqual(full.skills_from_rocks, want, 'and the local preview shows the same list');
  assert.equal(sent.skills_enabled, undefined, 'while the gated category really is withheld');
  assert.equal(sent.shared.skill_engagement, false);
});

test('a box with no rock skills still sends an empty receipts list, never a missing key', () => {
  const { sent } = emit(mineral());
  assert.deepEqual(sent.skills_from_rocks, [], 'the rock must be able to tell "none installed" from "an old emitter"');
});
