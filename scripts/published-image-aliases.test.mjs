// Pins trap 31: a vocabulary pass must not rename a PUBLISHED package name.
//
// The 2026-08-10 rock/pebble pass renamed `ai-os-parent` to `ai-os-rock` across the
// tree. `ai-os-parent` is not our vocabulary, it is a published GHCR package and a
// live compatibility surface: boxes and older provisioning pull it by that name, and
// promote.yml walks the list by name. The rename would have made promote.yml push a
// tag for a package that does not exist, and no test could see it, because the names
// live in HCL and workflow YAML rather than in JS.
//
// This test PARSES both files rather than keeping a third copy of the list (trap 28).
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

// The canonical names and the legacy aliases they must keep publishing alongside.
const PAIRS = [
  ['crads-pebble', 'ai-os-member'],
  ['crads-rock', 'ai-os-parent'],
];

test('docker-bake publishes every canonical image under its legacy alias too', () => {
  const bake = read('docker-bake.hcl');
  for (const [canonical, legacy] of PAIRS) {
    const line = bake
      .split('\n')
      .find((l) => l.includes('tags') && l.includes(canonical));
    assert.ok(line, `docker-bake.hcl no longer tags ${canonical}`);
    assert.ok(
      line.includes(legacy),
      `${canonical} lost its published legacy alias ${legacy}; boxes and older ` +
        `provisioning still pull that name, so dropping it breaks them silently`,
    );
  }
});

test('promote walks the legacy alias names, which must still exist', () => {
  const promote = read('.github/workflows/promote.yml');
  for (const [, legacy] of PAIRS) {
    assert.ok(
      promote.includes(legacy),
      `promote.yml no longer promotes ${legacy}`,
    );
  }
  // The bake file is what actually publishes them. If promote names an image the
  // bake file never tags, the promote silently pushes a tag for nothing.
  const bake = read('docker-bake.hcl');
  const promoted = (promote.match(/for img in ([^\n]+); do/) || [, ''])[1]
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const img of promoted) {
    assert.ok(
      bake.includes(img),
      `promote.yml promotes "${img}" but docker-bake.hcl never tags it`,
    );
  }
});
