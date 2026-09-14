// nav.test.mjs - the shape of the reading journey and the goal doors, pinned
// without a browser. The gate in gates.test.mjs runs journeyProblems() over
// the real pages; this file pins the rules themselves on synthetic input, so a
// rule that silently stops firing is caught here rather than on the day a
// door names a page that no longer exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JOURNEY, DOORS, journeyGroups, journeyProblems, doorOf } from './nav.mjs';
import { glyphIds, glyph } from './glyphs.mjs';

const page = (slug) => ({ slug, title: slug, summary: '', body: '' });
const allSlugs = () => [...new Set([...JOURNEY.flatMap((g) => g.slugs), ...DOORS.flatMap((d) => d.slugs)])];

test('the journey is eight groups in reader order', () => {
  assert.deepEqual(JOURNEY.map((g) => g.id),
    ['start', 'setup', 'ea', 'app', 'running', 'understand', 'reference', 'legal']);
  for (const g of JOURNEY) {
    assert.ok(g.title && g.blurb, `${g.id} carries a title and a blurb`);
    assert.ok(!g.blurb.includes('—'), `${g.id}: no em dash`);
  }
});

test('the real journey and doors are consistent with each other', () => {
  assert.deepEqual(journeyProblems(allSlugs().map(page)), []);
});

test('every door has a glyph that draws, and at least two pages', () => {
  for (const d of DOORS) {
    assert.ok(glyphIds().includes(d.glyph), `${d.id}: glyph ${d.glyph}`);
    assert.match(glyph(d.glyph), /^<svg class="glyph" aria-hidden="true"/);
    assert.ok(!/#[0-9a-f]{3,6}\b/i.test(glyph(d.glyph)), `${d.id}: a glyph carries no hex colour`);
    assert.ok(d.slugs.length >= 2, `${d.id}: a door is a trail`);
    assert.match(d.title, /^I want /, `${d.id}: doors are phrased as the reader's goal`);
  }
});

test('a page is on at most one door, and doorOf finds it', () => {
  const seen = new Set();
  for (const d of DOORS) for (const s of d.slugs) { assert.ok(!seen.has(s), `${s} on two doors`); seen.add(s); }
  const first = DOORS[0];
  assert.deepEqual(doorOf(first.slugs[1]), { door: first, index: 1 });
  assert.equal(doorOf('no-such-page'), null);
});

test('the rules fire: two doors, a lone page, a missing glyph, an unknown page', () => {
  const pages = allSlugs().map(page);
  const withProblems = (edit) => {
    const backup = DOORS.map((d) => ({ ...d, slugs: [...d.slugs] }));
    try { edit(); return journeyProblems(pages); } finally { DOORS.splice(0, DOORS.length, ...backup); }
  };
  const dup = withProblems(() => { DOORS[1].slugs.push(DOORS[0].slugs[0]); });
  assert.ok(dup.some((p) => /on both door/.test(p)), dup.join('\n'));
  const lone = withProblems(() => { DOORS[0].slugs.splice(1); });
  assert.ok(lone.some((p) => /at least two/.test(p)), lone.join('\n'));
  const noGlyph = withProblems(() => { DOORS[0].glyph = 'unicorn'; });
  assert.ok(noGlyph.some((p) => /glyphs\.mjs does not draw/.test(p)), noGlyph.join('\n'));
  const ghost = withProblems(() => { DOORS[0].slugs.push('ghost-page'); });
  assert.ok(ghost.some((p) => /ghost-page, which is not a public page/.test(p)), ghost.join('\n'));
});

test('an empty group is allowed to exist ahead of its pages, and is not rendered', () => {
  const ea = new Set(JOURNEY.find((g) => g.id === 'ea').slugs);
  const pages = JOURNEY.flatMap((g) => g.slugs).filter((s) => !ea.has(s)).map(page);
  const groups = journeyGroups(pages);
  assert.ok(!groups.some((g) => g.id === 'ea'), 'a group with no pages is dropped from render');
  assert.equal(groups.length, JOURNEY.length - 1);
});
