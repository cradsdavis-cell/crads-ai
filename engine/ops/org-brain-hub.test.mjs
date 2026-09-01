// engine/ops/org-brain-hub.test.mjs — deterministic hub merge, digest, staleness, manifest.
// Run: node --test engine/ops/org-brain-hub.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { synthesize } from './org-brain-hub.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

function seedClone() {
  const clone = tmpDir('obhub-');
  for (const [slug, price] of [['alice', '$500'], ['bob', '$700']]) {
    const m = path.join(clone, 'members', slug);
    mkdirSync(path.join(m, 'entities'), { recursive: true });
    writeFileSync(path.join(m, 'updates.md'),
      `# Updates from ${slug}\n\n## 2026-07-25\n- worked on acme\n\nsource: ${slug}/wiki/log.md · 2026-07-25\n`);
    writeFileSync(path.join(m, 'entities', 'acme.md'),
      `# ACME\nQuoted ${price}.\n\nsource: ${slug}/wiki/projects/acme.md · 2026-07-25\n`);
    writeFileSync(path.join(m, 'decisions.md'), `- [2026-07-24] chose weekly cadence\n`);
  }
  writeFileSync(path.join(clone, 'members', 'alice', '.stamp'), new Date().toISOString() + '\n');
  writeFileSync(path.join(clone, 'members', 'bob', '.stamp'), '2026-07-01T00:00:00.000Z\n');
  return clone;
}

test('synthesize merges entities with per-member sections (contradictions co-present)', () => {
  const clone = seedClone();
  const r = synthesize(clone);
  const acme = readFileSync(path.join(clone, 'entities', 'acme.md'), 'utf8');
  assert.match(acme, /## from alice/);
  assert.match(acme, /## from bob/);
  assert.match(acme, /\$500/);
  assert.match(acme, /\$700/);
  assert.match(acme, /source: alice\/wiki\/projects\/acme\.md/);
  assert.equal(r.entities, 1);
});

test('synthesize writes digest with staleness flags and manifest with stamps', () => {
  const clone = seedClone();
  const r = synthesize(clone);
  const digest = readFileSync(r.digestPath, 'utf8');
  assert.match(digest, /## alice/);
  assert.match(digest, /worked on acme/);
  assert.match(digest, /## Staleness/);
  assert.match(digest, /bob/);
  assert.deepEqual(r.stale, ['bob']);
  const manifest = readFileSync(path.join(clone, '.org', 'manifest.yaml'), 'utf8');
  assert.match(manifest, /alice:/);
  assert.match(manifest, /bob: "2026-07-01T00:00:00\.000Z"/);
});

test('synthesize merges decisions with attribution and exact-line dedupe across runs', () => {
  const clone = seedClone();
  synthesize(clone);
  synthesize(clone);   // idempotent second run
  const log = readFileSync(path.join(clone, 'decisions', 'log.md'), 'utf8');
  const hits = log.split('\n').filter((l) => l.includes('chose weekly cadence'));
  assert.equal(hits.length, 2);   // one per member, attributed, not duplicated by the re-run
  assert.match(log, /\(alice\)/);
  assert.match(log, /\(bob\)/);
});

test('synthesize treats malformed stamps as stale (fails toward stale)', () => {
  const clone = tmpDir('obhub-');
  const m = path.join(clone, 'members', 'charlie');
  mkdirSync(path.join(m, 'entities'), { recursive: true });
  writeFileSync(path.join(m, 'updates.md'), '# Updates\n\n## today\n- worked\n');
  writeFileSync(path.join(m, 'decisions.md'), '- [2026-07-24] decide\n');
  writeFileSync(path.join(m, '.stamp'), 'garbage-not-a-date\n');
  const r = synthesize(clone);
  assert.deepEqual(r.stale, ['charlie']);
  const digest = readFileSync(r.digestPath, 'utf8');
  assert.match(digest, /charlie: last publish garbage-not-a-date/);
});

test('synthesize prunes stale entity files when sources disappear', () => {
  const clone = seedClone();
  synthesize(clone);
  assert(existsSync(path.join(clone, 'entities', 'acme.md')));
  // delete member entity sources
  unlinkSync(path.join(clone, 'members', 'alice', 'entities', 'acme.md'));
  unlinkSync(path.join(clone, 'members', 'bob', 'entities', 'acme.md'));
  // re-synthesize
  synthesize(clone);
  // acme.md should be gone (no members have it anymore)
  assert(!existsSync(path.join(clone, 'entities', 'acme.md')));
});
