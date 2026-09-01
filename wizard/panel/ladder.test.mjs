// The capability ladder (spec 2026-08-17): one card that says what a mineral
// can DO right now. The contract under test: every value comes from the SAME
// resolver its gate runs, every fact is tri-state (true / false / unread), and
// unread locks nothing — ignorance never blocks, and never promises either.
// The face collapse (2026-09-01) collapsed the two ladders into one: three
// rungs (Claude sign-in, onboarding, first backup) and a commons-era
// capability list; the rock rungs, the build gate and the directory-fed
// truths (ORG_REG, ties, listing) are retired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');

// real connLive, copied contract: strict wants state === 'ok'
const connLive = (d, re, strict) => (d.connections || []).some(
  (c) => re.test(c.name) && (strict ? c.state === 'ok' : (c.state === 'ok' || c.state === 'configured')));

/** Build ladderModel with its one-face globals injected. */
function modelWith(env) {
  const lm = html.match(/function ladderModel\(d\)\{[\s\S]*?\n {2}\}/);
  assert.ok(lm, 'ladderModel moved or changed shape');
  const f = new Function(
    'state', 'connLive', 'CLAUDE_SIGNIN_RE', 'SIGNIN_OPENER', 'cadenceTaskSet',
    `${lm[0]}; return ladderModel;`);
  return f(
    env.state || { strength: {} }, connLive, /claude (account|sign)/i, 'claude',
    env.cadenceTaskSet || (() => false));
}

const signedIn = { connections: [{ name: 'Claude account on the box', state: 'ok' }], onboarding: { phase: 'done' } };

test('fresh mineral: sign-in is the pending rung and the locked rows name it', () => {
  const m = modelWith({ state: { strength: { communities: 0 } } })(
    { connections: [], onboarding: { phase: 'discovery' } });
  assert.equal(m.rungs.length, 3, 'three rungs: sign-in, onboard, backup');
  assert.equal(m.rungs[0].done, false, 'claude sign-in pending');
  assert.match(m.rungs[0].why, /signs in your laptop, not this mineral/, 'the laptop-vs-mineral correction rides the rung');
  assert.equal(m.rungs[0].act.to, 'terminal', 'the way in is the Terminal tab, never the desktop-app guide');
  assert.equal(m.rungs[0].act.run, 'claude');
  const sched = m.caps.find((c) => c.name === 'Run scheduled tasks');
  assert.equal(sched.st, 'dim');
  assert.match(sched.why, /nobody at the keyboard/);
  const install = m.caps.find((c) => /Install skills/.test(c.name));
  assert.equal(install.st, 'dim', 'no community read as zero: offers cannot exist yet');
  assert.match(install.why, /once you join a community/);
});

test('everything unread: no rung is false, nothing dims, nothing promises', () => {
  const m = modelWith({ state: { strength: {} }, cadenceTaskSet: () => null })({});
  for (const r of m.rungs) assert.equal(r.done, null, `${r.name} must be unread, not asserted`);
  for (const c of m.caps) {
    assert.notEqual(c.st, 'dim', `${c.name}: ignorance must not lock`);
    if (c.st !== 'ok') assert.equal(c.pill, 'Checking…', `${c.name}: unread says the app is checking (and the 60s poll makes it true)`);
  }
});

test('fully landed: three rungs done, the community rows read the real count', () => {
  const m = modelWith({
    state: { strength: { backup: true, communities: 2 } },
    cadenceTaskSet: () => true,
  })(signedIn);
  assert.ok(m.rungs.every((r) => r.done === true), 'all three rungs land');
  const joined = m.caps.find((c) => c.name === 'Joined a community');
  assert.equal(joined.pill, '2 joined', 'the joined row says how many, not just "Ready"');
  const install = m.caps.find((c) => /Install skills/.test(c.name));
  assert.equal(install.st, 'ok', 'offers are installable once a community exists');
  assert.equal(m.caps.find((c) => c.name === 'Run scheduled tasks').pill, 'In use');
});

test('ladderModel reads the shared resolvers, and the retired gate stays gone', () => {
  const lm = html.match(/function ladderModel\(d\)\{[\s\S]*?\n {2}\}/)[0];
  assert.match(lm, /CLAUDE_SIGNIN_RE/, 'sign-in reads the shared marker regex');
  assert.match(lm, /cadenceTaskSet\(\)/, 'schedules read the one cadence resolver');
  assert.ok(!lm.includes('pebbleGate'), 'the build gate is retired: no row asks it');
  assert.ok(!html.includes('function pebbleGate('), 'and the resolver itself stays gone');
});

