// One fleet, one arithmetic, every surface (audit 2026-08-25). The hero said
// "9 pebbles" (raw index rows, left seats and all), the Members tile said "6"
// (seats only, ties still in flight) with a lifecycle line summing to 8
// (paused folded into running, quiet counted twice), and Your rock said
// "anchors 8 · 1 joined" (the oracle, fully loaded). tie-counts.mjs was
// already the one true arithmetic; these tests pin that every consumer now
// actually uses it, waits for the whole snapshot, and buckets people
// disjointly so the sub-line sums to the headline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'member.html'), 'utf8');

function countsWith(orgx, stallRisk) {
  const lc = html.match(/function lifecycleCounts\(\)\{[\s\S]*?\n {2}\}/);
  const ll = html.match(/function lifecycleLine\(lc, wiring, joined\)\{[\s\S]*?\n {2}\}/);
  assert.ok(lc, 'lifecycleCounts moved or changed shape');
  assert.ok(ll, 'lifecycleLine moved or changed shape');
  const f = new Function('orgx', 'stallRisk', `${lc[0]}; ${ll[0]}; return { lifecycleCounts, lifecycleLine };`);
  return f(orgx, stallRisk);
}

const VERDICTS = {
  runner: { level: 'ok', phase: 'live' },
  quiet: { level: 'risk', phase: 'live' },
  wiring: { level: 'watch', phase: 'setup' },
  fresh: { level: 'watch', phase: 'waiting' },
};

test('buckets are disjoint and sum to the countable members', () => {
  const index = [
    { slug: 'a', status: 'active' },   // running
    { slug: 'b', status: 'active' },   // gone quiet (risk) - NOT also running
    { slug: 'c', status: 'active' },   // setup
    { slug: 'd', status: 'active' },   // waiting (never checked in)
    { slug: 'e', status: 'invited' },  // waiting
    { slug: 'f', status: 'paused' },   // named, counted in nothing
    { slug: 'g', status: 'left' },     // invisible
    { slug: 'h', status: 'active' },   // no verdict at all - still a member
  ];
  const verdictOf = { a: VERDICTS.runner, b: VERDICTS.quiet, c: VERDICTS.wiring, d: VERDICTS.fresh, h: null };
  const { lifecycleCounts, lifecycleLine } = countsWith(
    { index, hbs: {} }, (m) => verdictOf[m.slug]);
  const c = lifecycleCounts();
  assert.deepEqual(c, { setup: 1, waiting: 2, running: 2, stopped: 1 });
  // countable members in the index = exactly the statuses the oracle's seat
  // half counts (active + invited): 6. A billing-neutral seat is in no bucket
  // here either; its fleet card still draws it by presence (R5), and the word
  // for its state never reaches this line.
  assert.equal(c.setup + c.waiting + c.running + c.stopped, 6,
    'the sub-line must sum to the headline it sits under');
  const line = lifecycleLine(c, 2, 1);
  assert.match(line, /3 setting up/, 'wiring ties join the setup bucket');
  assert.match(line, /1 gone quiet/);
  assert.match(line, /2 running/, 'the quiet one is not also counted running');
  assert.match(line, /1 joined/);
  assert.doesNotMatch(line, /paused/i, 'the legacy state never reaches the tile (R5)');
});

test('the hero counts through the oracle, not raw index rows', () => {
  const hero = html.match(/function renderHero\(\)\{[\s\S]*?\n {2}\}/);
  assert.ok(hero, 'renderHero moved or changed shape');
  assert.match(hero[0], /orgCounts\(\)/, 'the hero asks the oracle');
  assert.ok(!/orgx\.index\.length/.test(hero[0]),
    'raw index length counts left and paused seats and misses ties');
  assert.match(hero[0], /orgx\.indexLoaded && orgx\.tiesLoaded/,
    'and says nothing until both halves of the snapshot have landed');
  assert.match(hero[0], /' member'/, 'the count noun is members (2026-08-17 ruling)');
});

test('the Members tile waits for the whole snapshot, and re-renders when it lands', () => {
  const tile = html.slice(html.indexOf("id: 'pebbles', title: 'Members'"), html.indexOf("id: 'waiting'"));
  assert.match(tile, /orgx\.indexLoaded && orgx\.tiesLoaded/, 'no number before both halves');
  assert.match(tile, /Counting the fleet/, 'the unknown state says what it is doing');
  // the arrivals must repaint the cards, or the honest blank never resolves
  const fleetLand = html.slice(html.indexOf('orgx.indexLoaded = r.ok'), html.indexOf('orgx.indexLoaded = r.ok') + 400);
  assert.match(fleetLand, /renderCards\(\)/, 'index arrival repaints the cards');
  const tiesLand = html.slice(html.indexOf("orgx.tiesUnreadable = '';"), html.indexOf("orgx.tiesUnreadable = '';") + 300);
  assert.match(tiesLand, /renderCards\(\)/, 'ties arrival repaints the cards');
  assert.match(html, /orgx\.tiesLoaded = true/, 'ties arrival is recorded as a fact the gates can read');
});
