// The capability ladder (spec 2026-08-17): one card that says what a mineral
// can DO right now. The contract under test: every value comes from the SAME
// resolver its gate runs, every fact is tri-state (true / false / unread), and
// unread locks nothing — ignorance never blocks, and never promises either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERBS } from './panel-server.mjs';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');

// real connLive, copied contract: strict wants state === 'ok'
const connLive = (d, re, strict) => (d.connections || []).some(
  (c) => re.test(c.name) && (strict ? c.state === 'ok' : (c.state === 'ok' || c.state === 'configured')));

/** Build ladderModel with the page's own pebbleGate in scope, globals injected. */
function modelWith(env) {
  const pg = html.match(/function pebbleGate\(d\)\{[\s\S]*?\n {2}\}/);
  const lm = html.match(/function ladderModel\(d\)\{[\s\S]*?\n {2}\}/);
  assert.ok(pg, 'pebbleGate moved or changed shape');
  assert.ok(lm, 'ladderModel moved or changed shape');
  const f = new Function(
    'state', 'IS_ORG', 'connLive', 'CLAUDE_SIGNIN_RE', 'SIGNIN_OPENER', 'cadenceTaskSet',
    'factoryArmed', 'factoryNeedsGh', 'factoryCanAsk', 'factoryGapNames',
    `${pg[0]}; ${lm[0]}; return ladderModel;`);
  return f(
    env.state || { strength: {} }, !!env.IS_ORG, connLive, /claude (account|sign)/i, 'claude',
    env.cadenceTaskSet || (() => false),
    env.factoryArmed !== undefined ? env.factoryArmed : null,
    !!env.factoryNeedsGh, !!env.factoryCanAsk, env.factoryGapNames || '');
}

const signedIn = { connections: [{ name: 'Claude account on the box', state: 'ok' }], onboarding: { phase: 'done' } };

test('rock, fresh door-born: sign-in is the current rung and the locked rows name it', () => {
  const m = modelWith({
    IS_ORG: true,
    state: { strength: { registered: true } },
    factoryArmed: false, factoryNeedsGh: true,
  })({ connections: [], onboarding: { phase: 'discovery' } });
  assert.equal(m.rungs.length, 4);
  assert.equal(m.rungs[0].done, true, 'registered');
  assert.equal(m.rungs[1].done, false, 'claude sign-in pending');
  assert.match(m.rungs[1].why, /signs in your laptop, not this mineral/, 'the laptop-vs-mineral correction rides the rung');
  assert.equal(m.rungs[1].act.to, 'terminal', 'the way in is the Terminal tab, never the desktop-app guide');
  assert.equal(m.rungs[1].act.run, 'claude');
  const sched = m.caps.find((c) => c.name === 'Run scheduled tasks');
  assert.equal(sched.st, 'dim');
  assert.match(sched.why, /nobody at the keyboard/);
  const build = m.caps.find((c) => c.name === 'Build pebbles');
  assert.equal(build.st, 'dim');
  assert.match(build.why, /not onboarded/, 'the why is pebbleGate’s OWN missing line, not a re-derivation');
  const joins = m.caps.find((c) => c.name === 'Accept joining members');
  assert.equal(joins.st, 'ok', 'joined accepts only need registration');
});

test('rock, everything unread: no rung is false, nothing dims, nothing promises', () => {
  const m = modelWith({ IS_ORG: true, state: { strength: {} }, factoryArmed: null })({});
  for (const r of m.rungs) assert.equal(r.done, null, `${r.name} must be unread, not asserted`);
  for (const c of m.caps) {
    assert.notEqual(c.st, 'dim', `${c.name}: ignorance must not lock`);
    if (c.st !== 'ok') assert.equal(c.pill, 'Checking\u2026', `${c.name}: unread says Crads-AI is checking (and the 60s poll makes it true)`);
  }
});

test('rock, fully armed: build row is open only because pebbleGate says ready', () => {
  const m = modelWith({
    IS_ORG: true,
    state: { strength: { registered: true, listed: true, published: true } },
    factoryArmed: true,
  })(signedIn);
  assert.ok(m.rungs.every((r) => r.done === true), 'all four rungs land');
  const build = m.caps.find((c) => c.name === 'Build pebbles');
  assert.equal(build.st, 'ok');
  const listed = m.caps.find((c) => c.name === 'List publicly');
  assert.equal(listed.pill, 'Listed', 'a listed rock says so, not just "Ready"');
});

