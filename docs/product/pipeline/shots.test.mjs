// The docs/shots contract gate. Zero-dep on purpose: the qa-* browser rigs are
// excluded from the clean-checkout suite (trap 15), so if this contract could
// only be checked by capturing screenshots, CI would never check it and a page
// pointing at a shot nobody takes would ship as a broken image.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SHOTS, SURFACES, WORLDS, WAITS, extractShotRefs, shotIds, shotSrc } from './shots.mjs';
import { SHOT_LINE, SHOT_ANY } from './render.mjs';
import { loadTree } from './source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Both trees are checked: the real pages under pages/, and the fixtures that
// exercise shapes the real tree may not have yet. A gate that only watched the
// fixtures would pass while a shipping page pointed at a shot nobody takes.
const TREES = [path.join(HERE, '..', 'pages'), path.join(HERE, 'test-fixtures')]
  .filter((d) => existsSync(d));
const allPages = () => TREES.flatMap((d) => loadTree(d));

test('every declared shot is capturable: real surface, real world, unique id', () => {
  const seen = new Set();
  for (const s of SHOTS) {
    assert.ok(SURFACES.includes(s.surface), `${s.id}: unknown surface ${s.surface}`);
    assert.ok(WORLDS.includes(s.world), `${s.id}: unknown world ${s.world}`);
    assert.match(s.id, /^[a-z0-9-]+$/, `${s.id}: id must be kebab-case`);
    assert.ok(!seen.has(s.id), `duplicate shot id ${s.id}`);
    seen.add(s.id);
    assert.ok(WAITS.includes(s.waitUntil), `${s.id}: unknown waitUntil ${s.waitUntil}`);
    assert.ok(s.note, `${s.id}: every shot says why it exists, for whoever re-takes it`);
  }
});

// acts and clicks and marks name controls by selector. A control renamed in
// the shell would only be found the day the rig runs (a release step), so the
// #ids are checked here against the surface's own HTML, with no browser: the
// gate fails the day the control is renamed. Attributes (data-x="v") are
// checked as literals when the shell carries them, and as attribute names
// otherwise (member.html sets data-card from a registry at runtime).
const SHELL_OF = { door: 'door.html', member: 'member.html', panel: 'member.html' };
const shellSrc = (surface) => readFileSync(path.join(HERE, '..', '..', '..', 'wizard', 'panel', SHELL_OF[surface]), 'utf8');
function selectorsOf(s) {
  const out = [...s.clicks, ...s.marks.map((m) => m.sel)];
  for (const a of s.acts) if (a.click || a.fill) out.push(a.click || a.fill);
  return out;
}
test('every act is one gesture, well formed', () => {
  for (const s of SHOTS) {
    assert.ok(Array.isArray(s.acts), `${s.id}: acts must be a list`);
    for (const a of s.acts) {
      const kinds = ['click', 'fill', 'wait'].filter((k) => a[k] !== undefined);
      assert.equal(kinds.length, 1, `${s.id}: an act is exactly one of click/fill/wait, got ${JSON.stringify(a)}`);
      if (a.wait !== undefined) assert.ok(Number.isInteger(a.wait) && a.wait > 0, `${s.id}: wait is a positive ms count`);
      if (a.fill !== undefined) assert.ok('value' in a, `${s.id}: fill ${a.fill} needs a value`);
      if (a.click !== undefined) assert.equal(typeof a.click, 'string');
    }
    assert.match(s.query, /^([a-z]+=[a-z0-9-]+(&[a-z]+=[a-z0-9-]+)*)?$/, `${s.id}: query is key=value pairs or empty`);
  }
});

test('every #id a shot clicks, fills or marks exists in its surface shell', () => {
  const bad = [];
  for (const s of SHOTS) {
    const src = shellSrc(s.surface);
    for (const sel of selectorsOf(s)) {
      for (const [, id] of sel.matchAll(/#([A-Za-z_][\w-]*)/g)) {
        if (!src.includes(`id="${id}"`)) bad.push(`${s.id}: #${id} is not in ${SHELL_OF[s.surface]}`);
      }
      for (const [, attr, val] of sel.matchAll(/\[(data-[a-z-]+)="([^"]+)"\]/g)) {
        if (!src.includes(`${attr}="${val}"`) && !src.includes(attr)) bad.push(`${s.id}: [${attr}="${val}"] is not in ${SHELL_OF[s.surface]}`);
      }
    }
  }
  assert.deepEqual(bad, [], 'a shot names a control its surface does not have');
});

test('every shot a page references is declared', () => {
  const declared = new Set(shotIds());
  const missing = [];
  for (const pg of allPages()) {
    for (const id of extractShotRefs(pg.body)) {
      if (!declared.has(id)) missing.push(`${pg.slug} -> shot:${id}`);
    }
  }
  assert.deepEqual(missing, [], 'a page points at a shot the rig does not take');
});

test('a shot directive is always alone on its line', () => {
  const bad = [];
  for (const pg of allPages()) {
    pg.body.split('\n').forEach((line, n) => {
      if (SHOT_ANY.test(line) && !SHOT_LINE.test(line)) bad.push(`${pg.slug}:${n + 1}`);
    });
  }
  assert.deepEqual(bad, [], 'an inline shot cannot render as valid HTML: give it its own line');
});

test('the shot path lives in one place', () => {
  assert.equal(shotSrc('member-overview'), '/docs/shots/member-overview.png');
});

// Orphans are REPORTED, not failed: a shot legitimately lands in a release
// before the page that uses it. A declared-but-unused shot costs one PNG; a
// referenced-but-undeclared shot is a broken image on a customer's screen.
// Only the second is a build breaker.
test('declared-but-unreferenced shots are reported', () => {
  const used = new Set(allPages().flatMap((p) => extractShotRefs(p.body)));
  const orphans = shotIds().filter((id) => !used.has(id));
  if (orphans.length) console.log(`  note: ${orphans.length} shot(s) declared and not yet referenced: ${orphans.join(', ')}`);
  assert.ok(true);
});
