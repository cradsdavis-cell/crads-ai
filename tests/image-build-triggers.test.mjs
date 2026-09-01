// image-build-triggers.test.mjs — run: node --test tests/image-build-triggers.test.mjs
//
// What is allowed to cost 13 minutes of CI. On 2026-08-09 this repo burned 141
// Actions minutes across 13 image builds in a day and hit the private-repo
// limit, which blocked every deploy for hours. Several of those builds were
// test-only pushes: test files live beside the code they test (engine/**) and
// never enter the image.
//
// The second assertion is the one that matters more. engine/skills/*.md IS
// product content — it is how a skill like /connect reaches a box — so an
// innocent-looking '!**/*.md' would silently stop every skill change from ever
// being delivered, and nothing would fail loudly enough to notice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const yml = readFileSync(new URL('../.github/workflows/docker-publish.yml', import.meta.url), 'utf8');
const patterns = yml.slice(yml.indexOf('    paths:'), yml.indexOf('permissions:'))
  .split('\n').filter((l) => /^\s+- /.test(l))
  .map((l) => l.replace(/^\s+- /, '').replace(/\s+#.*$/, '').replace(/^'|'$/g, ''));

test('test files do not trigger an image build', () => {
  assert.ok(patterns.includes('!**/*.test.mjs'), 'test-only pushes must not cost a 13 minute build');
  assert.equal(patterns[patterns.length - 1], '!**/*.test.mjs',
    'GitHub evaluates these in order, so a negation placed before a positive pattern does nothing');
});

test('markdown is NOT excluded, because skills ship as markdown', () => {
  const bad = patterns.filter((p) => p.startsWith('!') && /\.md$/.test(p));
  assert.deepEqual(bad, [], 'engine/skills/*.md is product content; excluding it would stop skill delivery silently');
  // and prove the premise rather than asserting it from memory
  assert.ok(existsSync(new URL('../engine/skills/connect.md', import.meta.url)),
    'a skill really does live as markdown under a path the image build watches');
});

test('the paths that DO ship still trigger a build', () => {
  for (const p of ['engine/**', 'provisioning/**', 'Dockerfile.member']) {
    assert.ok(patterns.includes(p), `${p} must still rebuild the image`);
  }
});
