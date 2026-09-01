// box-cockpit-graph.test.mjs — the brain graph must contain EVERY page in the wiki
// and EVERY link a person could reasonably write. Run: node --test engine/cockpit/
//
// Why this file exists (2026-07-30). The graph is the member's picture of their own
// brain, so a page or a link missing from it reads as work that was never done. Two
// silent losses lived here, neither of which any test would have caught:
//
//   1. Link resolution was CASE-SENSITIVE while Obsidian's is not, so every
//      capitalised wikilink in a brain ([[Harriet]] against harriet.md) produced no edge.
//   2. The basename map let the LAST page walked win, so with people/notes.md and
//      projects/notes.md present, every bare [[notes]] pointed at whichever the
//      directory walk happened to reach second.
//
// Both are the kind of fault that renders as a plausible-looking graph, which is
// exactly why they need assertions rather than eyeballing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILDER = join(HERE, 'box-cockpit.mjs');

function buildBrain(files) {
  const box = tmpDir('cc-graph-');
  for (const [rel, body] of Object.entries(files)) {
    const p = join(box, 'wiki', rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  execFileSync(process.execPath, [BUILDER, box], { encoding: 'utf8' });
  const data = JSON.parse(readFileSync(join(box, 'cockpit', 'data.json'), 'utf8'));
  const edge = (a, b) => data.graph.links.find((l) =>
    (l.source === a && l.target === b) || (l.source === b && l.target === a));
  return { data, g: data.graph, edge, ids: data.graph.nodes.map((n) => n.id).sort() };
}

test('every .md page in the wiki becomes a node, at any depth', () => {
  const { ids } = buildBrain({
    'index.md': '# Index\n',
    'people/harriet.md': '# Harriet\n',
    'projects/deep/nested/thing.md': '# Thing\n',
    'concepts/three-day-week.md': '# Three Day Week\n',
  });
  assert.deepEqual(ids, ['concepts/three-day-week', 'index', 'people/harriet', 'projects/deep/nested/thing']);
});

test('a capitalised wikilink resolves, the way Obsidian resolves it', () => {
  const { edge, g } = buildBrain({
    'index.md': '# Index\n\n[[Harriet]] and [[HARRIET]] and [[Three-Day-Week]].\n',
    'people/harriet.md': '# Harriet\n',
    'concepts/three-day-week.md': '# Three Day Week\n',
  });
  const a = edge('index', 'people/harriet');
  assert.ok(a, 'a capitalised [[Harriet]] must link to harriet.md');
  assert.equal(a.w, 2, 'both [[Harriet]] and [[HARRIET]] count');
  assert.ok(edge('index', 'concepts/three-day-week'), 'mixed-case with hyphens resolves');
  assert.equal(g.links.length, 2);
});

test('an ambiguous basename resolves deterministically, not by walk order', () => {
  const files = {
    'index.md': '# Index\n\n[[notes]]\n',
    'people/notes.md': '# People notes\n',
    'projects/notes.md': '# Project notes\n',
  };
  const first = buildBrain(files);
  const second = buildBrain(files);
  assert.ok(first.edge('index', 'people/notes'), 'shallowest-then-alphabetical wins: people before projects');
  assert.ok(!first.edge('index', 'projects/notes'));
  assert.deepEqual(first.g.links, second.g.links, 'the same brain must always produce the same graph');
});

test('a path-qualified link is never ambiguous, in any case', () => {
  const { edge } = buildBrain({
    'index.md': '# Index\n\n[[projects/notes]] and [[people/notes]] and [[Projects/Notes]].\n',
    'people/notes.md': '# People notes\n',
    'projects/notes.md': '# Project notes\n',
  });
  assert.equal(edge('index', 'projects/notes').w, 2, 'the qualified form matches on path, mixed case included');
  assert.equal(edge('index', 'people/notes').w, 1);
});

test('every link form a person writes is counted, and each pair is one weighted edge', () => {
  const { edge, g } = buildBrain({
    // plain, aliased, heading-anchored, embedded, an .md suffix, and a typed relation
    'index.md': '# Index\n\n[[harriet]] [[harriet|Harriet R]] [[harriet#history]] ![[harriet]] [[harriet.md]]\n',
    'people/harriet.md': '# Harriet\n\n- works-with :: [[retreat]]\nAlso [[retreat]] again.\n',
    'projects/retreat.md': '# Retreat\n',
  });
  assert.equal(edge('index', 'people/harriet').w, 5, 'all five forms of the same link count');
  const typed = edge('people/harriet', 'projects/retreat');
  assert.equal(typed.rel, 'works-with', 'the typed relation is kept');
  assert.equal(typed.w, 2);
  assert.equal(g.links.length, 2, 'undirected and de-duplicated: one edge per pair');
});

test('a link to a page that does not exist adds no phantom node', () => {
  const { ids, g } = buildBrain({ 'index.md': '# Index\n\n[[ghost-page]] [[harriet]]\n', 'people/harriet.md': '# Harriet\n' });
  assert.deepEqual(ids, ['index', 'people/harriet'], 'no node is invented for a broken link');
  assert.equal(g.links.length, 1);
});

test('a self-link is not an edge, and node degree matches the edges drawn', () => {
  const { g, data } = buildBrain({
    'index.md': '# Index\n\n[[index]] [[harriet]]\n',
    'people/harriet.md': '# Harriet\n\n[[index]]\n',
  });
  assert.equal(g.links.length, 1, 'a page linking itself draws nothing');
  for (const n of g.nodes) {
    const real = g.links.filter((l) => l.source === n.id || l.target === n.id).length;
    assert.equal(n.deg, real, `${n.id} degree must match its edges (the viewer sizes nodes by it)`);
  }
  assert.equal(data.brain.pages, 2);
});

// The empty picture has two causes and they are not the same news (2026-08-10).
// walk() returns quietly on a wiki root that is not there, so a box looking in
// the WRONG PLACE produced the identical "No pages yet" as a box with a genuinely
// empty brain. Sam hit it on a rock born hours before org mode shipped: the Files
// tree listed the pages while the graph beside it insisted there were none.
test('a wiki root that is not there is reported, not passed off as an empty brain', () => {
  const box = tmpDir('cc-noroot-');
  execFileSync(process.execPath, [BUILDER, box], { encoding: 'utf8' });
  const data = JSON.parse(readFileSync(join(box, 'cockpit', 'data.json'), 'utf8'));
  assert.equal(data.graph.nodes.length, 0, 'nothing to draw, as before');
  assert.equal(data.brain.root_missing, true, 'but the panel can now say WHY it is empty');
  assert.match(data.brain.root, /wiki$/, 'and name the place it looked');
});

test('a brain with pages never claims its root is missing', () => {
  const { data } = buildBrain({ 'index.md': '# Index\n' });
  assert.equal(data.brain.root_missing, false);
  assert.match(data.brain.root, /wiki$/);
});

test('an empty-but-present wiki is an empty brain, not a lost root', () => {
  const box = tmpDir('cc-emptywiki-');
  mkdirSync(join(box, 'wiki'), { recursive: true });
  execFileSync(process.execPath, [BUILDER, box], { encoding: 'utf8' });
  const data = JSON.parse(readFileSync(join(box, 'cockpit', 'data.json'), 'utf8'));
  assert.equal(data.graph.nodes.length, 0);
  assert.equal(data.brain.root_missing, false, 'the honest "no pages yet" case survives');
});
