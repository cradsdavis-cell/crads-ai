// member-stall-heartbeat.test.mjs: `{}` is not a heartbeat.
//
// QA finding 154 (2026-08-16), root cause of finding 129. The operator's Pebbles
// page showed a card reading:
//
//     Silent Infinityd (mineral not reporting)
//
// /state/brain/heartbeats/<slug>.json is written as an EMPTY OBJECT for a pebble
// that has never checked in. `if (!hb)` is false for `{}`, so the two branches
// that exist for exactly that state were both unreachable:
//
//   - the never-checked-in verdict, so the code fell through to age arithmetic
//     against a generated_at that was never set: Infinity, pasted into the
//     sentence with the unit still on the end;
//   - the DESIGNED grace path ("just wired, the first check-in is up to 90
//     minutes out"), so a correctly freshly wired member was accused of going
//     dark by the very machinery that had not finished wiring them. That is the
//     same false alarm the 2026-08-10 comments in stallRisk say was fixed twice.
//
// These tests run the real stallRisk rather than asserting on its source: the
// whole point is that source reading it says `!hb` and looks right.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');

const churn = (() => {
  const from = html.indexOf('// ---- Churn-risk model');
  const to = html.indexOf('// ---- Catalogue');
  assert.ok(from > -1 && to > from, 'found the churn-risk model in member.html');
  const seenFrom = html.indexOf('function seenPhrase(hb){');
  const seenTo = html.indexOf('function statusRead(', seenFrom);
  assert.ok(seenFrom > -1 && seenTo > seenFrom, 'found seenPhrase, which renders the same age');
  // eslint-disable-next-line no-new-func
  return new Function('return (function(){' + html.slice(from, to) + html.slice(seenFrom, seenTo)
    + 'return { daysSince: daysSince, hbMissing: hbMissing, ageRank: ageRank,'
    + ' stallRisk: stallRisk, seenPhrase: seenPhrase };})()')();
})();

const today = () => new Date().toISOString().slice(0, 10);
const member = (over) => Object.assign({ slug: 'cert-two', status: 'active', attached: true, wired: '2026-01-04' }, over);
/** Every sentence a card can print for this row. */
const said = (r) => (r ? String(r.reason) : '');

test('finding 154: an empty heartbeat file is an absent heartbeat, not a silent one', () => {
  const { stallRisk } = churn;
  const r = stallRisk(member(), {});
  assert.equal(r.level, 'risk');
  assert.match(said(r), /never checked in/, 'the branch written for this state actually fires');
  assert.doesNotMatch(said(r), /Infinity|NaN/, 'and the sentinel never reaches the card');
});

test('finding 154: a pebble wired today is reassured, not accused', () => {
  const { stallRisk } = churn;
  // The exact state a correct, healthy, freshly stamped pebble is in for its
  // first 90 minutes. `{}` on disk made it read as "never checked in (no
  // heartbeat yet)" AT RISK, which is the product blaming a member for a step
  // the product had not finished.
  for (const hb of [undefined, null, {}]) {
    const r = stallRisk(member({ wired: today() }), hb);
    assert.equal(r.level, 'watch', 'a member 20 minutes old is not at risk');
    assert.match(said(r), /just wired/, 'the grace path fires for ' + JSON.stringify(hb));
  }
});

test('finding 154: no card can render Infinity or NaN where a day count belongs', () => {
  const { stallRisk, seenPhrase } = churn;
  const rows = [
    {},                                            // never reported: the finding
    { auth_ok: true },                             // reported, no timestamp at all
    { generated_at: '', auth_ok: true },           // reported an empty timestamp
    { generated_at: 'not-a-date', auth_ok: true }, // reported a timestamp nothing can parse
    { generated_at: null, skills_installed: 3 },
  ];
  for (const hb of rows) {
    const r = stallRisk(member(), hb);
    assert.doesNotMatch(said(r), /Infinity|NaN|undefined/,
      'stallRisk kept a number out of the sentence for ' + JSON.stringify(hb));
    assert.doesNotMatch(seenPhrase(hb), /Infinity|NaN|undefined/,
      'seenPhrase did too for ' + JSON.stringify(hb));
  }
});

test('finding 154: a heartbeat that arrived without a timestamp says so honestly', () => {
  const { stallRisk } = churn;
  // It DID check in, so "never checked in" would be false, and "silent Nd" is
  // unavailable because there is no N. Name the report as the fault, not the
  // member, and keep it off the at-risk list.
  const r = stallRisk(member(), { auth_ok: true, onboarded: true, skills_installed: 2, skills_enabled: ['x'] });
  assert.equal(r.level, 'watch');
  assert.match(said(r), /no timestamp/, 'the sentence names what is actually missing');
  assert.equal(r.age, 0, 'and carries no age it cannot justify');
});

test('finding 154: a real heartbeat is judged exactly as before', () => {
  const { stallRisk } = churn;
  const at = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const healthy = { generated_at: at(0.1), auth_ok: true, onboarded: true, skills_installed: 2, skills_enabled: ['a', 'b'], skill_runs: { a: at(0.2), b: at(0.3) } };
  assert.equal(stallRisk(member(), healthy).level, 'ok', 'a live box is still ok');
  assert.match(said(stallRisk(member(), Object.assign({}, healthy, { generated_at: at(9) }))), /silent 9d/,
    'a genuinely silent box still gets its real day count');
  assert.match(said(stallRisk(member(), Object.assign({}, healthy, { generated_at: at(4) }))), /quiet 4d/);
  assert.equal(stallRisk(member({ status: 'left' }), {}), null, 'and only active rows are judged');
});

test('finding 154: daysSince has ONE sentinel, so one isFinite guard covers every caller', () => {
  const { daysSince } = churn;
  for (const bad of [undefined, null, '', 'not-a-date', '2026-13-45T99:99:99Z']) {
    assert.equal(daysSince(bad), Infinity, 'no NaN escapes daysSince for ' + JSON.stringify(bad));
  }
  const d = daysSince(new Date(Date.now() - 2 * 86400000).toISOString());
  assert.ok(d > 1.9 && d < 2.1, 'and a real stamp still measures its real age');
});

test('finding 154: the risk sort cannot answer NaN with two never-checked-in rows', () => {
  const { ageRank, stallRisk } = churn;
  const a = stallRisk(member({ slug: 'one' }), {});
  const b = stallRisk(member({ slug: 'two' }), {});
  assert.equal(a.age, Infinity, 'the sentinel is still the sentinel');
  assert.ok(isFinite(ageRank(b) - ageRank(a)), 'Infinity - Infinity never reaches the comparator');
  assert.ok(ageRank(a) > ageRank({ age: 400 }), 'and never checked in still ranks worse than any real age');
  // Structural pin: the comparator has to USE it. The Infinity comes back the
  // moment someone inlines `risk.age` there again.
  const sort = html.slice(html.indexOf('rows.sort(function(a, b){'), html.indexOf('// summary strip'));
  assert.match(sort, /ageRank\(b\.risk\) - ageRank\(a\.risk\)/, 'renderCards sorts through ageRank');
});