test('backup rung distinguishes connected-but-never-pushed; promotion is retired', () => {
  const m = modelWith({
    state: { strength: { backup: false, backupConnected: true } },
  })(signedIn);
  assert.equal(m.rungs.length, 3);
  assert.equal(m.rungs[2].done, false);
  assert.match(m.rungs[2].why, /first push has not landed/, 'connected alone is not a copy');
  // "Become a rock" died with the directory: hosting a community is a row any
  // mineral has, not a promotion to ask for.
  assert.equal(m.caps.find((c) => c.name === 'Become a rock'), undefined, 'no promotion row');
  const host = m.caps.find((c) => c.name === 'Host a community');
  assert.equal(host.st, 'ok', 'hosting is open to every mineral');
  assert.deepEqual(host.act, { label: 'Open the Commons card', to: 'publish', focus: 'commonsCard' });
});

test('community count unread: install-from-community is unread, not locked', () => {
  const m = modelWith({ state: { strength: {} } })(signedIn);
  const install = m.caps.find((c) => /Install skills/.test(c.name));
  assert.notEqual(install.st, 'dim');
  assert.equal(install.pill, 'Checking…');
});

test('the ladder card leads the work grid: after onboarding, before the strip tiles', () => {
  const onboarding = html.indexOf("{ id: 'onboarding'");
  const ladder = html.indexOf("{ id: 'ladder'");
  const brain = html.indexOf("{ id: 'brain'");
  assert.ok(onboarding > -1 && ladder > -1 && brain > -1);
  assert.ok(onboarding < ladder && ladder < brain, 'R5: declaration order is the grid, and the ladder leads the work rows');
  const card = html.slice(ladder, brain);
  assert.ok(!card.includes('faces:'), 'no face declaration: one ladder for every mineral');
  assert.match(card, /title: 'What your mineral can do'/);
});

test('card footer buttons can carry data-run and data-focus (the Terminal sign-in needs it)', () => {
  const fn = html.match(/function renderCards\(\)\{[\s\S]*?cardacts[\s\S]*?\.join\(''\)/);
  assert.ok(fn, 'renderCards cardacts block moved');
  assert.match(fn[0], /data-run/, 'a footer action that types a command must be possible');
  assert.match(fn[0], /data-focus/);
});

test('the ORG_REG rung plumbing is RETIRED (2026-09-01): no directory answers it', () => {
  // Registration with Crads-AI was rung 1 of the rock ladder, read off the
  // org-backup-status verb. Nothing central registers a mineral any more, so
  // no surface may resurrect the claim.
  assert.ok(!html.includes('ORG_REG '), 'strengthSync no longer parses a registration line');
  assert.ok(!html.includes('sx.registered'), 'and the ladder never reads one');
});

test('cadence unread: Run scheduled tasks checks, never claims "Ready · Set one"', () => {
  // The false claim photographed in docs audit round two (2026-08-24): first
  // paint landed before machinerySync's cadence-list round trip, and the row
  // told a mineral with six armed schedules to go set one.
  const unread = modelWith({ cadenceTaskSet: () => null })(signedIn);
  const cap = unread.caps.find((c) => c.name === 'Run scheduled tasks');
  assert.equal(cap.pill, 'Checking…', 'unread cadence is unread, not "Ready"');
  assert.notEqual(cap.st, 'dim', 'and ignorance must not lock');

  const none = modelWith({ cadenceTaskSet: () => false })(signedIn);
  const ready = none.caps.find((c) => c.name === 'Run scheduled tasks');
  assert.equal(ready.pill, 'Ready', 'a READ empty cadence still invites');
  assert.equal(ready.act.to, 'skills');

  const set = modelWith({ cadenceTaskSet: () => true })(signedIn);
  assert.equal(set.caps.find((c) => c.name === 'Run scheduled tasks').pill, 'In use');
});

test('cadenceTaskSet is tri-state: no jobs key = unread, never false', () => {
  const fn = html.match(/function cadenceTaskSet\(\)\{[\s\S]*?\n {2}\}/);
  assert.ok(fn, 'cadenceTaskSet moved or changed shape');
  const f = (cadence) => new Function('state', `${fn[0]}; return cadenceTaskSet();`)({ cadence });
  assert.equal(f({}), null, 'state.cadence starts {}: not read yet is not a no');
  assert.equal(f({ version: 2, jobs: {} }), false, 'read and empty is a real no');
  assert.equal(f({ version: 2, jobs: { inbox: { enabled: true } } }), true);
  assert.equal(f({ version: 2, jobs: { inbox: { enabled: false } } }), false, 'a disabled entry does not count');
});
