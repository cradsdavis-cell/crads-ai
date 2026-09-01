// version-chip.test.mjs — run: node --test wizard/panel/version-chip.test.mjs
//
// "Understand where we're up to" (Sam, 2026-08-09): every face carries the
// version chip and both servers answer /whats-new. Structural pins in the
// repo's anti-drift style — the 2026-08-03 no-app-shipped-for-two-days incident
// was exactly a load-bearing string quietly leaving a page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchChangelog, plainRelease, isInternalChange, tidySubject, shortDate } from './updater.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('all three faces carry the version chip and its what\'s-new fold', () => {
  for (const f of ['door.html', 'member.html']) {
    const s = readFileSync(join(HERE, f), 'utf8');
    assert.ok(s.includes("chip.id = 'verChip'"), `${f}: version chip missing`);
    assert.ok(s.includes("fetch('/whats-new')"), `${f}: what's-new fetch missing`);
    assert.ok(s.includes("fetch('/update-status')"), `${f}: update-status poll missing`);
  }
});

// Hover summary (2026-08-13, Sam: "a brief overview of the changes made in this
// release"): the chip must answer without a click. Pinned the same structural
// way as the fold, plus one byte-comparison of the whole fragment: the two
// faces drifting apart is the failure mode a per-string pin cannot see.
test('every face carries the hover summary, and the fragment is identical across faces', () => {
  const frag = (s) => {
    const i = s.indexOf('(function(){\n  // Version chip (2026-08-09');
    assert.ok(i >= 0, 'version-chip fragment not found');
    const j = s.indexOf('\n})();', i);
    return s.slice(i, j);
  };
  const seen = [];
  for (const f of ['door.html', 'member.html']) {
    const s = readFileSync(join(HERE, f), 'utf8');
    assert.ok(s.includes("tip.id = 'verTip'"), `${f}: hover tooltip element missing`);
    assert.ok(s.includes('chip.onmouseenter'), `${f}: hover handler missing`);
    assert.ok(s.includes('chip.onmouseleave'), `${f}: hover-out handler missing`);
    // one shared read: the tooltip must be instant and the fold must not refetch
    assert.ok(s.includes('changelogPending'), `${f}: shared changelog read missing`);
    assert.equal((s.match(/fetch\('\/whats-new'\)/g) || []).length, 1,
      `${f}: /whats-new must be fetched from exactly one place`);
    seen.push(frag(s));
  }
  assert.equal(seen[0], seen[1], 'the version-chip fragment has drifted between faces');
});

test('both servers answer /whats-new', () => {
  for (const f of ['door-server.mjs', 'panel-server.mjs']) {
    const s = readFileSync(join(HERE, f), 'utf8');
    assert.ok(s.includes("path === '/whats-new'"), `${f}: /whats-new route missing`);
    assert.ok(s.includes('fetchChangelog'), `${f}: changelog helper not wired`);
  }
});

test('fetchChangelog: returns entries, caches, and degrades to [] offline', async () => {
  let calls = 0;
  const entries = [{ sha: 'abc1234', date: '2026-08-09', subject: 'a ship' }];
  const okFetch = async () => { calls++; return { ok: true, json: async () => entries }; };
  const first = await fetchChangelog({ fetch: okFetch, ttlMs: 60_000 });
  assert.deepEqual(first, entries);
  const second = await fetchChangelog({ fetch: okFetch, ttlMs: 60_000 });
  assert.deepEqual(second, entries);
  assert.equal(calls, 1, 'second read must come from the cache');
  // a later failure serves the cached list rather than an error
  const third = await fetchChangelog({ fetch: async () => { throw new Error('offline'); }, ttlMs: 0 });
  assert.deepEqual(third, entries, 'offline must degrade to the last-known list');
});

// Plain words (2026-08-13, Sam: "more digestible for a non-crads-ai developer
// audience"). Every subject below is a REAL one from this repo's log, because a
// filter tuned against invented conventional-commit strings would pass its tests
// and still hand a member "baseline: leg E COMPLETE, and finding 82 is why it
// nearly was not".
const REAL_INTERNAL = [
  'baseline: finding 89, a rock\'s Custody card shows another rock\'s backup',
  'baseline loop 2: 73, 74, 75, 76 fixed; 83 resolved',
  'docs: a pasteable prompt to re-run the baseline in a fresh session',
  'design: correct the latency claim with measurements',
  'prompt: GitHub must be connected from the app, and observability is the point',
  'shots: the rockbrain pair walks through Rocks, the network-click pair dies',
  'qa: findings 70-71, and onboarding is automatable after all',
  'vocab: box-sense client becomes pebble',
  'wait-loop: a floor between work-triggered runs, because I shipped a hot loop',
  'scheduler: the box asks the directory for work, with the cron kept as backstop',
  'clean-gate was right again: I baked an org slug into two comments',
  "Merge branch 'rocks-page-redesign' into merge-boot-wait",
  'Merge commit \'ac407f4\' into access-model-on-hl',
  'RETRACT the community-listing false-success finding, with the measurement',
  'two qa files asserted a fix as if it were the bug, and a fixture never reset',
  // The four that reached the chip out of the docs-v2 merge window (2026-08-25).
  // Real subjects, kept verbatim: the filter is only ever as good as the log it
  // was measured against, and these are what the log actually says.
  'spec: the Crads issuer in the device handshake, and why 177\'s fix is wrong',
  'suite: repair the two reds the branch was carrying',
  'suite: the injected clock is the only clock in buildStateMd',
  'stamp: the rock\'s Access warning stops asserting a hole that is not there',
  'evidence: the teardown purge is deployed',
  'docs-pipeline: the annotated-shot test reads a tracked fixture',
];
const REAL_MEMBER_FACING = [
  'a rock showed its assistant\'s name where its organisation should be',
  'the door called everything "Your minerals", including the ones that are not',
  'a rock owner\'s last click went to a dashboard rocks do not have',
  'every rock backed up to the same GitHub repository',
  'door: one mineral inventory, so the screen can answer what it is for',
  'a connected rock was told forever that it had no GitHub',
];

