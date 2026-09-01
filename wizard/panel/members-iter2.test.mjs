// members-iter2.test.mjs — the rock's Members page after panel iteration 2
// (R5 lifecycle states, R6 Forget, R14 Skills fold, R27 naming; 2026-08-23).
//   node --test wizard/panel/members-iter2.test.mjs
//
// The lifecycle function is evaluated out of member.html with the churn-risk
// model it leans on, and exercised with fixture rows for each of the five
// states, the 3-day quiet line and a legacy paused row. The rest pins the
// card anatomy by code shape, never by copied prose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERBS } from './panel-server.mjs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const sec = html.slice(html.indexOf('<section data-sec="pebbles"'), html.indexOf('<section data-sec="decisions"'));
const fleet = html.slice(html.indexOf('function renderFleet(){'), html.indexOf("$('fleetRefresh').onclick"));

const lib = (() => {
  const churnFrom = html.indexOf('// ---- Churn-risk model');
  const churnTo = html.indexOf('// ---- Catalogue');
  const lifeFrom = html.indexOf('// ---- R5 lifecycle');
  const lifeTo = html.indexOf('// The SHAPE of a fleet row');
  assert.ok(churnFrom > 0 && churnTo > churnFrom && lifeFrom > 0 && lifeTo > lifeFrom, 'found both blocks');
  // eslint-disable-next-line no-new-func
  return new Function('return (function(){'
    + 'var document = { createElement: function(){ var a = {}; return { setAttribute: function(k, v){ a[k] = v; }, get attrs(){ return a; } }; } };'
    + 'function cap(s){ s = String(s); return s.charAt(0).toUpperCase() + s.slice(1); }'
    + html.slice(churnFrom, churnTo)
    + html.slice(lifeFrom, lifeTo)
    + 'return { memberLifecycle: memberLifecycle, stallRisk: stallRisk, tierLabel: tierLabel, stateChip: stateChip };})()')();
})();

const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
const live = (days) => ({ generated_at: ago(days), auth_ok: true, onboarded: true, shared: { skill_engagement: true, activity: true },
  skills_installed: 1, skills_enabled: ['a'], skill_ok_runs: { a: ago(0.1) } });
const judge = (m, hb) => lib.memberLifecycle(m, hb, lib.stallRisk(m, hb));

test('R5: each of the five states, from fixture rows', () => {
  assert.equal(judge({ status: 'invited' }, null).state, 'invited');
  assert.equal(judge({ status: 'active', attached: '2026-08-20', wired: '' }, null).state, 'setting-up', 'wiring = setting up');
  assert.equal(judge({ status: 'active' }, null).state, 'setting-up', 'never checked in = setting up, not quiet');
  assert.equal(judge({ status: 'active' }, {}).state, 'setting-up', 'an empty heartbeat file is the same absence');
  assert.equal(judge({ status: 'active' }, Object.assign(live(0.2), { auth_ok: false, onboarded: false })).state, 'setting-up', 'never signed in = setting up');
  assert.equal(judge({ status: 'active' }, live(0.5)).state, 'active');
  assert.equal(judge({ status: 'active' }, live(4)).state, 'quiet');
  const ended = judge({ status: 'left', left_how: 'evicted' }, null);
  assert.equal(ended.state, 'ended'); assert.equal(ended.how, 'evicted');
  assert.equal(judge({ status: 'left', decommissioned: '2026-08-19', left_how: 'torn-down' }, null).how, 'torn down', 'decommissioned reads torn down');
  assert.equal(judge({ status: 'left', left_how: 'transferred' }, null).how, 'transferred');
  assert.equal(judge({ status: 'left' }, null).how, 'left', 'a row from before exit records defaults to left');
});

test('R5: quiet is drawn at 3 days, and silence outranks whatever the last report said', () => {
  assert.equal(judge({ status: 'active' }, live(2.9)).state, 'active');
  assert.equal(judge({ status: 'active' }, live(3.1)).state, 'quiet');
  assert.equal(judge({ status: 'active' }, live(30)).state, 'quiet');
  // an old report saying "never signed in" is quiet, not setting up
  assert.equal(judge({ status: 'active' }, Object.assign(live(10), { auth_ok: false, onboarded: false })).state, 'quiet');
  // a report with no usable timestamp cannot be judged quiet
  assert.equal(judge({ status: 'active' }, Object.assign(live(0), { generated_at: 'garbage' })).state, 'active');
});

