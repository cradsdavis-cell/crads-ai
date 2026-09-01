// cadence-v2.test.mjs — the Cadence page rebuild (spec 2026-08-04 § 4/§ 6.2):
// the widened cadence-list round trip and the member.html editor contract.
//   node --test wizard/panel/cadence-v2.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MEMBER_VERBS } from './panel-server.mjs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

test('cadence-list carries the full inventory and the scheduler plan in one round trip', () => {
  const cmd = MEMBER_VERBS['cadence-list'].build().command;
  for (const marker of ['__SKILLS__', '__CADENCE__', '__RUNS__', '__AUTOUPDATE__', '__HEARTBEAT__', '__ALLSKILLS__', '__PLANJSON__']) {
    assert.ok(cmd.includes(`echo "${marker}"`), `${marker} section present`);
  }
  assert.ok(cmd.indexOf('__HEARTBEAT__') < cmd.indexOf('__ALLSKILLS__'),
    'new sections append after the legacy ones so older readers still parse');
  assert.match(cmd, /skills-list\.mjs \/state/, 'inventory comes from the unit-tested engine enumerator');
  assert.match(cmd, /scheduler\.mjs \/state --plan-json/, 'machinery rows come from the scheduler itself');
  assert.match(cmd, /--plan-json 2>\/dev\/null \|\| echo "\{\}"/, 'older images degrade to {} not a shell error');
});

test('the client normalizes v1 and v2 cadence files with the same rules as cadence-lib', () => {
  assert.match(html, /function normCadClient\(raw\)/, 'client-side normalizer exists');
  assert.match(html, /raw\.version === 2 && raw\.jobs/, 'v2 shape detected');
  assert.match(html, /e\.when === 'weekly'.*days: \['mon'\]/, 'v1 weekly stays Monday — nothing silently moves');
  assert.match(html, /migrated_profile_cadence === true/, 'the fold-in flag survives an app save');
});

test('the editor offers all three schedule kinds and the guardrails', () => {
  assert.match(html, /on days, at times/, 'kind: times');
  assert.match(html, /every few hours/, 'kind: every');
  assert.match(html, /every few days/, 'kind: every-days');
  assert.match(html, /daychip/, 'day-of-week chips');
  assert.match(html, /\+ time/, 'multiple times per day');
  assert.match(html, /mins\.min = 30/, 'the 30-minute interval floor is in the UI too');
  assert.match(html, /Pause overnight \(quiet hours\)/, 'quiet-hours opt-out is explicit');
  assert.match(html, /anchor = todayYmd\(\)/, 'every-days anchors to the day it was set');
  assert.match(html, /Send me the result/, 'deliver toggle');
});

// R6 (2026-08-09 audit): the machinery block moved to the Health card on
// Overview; same data, same honesty carve-outs, rendered by the card now.
test('machinery renders from the scheduler plan on the Health card, honesty carve-outs intact', () => {
  const fn = html.split('function machineryRows()')[1].split('function machineryHtml()')[0];
  assert.match(fn, /state\.planJson && state\.planJson\.machinery/, 'plan-json is the source when present');
  assert.match(fn, /see Backup/, 'backup still defers to the real check until the run ledger lands');
  // 060dd83: unread heartbeat copy became "Checking…" and the claim was made
  // true (the page re-polls). The carve-out to pin is structural: the chip may
  // not claim 'on' until a real emit exists.
  assert.match(fn, /ok = !!state\.heartbeatAt/, 'heartbeat chip can still be false');
  assert.match(fn, /Older image/, 'static fallback survives for pre-P2 boxes');
  assert.match(fn, /if \(!state\.machineryLoaded\) return \[\];/, 'nothing fetched yet says nothing, not a stale trio');
  assert.match(html, /\+ machineryHtml\(mach, sick\); \} \},/, 'the Health card renders the rows');
  assert.match(html, /if \(now - machineryAt < 120000\) return;/, 'the Overview fetch is throttled: cadence-list is an SSH round-trip');
});

test('stale scheduled entries surface instead of being silently dropped', () => {
  assert.match(html, /no longer installed/, 'a cadence entry whose skill vanished stays visible and disableable');
});

test('the Skills page chip and the Cadence page agree via the shared describeCad', () => {
  assert.match(html, /function describeCad\(entry\)/);
  const chip = html.split('function cadChip(id)')[1].split('}')[0] + '}';
  assert.match(chip, /describeCad\(normCadClient/, 'cadChip reads through the same normalizer');
});

// ---------------------------------------------------------------- health card copy
// Sam, 2026-08-14: "the health card needs to be more human readable. It's too
// technical." Three things were engineering vocabulary leaking to the member:
// the raw status token as the headline, a raw timestamp, and kebab job ids as
// row labels. Pinned so a revert is loud.
test('the health card speaks in plain words, not box vocabulary', () => {
  const block = html.split("{ id: 'health', title: 'Health', faces: ['member', 'org'],")[1]
    .split("{ id: 'skills'")[0];
  // the headline is a phrase, never the box's own token
  assert.match(block, /'All good'/, 'healthy headline');
  assert.match(block, /'Not working right now'/, 'error headline is a sentence, not ERROR/DOWN');
  assert.match(block, /'Mostly working'/, 'degraded headline is a sentence, not the word degraded');
  assert.match(block, /'Not sure yet'/, 'an absent token reads as unknown-to-us, not "unknown"');
  assert.doesNotMatch(block, /esc\(headTok \|\| 'unknown'\)/, 'the raw token is no longer the headline');
  // relative time, exact time on hover
  assert.match(block, /var seen = ago\(d\.generated_at\);/, 'checked-at is relative');
  assert.match(block, /title="' \+ esc\(\(d\.generated_at/, 'the exact timestamp survives on hover');
  // "All good" may not sit above a failed row without saying so
  assert.match(block, /var sick = mach\.filter/, 'the headline reads the machinery outcomes too');
  // R19a (2026-08-23): the sentence became the fold's summary line, "N of M
  // need a look", rendered by machineryHtml from the same sick count.
  assert.match(html, /' of ' \+ n \+ ' need' \+ \(sick === 1 \? 's' : ''\) \+ ' a look/, 'a healthy box with a failed job says so in the summary line');
});

test('machinery rows carry human labels, never raw job ids', () => {
  assert.match(html, /function machineryLabel\(id\)\{/, 'one label map for both id shapes');
  assert.match(html, /'heartbeat': 'Status check-in'/, 'heartbeat is not a word a member needs');
  assert.match(html, /'auto-update': 'Software updates'/, 'kebab ids are mapped');
  assert.match(html, /esc\(machineryLabel\(m\.id\)\)/, 'the row renders through the map');
  assert.doesNotMatch(html, /OPTED OUT via cockpit\/auto-update\.json/, 'no config file paths in member copy');
});
