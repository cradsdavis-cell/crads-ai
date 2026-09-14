// The reference-drift gate. Regenerates every reference page in memory and
// compares it to what is on disk: a skill renamed, a connector added, a
// machinery job re-noted, and this test goes red until the generator is re-run.
// That is the mechanism behind "the docs change when the app changes"; without
// it, generation is a one-off convenience that rots like anything else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, skills, machinery } from './generate.mjs';
import { parseFrontmatter, validatePage } from './source.mjs';
import { CATALOGUE } from '../../../wizard/panel/mcp-catalogue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'pages', 'reference');

test('generated reference pages are in sync with the code', () => {
  const stale = [];
  for (const p of generate()) {
    const dest = path.join(OUT, p.file);
    if (!existsSync(dest)) { stale.push(`${p.file} (missing)`); continue; }
    if (readFileSync(dest, 'utf8') !== p.content) stale.push(p.file);
  }
  assert.deepEqual(stale, [],
    'reference pages are out of date. Run: node docs/product/pipeline/generate.mjs');
});

test('every generated page satisfies the page contract and is marked generated', () => {
  for (const p of generate()) {
    const { fm, body } = parseFrontmatter(p.content, p.file);
    const page = validatePage(fm, p.file);
    assert.equal(page.mode, 'reference', `${p.file}: generated pages are reference mode`);
    assert.equal(page.generated, true, `${p.file}: must carry generated: true`);
    assert.ok(body.includes('Do not edit by hand'),
      `${p.file}: must tell a reader not to hand-edit it`);
  }
});

test('no em dash reaches generated copy', () => {
  for (const p of generate()) {
    assert.ok(!p.content.includes('—'), `${p.file}: em dash in generated copy`);
  }
});

// pages/reference/ also holds hand-written reference (the glossary, starter
// recipes, 2026-09-10). The line is not the directory but the claim: a page
// that says generated: true must come out of the generator, and a page the
// generator makes must not be silently replaced by a hand-written one.
test('nothing hand-written in pages/reference/ claims to be generated', () => {
  if (!existsSync(OUT)) return;
  const expected = new Set(generate().map((p) => p.file));
  const found = readdirSync(OUT).filter((f) => f.endsWith('.md'));
  const liars = found.filter((f) => {
    if (expected.has(f)) return false;
    const { fm } = parseFrontmatter(readFileSync(path.join(OUT, f), 'utf8'), f);
    return String(fm.generated) === 'true';
  });
  assert.deepEqual(liars, [],
    'a hand-written page in pages/reference/ carries generated: true; drop the flag or move it to the generator');
});

// The extractors are the fragile half: each reads a shape another file owns.
// Pin what they must find, so a source that moves fails HERE with a readable
// message rather than silently generating a thinner page.
test('the skills extractor reads every engine skill, cleanly', () => {
  const rows = skills();
  assert.ok(rows.length >= 10, `expected at least 10 engine skills, got ${rows.length}`);
  for (const s of rows) {
    assert.match(s.name, /^[a-z][a-z-]*$/, `bad skill name ${s.name}`);
    assert.ok(s.title && !s.title.includes('#'),
      `${s.name}: title carries an inline comment, so the extractor is broken`);
    assert.ok(s.description.length > 20, `${s.name}: description looks unread`);
    assert.ok(!/^["']/.test(s.title), `${s.name}: title still quoted`);
  }
});

test('the machinery slice reads the scheduler DISPLAY table', () => {
  const rows = machinery();
  assert.ok(rows.length >= 15, `expected the full DISPLAY table, got ${rows.length}`);
  const ids = rows.map((r) => r.id);
  for (const must of ['heartbeat', 'backup', 'auto-update', 'custody-watch']) {
    assert.ok(ids.includes(must), `DISPLAY slice missed ${must}`);
  }
  for (const r of rows) assert.ok(r.note.length > 10, `${r.id}: note looks unread`);
});

test('the connections catalogue is read whole, featured entries marked', () => {
  const page = generate().find((p) => p.file === 'connections.md');
  assert.ok(CATALOGUE.length >= 40, `catalogue looks truncated: ${CATALOGUE.length}`);
  // every service in the catalogue appears on the page
  const missing = CATALOGUE.filter((c) => !page.content.includes(`**${c.label}**`)).map((c) => c.label);
  assert.deepEqual(missing, [], 'catalogue entries missing from the generated page');
  assert.ok(page.content.includes('Featured'), 'featured connectors are distinguished');
});