test('R5: a legacy paused row renders as active (or quiet), flagged for the Bring back fold', () => {
  const p = judge({ status: 'paused' }, live(0.5));
  assert.equal(p.state, 'active'); assert.equal(p.legacyPaused, true);
  assert.equal(judge({ status: 'paused' }, live(5)).state, 'quiet', 'an old heartbeat is still quiet');
  assert.equal(judge({ status: 'active' }, live(0.5)).legacyPaused, false);
  assert.ok(!html.includes('Frozen by the pause we retired'), 'paused is no longer a status sentence');
  assert.match(fleet, /if \(m\.status === 'paused'\) \{[\s\S]*?twoClickBtn\('Bring back'/, 'the card keeps the Bring back control');
});

test('R5: the strip, the sections and the chip all read the one function', () => {
  assert.match(fleet, /life: memberLifecycle\(m, hb, risk\)/, 'every row is judged once');
  assert.match(fleet, /function bucketOf\(x\)\{ return x\.life\.state; \}/, 'buckets are the states');
  for (const w of ["'invited'", "'setting up'", "'quiet'", "'ended'"]) assert.ok(fleet.includes(`sumCell(`) && fleet.includes(w), `strip cell ${w}`);
  assert.match(fleet, /function sumCell\(n, word, cls\)\{ return n \? /, 'zero cells are omitted');
  assert.match(fleet, /<b>' \+ buckets\.active\.length \+ '<\/b>active/, 'except active, which always shows');
  assert.ok(!fleet.includes('</b>waiting on them') && !fleet.includes("fleetSection('Running')") && !fleet.includes('</b>gone quiet'), 'the old strip words are gone');
  for (const label of ["fleetSection('Quiet')", "fleetSection('Setting up')", "fleetSection('Invited')", "fleetSection('Active')", "fleetSection('Ended')"]) {
    assert.ok(fleet.includes(label), label);
  }
  assert.match(fleet, /d\.setAttribute\('data-state', x\.life\.state\);/, 'the card carries its state');
  assert.match(fleet, /d\.querySelector\('\.fcstate'\)\.appendChild\(stateChip\(x\.life\.state\)\);/, 'and draws the chip from it');
  const chip = lib.stateChip('setting-up');
  assert.equal(chip.className, 'chip st-setting-up');
  assert.equal(chip.textContent, 'Setting up', 'sentence case');
});

test('R27: heading = live name; second line = person · slug (mono) · host · tier; nothing forced uppercase', () => {
  assert.match(fleet, /var fcNames = fleetNames\(m, y\);/, 'the one naming helper');
  assert.match(fleet, /fcSub\.push\('<span class="mono">' \+ esc\(m\.slug \|\| '\?'\) \+ '<\/span>'\);/, 'slug in mono');
  assert.match(fleet, /if \(m\.host\) fcSub\.push\('<span class="mono">' \+ esc\(m\.host\) \+ '<\/span>'\);/, 'host in mono');
  assert.match(fleet, /fcSub\.push\(esc\(tierLabel\(m\)\)\);/, 'tier last');
  assert.equal(lib.tierLabel({ attached: '2026-08-01' }), 'anchored');
  assert.equal(lib.tierLabel({}), 'anchored');
  assert.equal(lib.tierLabel(null, { tie: 'joined' }), 'joined');
  assert.equal(lib.tierLabel(null, { tie: 'joined', tier: 'rock' }), 'joined rock');
  assert.equal(lib.tierLabel(null, { tie: 'anchored' }), 'anchored');
  assert.match(fleet, /<span class="fcdisc" aria-hidden="true">' \+ esc\(fcInitial\)/, 'the disc keeps the initial');
  // no uppercase on the card: the card-scoped rules, and the iteration-2 overrides
  const cardCss = html.match(/\n  \.fleet-card[^\n]*/g) || [];
  for (const rule of cardCss) assert.ok(!rule.includes('text-transform:uppercase'), rule.trim());
  assert.match(html, /\.fleet-card \.fcid \.sub\{font-family:var\(--sans\)[^}]*text-transform:none/, 'the sub line is sans, not shouted');
  assert.match(html, /\.fleet-erow \.ehow\{[^}]*text-transform:none/, 'nor the ended how-word');
});

test('R6: Forget sits on ended rows only, names the person, says the row is archived, and calls member-forget', () => {
  const ended = fleet.slice(fleet.indexOf('function buildEndedRow('), fleet.indexOf('function fleetSection('));
  assert.match(ended, /twoClickBtn\('Forget', 'Press again: forget ' \+ names\.heading \+ ', their row is archived'/, 'the second press is the are-you-sure');
  assert.match(ended, /run\('member-forget', \{ slug: m\.slug \}/, 'wired to the verb');
  assert.match(ended, /loadFleetHealth\(\); \}\)/, 'then the fleet reloads');
  const card = fleet.slice(fleet.indexOf('function buildMemberCard('), fleet.indexOf('function buildTieCard('));
  assert.ok(!card.includes('Forget'), 'a live card never offers Forget');
  assert.ok(!fleet.slice(fleet.indexOf('function buildTieCard('), fleet.indexOf('function buildEndedRow(')).includes('Forget'), 'nor a tie card');
  assert.ok(VERBS['member-forget'] && VERBS['member-forget'].adminOnly && VERBS['member-forget'].mutating, 'the verb is admin + mutating');
  const cmd = VERBS['member-forget'].build({ slug: 'ravi' }).command;
  assert.match(cmd, /\[ "\$st" = left \] \|\|/, 'and refuses unless the row has ended');
  assert.match(cmd, /registry\/archive\/ravi\.\$d\.yaml/, 'archives, never deletes');
  assert.match(ended, /d\.setAttribute\('data-state', 'ended'\)/, 'ended rows carry their state too');
});

test('R14: every non-ended card has a Skills fold listing the library with the member’s state and an offer toggle', () => {
  assert.match(fleet, /if \(orgx\.role !== 'support' && m\.status !== 'left'\) \{\s*flows\.push\(\{ key: 'skills', label: 'Skills', build: function\(\)\{ return memberSkillsFold\(m, y\); \} \}\);/, 'the fold is on every non-ended card for Admin (D2: Support gets no action row)');
  const fold = html.slice(html.indexOf('function memberSkillsFold('), html.indexOf('function openTransferFlow('));
  assert.match(fold, /CAT\.items\.forEach\(function\(it\)\{/, 'every library skill');
  assert.match(fold, /var st = catMemberState\(it\.id, m\.slug\);/, 'the same three-state reading as the Catalogue');
  assert.match(fold, /line\.setAttribute\('data-skill', it\.id\)/, 'one line per skill');
  assert.match(fold, /catToggle\(on, /, 'with an offer toggle');
  assert.match(fold, /admin && !busy\[it\.id\]/, 'Admin only can flip it');
  // the inline confirm, in the ruled words
  assert.match(fold, /'Offer \/' \+ it\.id \+ ' to ' \+ names\.heading \+ '\?'/, 'offer question');
  assert.match(fold, /'Withdraw the offer of \/' \+ it\.id \+ ' from ' \+ names\.heading \+ '\? What they installed stays\.'/, 'withdraw question');
  assert.ok(!/\bconfirm\(/.test(fold) && !/\bprompt\(/.test(fold), 'no native dialogs');
  // it publishes through the Catalogue's one writer, immediately
  assert.match(fold, /catWritePolicy\(patch, function\(l\)\{ logTo\(log, l\); \}\)/, 'same full-policy write + reconcile');
  assert.match(fold, /else if \(res\.hits\.length\) \{ hits\[id\] = res\.hits; \}/, 'a scrub refusal shows its hits');
  assert.match(fold, /err\.className = 'caterr'/, 'in the same error block as the Catalogue');
  // from 'all', withdrawing one member is the explicit list minus them
  assert.match(fold, /var list = cur === 'all' \? catMembers\(\)\.map\(function\(x\)\{ return x\.slug; \}\)/, 'withdraw from all = everyone else');
  assert.match(fold, /loadCatalogue\(\)\.then\(paint/, 'the library is loaded here too if the Catalogue never was');
  assert.match(html, /if \(!CAT\.loaded && !CAT\.loading\) loadCatalogue\(\);/, 'and prefetched with the fleet');
});

test('the page head has a bubble and one-line sub-copy; no em dashes; no forced uppercase in the section', () => {
  assert.match(sec, /<h2>Members<button class="info"[^>]*data-tip="[^"]{40,}"/, 'explainer bubble on the heading');
  assert.match(sec, /<p>Who is in your community, and where each one is\.<\/p>/, 'one line');
  assert.ok(!sec.includes('ranked by who needs attention first'), 'the old line is gone');
  assert.ok(!sec.includes('your community catalogue only'), 'R4: joined members no longer promised a community catalogue');
  // code only: the pre-existing explanatory comments are not rewritten here
  const code = fleet.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/[—]/.test(sec) && !/[—]/.test(code), 'zero em dashes in anything rendered');
});
