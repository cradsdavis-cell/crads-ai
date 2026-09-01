// member-auth-honesty.test.mjs: the stall board must not call a dead mineral
// "active, N skills running".
//   node --test wizard/panel/member-auth-honesty.test.mjs
//
// 2026-08-20 audit. Two fields, one false green.
//
//   auth_ok      was existsSync on the mineral's Claude credential file, and this
//                page read it as "their sign-in works". A revoked or
//                unrefreshable grant leaves that file exactly where it was.
//   skill_runs   is the SCHEDULER'S FIRE STAMP, written the moment it decides to
//                run something, before the kernel has drained anything. So the
//                one health fallback here ("enabled daily but not running") could
//                not see a mineral whose every run failed: the stamp moved on
//                schedule however the run ended.
//
// Together, a mineral whose Claude grant had been revoked reported a credential
// file, reported fresh fire stamps, and rendered as healthy for as long as it
// kept checking in. The emitter now sends claude_credential_present (the honest
// name for the presence test) and skill_ok_runs (the kernel's record of runs that
// FINISHED), and these tests drive the real stallRisk against both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');

// Same extraction as member-stall-heartbeat.test.mjs: run the REAL function, do
// not assert on its source. Source reading it looked right the whole time.
const churn = (() => {
  const from = html.indexOf('// ---- Churn-risk model');
  const to = html.indexOf('// ---- Catalogue');
  assert.ok(from > -1 && to > from, 'found the churn-risk model in member.html');
  const seenFrom = html.indexOf('function seenPhrase(hb){');
  const seenTo = html.indexOf('function statusRead(', seenFrom);
  // eslint-disable-next-line no-new-func
  return new Function('return (function(){' + html.slice(from, to) + html.slice(seenFrom, seenTo)
    + 'return { stallRisk: stallRisk, credentialPresent: credentialPresent };})()')();
})();
const { stallRisk, credentialPresent } = churn;

const at = (days) => new Date(Date.now() - days * 86400000).toISOString();
const member = (over) => Object.assign({ slug: 'cert-two', status: 'active', attached: true, wired: '2026-01-04' }, over);
const said = (r) => (r ? String(r.reason) : '');

/** A mineral checking in hourly, signed in, two skills on, both fired an hour ago. */
const reporting = (over) => Object.assign({
  generated_at: at(0.04),
  claude_credential_present: true,
  auth_ok: true,
  onboarded: true,
  shared: { skill_engagement: true, activity: true },
  skills_installed: 2,
  skills_enabled: ['daily', 'weekly'],
  skill_runs: { daily: at(0.04), weekly: at(0.04) },
}, over);

test('THE REGRESSION: firing every hour and finishing nothing is not "active"', () => {
  // The revoked-grant signature exactly: the box is up, the credential file is
  // where it always was, cadence keeps firing, and nothing has completed in a
  // week. This used to read "active · 2 skills running".
  const r = stallRisk(member(), reporting({ skill_ok_runs: { daily: at(8), weekly: at(8) } }));
  assert.notEqual(r.level, 'ok', 'a mineral that has finished nothing in a week is not ok: ' + said(r));
  assert.match(said(r), /daily, weekly/, 'and it names which ones');
  assert.match(said(r), /finished/, 'in the vocabulary of completion, because "not running" sends the owner to the wrong place');
});

test('a mineral that has NEVER finished a run is caught the same way', () => {
  // skill_ok_runs omits a skill with no successful run in the ledger window, and
  // an omission has to read as "no evidence of a finish", not as fine.
  const r = stallRisk(member(), reporting({ skill_ok_runs: {} }));
  assert.notEqual(r.level, 'ok', said(r));
  assert.match(said(r), /daily, weekly/);
});

test('and a mineral that IS finishing its work still reads as active', () => {
  // The other half. A fix that flagged everything would be the same failure
  // upside down.
  const r = stallRisk(member(), reporting({ skill_ok_runs: { daily: at(0.2), weekly: at(1) } }));
  assert.equal(r.level, 'ok', said(r));
  assert.match(said(r), /2 skills running/);
});

test('one skill finishing and one not names only the one that is not', () => {
  const r = stallRisk(member(), reporting({ skill_ok_runs: { daily: at(0.2), weekly: at(9) } }));
  assert.equal(r.level, 'watch');
  assert.match(said(r), /enabled weekly but/);
  assert.ok(!/daily/.test(said(r)), 'daily is finishing, so it is not the owner\'s problem: ' + said(r));
});

test('a mineral on an older engine is judged exactly as it was', () => {
  // A fleet upgrades one box at a time, and a member whose engine predates
  // skill_ok_runs still sends auth_ok and skill_runs. Falling back is what stops
  // the rename from turning every un-upgraded member amber overnight.
  const legacy = { generated_at: at(0.04), auth_ok: true, onboarded: true,
    shared: { skill_engagement: true, activity: true },
    skills_installed: 2, skills_enabled: ['daily'], skill_runs: { daily: at(0.2) } };
  assert.equal(stallRisk(member(), legacy).level, 'ok');
  const stale = Object.assign({}, legacy, { skill_runs: { daily: at(9) } });
  assert.equal(stallRisk(member(), stale).level, 'watch');
  assert.match(said(stallRisk(member(), stale)), /but not running/,
    'and it keeps the old sentence, because the old field really did only answer that');
});

test('the sign-in reading falls back too, and says only what it saw', () => {
  assert.equal(credentialPresent({ claude_credential_present: false, auth_ok: false }), false);
  assert.equal(credentialPresent({ auth_ok: false }), false, 'an older mineral is still heard');
  assert.equal(credentialPresent({ claude_credential_present: true, auth_ok: true }), true);
  assert.equal(credentialPresent({}), undefined, 'saying nothing is not saying no');
});

test('no credential on the mineral is reported without inventing an expiry', () => {
  // Finding 103 split "never signed in" from the rest, and the rest was called
  // "had expired". This side cannot see an expiry: what it has is the absence of
  // a credential, which is a mineral that was signed out or never finished.
  const gone = stallRisk(member(), { generated_at: at(2), claude_credential_present: false, auth_ok: false, onboarded: true });
  assert.equal(gone.level, 'risk');
  assert.match(said(gone), /last reported 2d ago/, 'finding 130 stays fixed: the claim is dated to the report');
  assert.match(said(gone), /holding no Claude sign-in/);
  assert.ok(!/expired/.test(said(gone)), 'nothing here can tell a lapse from a sign-out: ' + said(gone));

  const never = stallRisk(member(), { generated_at: at(2), claude_credential_present: false, auth_ok: false, onboarded: false });
  assert.match(said(never), /never signed in/, 'finding 103 stays fixed: setup is not the same as breakage');
});

test('a member who withholds skill engagement is not accused of anything', () => {
  // The board cannot see completions it was never sent, and "alive" is the most
  // it may claim. Withheld is not zero (the same card once said both).
  const r = stallRisk(member(), reporting({ shared: { skill_engagement: false, activity: true },
    skills_enabled: undefined, skill_runs: undefined, skill_ok_runs: undefined }));
  assert.equal(r.level, 'ok');
  assert.match(said(r), /engagement not shared/);
});