test('ladderModel reads pebbleGate for the build row — same resolver, never re-derived', () => {
  const lm = html.match(/function ladderModel\(d\)\{[\s\S]*?\n {2}\}/)[0];
  assert.match(lm, /pebbleGate\(d\)/, 'the build row must ask the one gate every other surface asks');
  assert.match(lm, /g\.missing\.filter/, 'and surface ITS missing lines (filtered only of ignorance-asserted ones)');
  assert.match(lm, /CLAUDE_SIGNIN_RE/, 'sign-in reads the shared marker regex');
});

test('pebble: backup rung distinguishes connected-but-never-pushed, and promotion waits on it', () => {
  const m = modelWith({
    state: { strength: { backup: false, backupConnected: true, anchored: true } },
  })(signedIn);
  assert.equal(m.rungs.length, 3);
  assert.equal(m.rungs[2].done, false);
  assert.match(m.rungs[2].why, /first push has not landed/, 'connected alone is not a copy');
  const promote = m.caps.find((c) => c.name === 'Become a rock');
  assert.equal(promote.st, 'dim');
  assert.match(promote.why, /verified backup/);
  assert.match(promote.why, /org brain/, 'promotion names its cost');
});

test('pebble: what the rock controls renders as the rock’s call, never as broken here', () => {
  const m = modelWith({
    state: { strength: { backup: true, anchored: true, ties: 1 } },
  })(signedIn);
  const shared = m.caps.find((c) => /shared pages/.test(c.name));
  assert.equal(shared.st, '', 'no green pill claiming the rock’s toggle on its behalf');
  assert.equal(shared.pill, 'Rock’s call');
  const joined = m.caps.find((c) => c.name === 'Joined a rock');
  assert.equal(joined.pill, 'Anchored', 'the tie badge distinguishes anchored from joined');
});

test('pebble, tie state unread: install-from-rock is unread, not locked', () => {
  const m = modelWith({ state: { strength: {} } })(signedIn);
  const install = m.caps.find((c) => /Install skills/.test(c.name));
  assert.notEqual(install.st, 'dim');
  assert.equal(install.pill, 'Checking\u2026');
});

test('the ladder card leads the work grid: after onboarding, before the strip tiles, both faces', () => {
  const onboarding = html.indexOf("{ id: 'onboarding'");
  const ladder = html.indexOf("{ id: 'ladder'");
  const brain = html.indexOf("{ id: 'brain'");
  assert.ok(onboarding > -1 && ladder > -1 && brain > -1);
  assert.ok(onboarding < ladder && ladder < brain, 'R5: declaration order is the grid, and the ladder leads the work rows');
  const card = html.slice(ladder, brain);
  assert.match(card, /faces: \['member', 'org'\]/);
});

test('card footer buttons can carry data-run and data-focus (the Terminal sign-in needs it)', () => {
  const fn = html.match(/function renderCards\(\)\{[\s\S]*?cardacts[\s\S]*?\.join\(''\)/);
  assert.ok(fn, 'renderCards cardacts block moved');
  assert.match(fn[0], /data-run/, 'a footer action that types a command must be possible');
  assert.match(fn[0], /data-focus/);
});

test('ORG_REG rides org-backup-status, read from the file the machinery reads', () => {
  const c = VERBS['org-backup-status'].build().command;
  assert.match(c, /ORG_PULL_TOKEN/, 'registration truth = the token broker-register writes');
  assert.match(c, /ORG_REG /, 'emitted as its own line for the ladder’s rung 1');
  assert.ok(c.indexOf('ORG_BACKUP ') < c.indexOf('ORG_REG '), 'backup line first: old parsers keep working');
});

test('strengthSync treats a missing ORG_REG line as unread, never false', () => {
  const sync = html.match(/function strengthSync\(\)\{[\s\S]*?\n {2}\}/);
  assert.ok(sync, 'strengthSync moved or changed shape');
  assert.match(sync[0], /delete state\.strength\.registered/, 'both the forget path and the absent-line path must unset, not assert');
  assert.match(sync[0], /ORG_REG /);
});

test('member, cadence unread: Run scheduled tasks checks, never claims "Ready · Set one"', () => {
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