test('the internal half of the log is recognised as internal', () => {
  for (const s of REAL_INTERNAL) assert.equal(isInternalChange(s), true, `should be internal: ${s}`);
});

test('changes a member can actually see survive the filter', () => {
  for (const s of REAL_MEMBER_FACING) assert.equal(isInternalChange(s), false, `should be kept: ${s}`);
});

// A scope being on the internal list must never be the reason a change with
// curated words disappears: `notes:` (and its after-the-fact half,
// docs/member-notes.md) is the seam that always wins, or the filter would be
// able to silence the one person who knows what the change means.
test('a curated note survives however internal its scope reads', () => {
  const { entries, hidden } = plainRelease([
    { subject: 'suite: repair the two reds the branch was carrying', notes: '' },
    { subject: 'spec: the Crads issuer in the device handshake', notes: 'the app no longer asks you to sign in twice' },
  ]);
  assert.equal(hidden, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].plain, 'The app no longer asks you to sign in twice');
  assert.equal(entries[0].curated, true);
});

test('tidySubject opens with a capital and drops internal cross-references', () => {
  assert.equal(
    tidySubject('scheduler: derive the machinery card from the jobs that actually run (finding 86)'),
    'Scheduler: derive the machinery card from the jobs that actually run',
  );
  // the scope prefix STAYS: it tells a member which screen moved
  assert.equal(tidySubject('door: one mineral inventory'), 'Door: one mineral inventory');
  // "door P2:" is internal phase notation; the screen name survives, the phase does not
  assert.equal(tidySubject('door P2: launch into the last-used mineral'),
    'Door: launch into the last-used mineral');
  // an identifier is left alone rather than turned into a typo ("Ssh-bridge:")
  assert.equal(tidySubject('ssh-bridge: self-heal a recycled address'),
    'ssh-bridge: self-heal a recycled address');
  assert.equal(tidySubject(''), '');
  assert.equal(tidySubject(null), '');
});

test('shortDate speaks plainly and passes anything unreadable through', () => {
  assert.equal(shortDate('2026-08-13'), '13 Aug');
  assert.equal(shortDate('2026-01-01'), '1 Jan');
  assert.equal(shortDate('not a date'), 'not a date');
  assert.equal(shortDate(undefined), '');
});

test('plainRelease reports what it filtered instead of swallowing it', () => {
  const out = plainRelease([
    { sha: 'a', date: '2026-08-13', subject: 'a rock showed its assistant\'s name where its organisation should be' },
    { sha: 'b', date: '2026-08-13', subject: 'qa: findings 70-71, and onboarding is automatable after all' },
    { sha: 'c', date: '2026-08-12', subject: 'docs: a pasteable prompt to re-run the baseline' },
  ]);
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].plain, 'A rock showed its assistant\'s name where its organisation should be');
  assert.equal(out.entries[0].when, '13 Aug');
  assert.equal(out.hidden, 2, 'the filtered count must be reported, not dropped');
});

test('plainRelease: an all-plumbing release is empty with a count, not an empty box', () => {
  const out = plainRelease(REAL_INTERNAL.map((subject, i) => ({ sha: String(i), date: '2026-08-13', subject })));
  assert.equal(out.entries.length, 0);
  assert.equal(out.hidden, REAL_INTERNAL.length);
});

test('a curated note wins over the commit subject, and is never filtered out', () => {
  const out = plainRelease([
    // the seam for real member-grade prose: internal subject, curated line
    { sha: 'a', date: '2026-08-13', subject: 'qa: findings 70-71, leg D passing',
      notes: 'your backups now go to your own GitHub, not ours' },
  ]);
  assert.equal(out.entries.length, 1, 'a curated note must survive an internal subject');
  assert.equal(out.entries[0].plain, 'Your backups now go to your own GitHub, not ours');
  assert.equal(out.entries[0].curated, true);
  assert.equal(out.hidden, 0);
});

test('plainRelease survives the junk a published changelog can actually carry', () => {
  for (const bad of [null, undefined, 'not an array', 42, {}]) {
    assert.deepEqual(plainRelease(bad), { entries: [], hidden: 0 }, `bad input: ${JSON.stringify(bad)}`);
  }
  const out = plainRelease([{}, { subject: '   ' }, { subject: null }]);
  assert.equal(out.entries.length, 0);
  assert.equal(out.hidden, 3);
});

test('both servers hand the faces the filtered view, not the raw log', () => {
  for (const f of ['door-server.mjs', 'panel-server.mjs']) {
    const s = readFileSync(join(HERE, f), 'utf8');
    assert.ok(s.includes('plainRelease'), `${f}: /whats-new still serves raw commit subjects`);
  }
  for (const f of ['door.html', 'member.html']) {
    const s = readFileSync(join(HERE, f), 'utf8');
    assert.ok(s.includes('e.plain'), `${f}: renders the raw subject instead of the plain line`);
  }
});
