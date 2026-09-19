// Run: node --test engine/box/opencode-seed.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), 'opencode-seed.sh');
const seed = (root, template) => execFileSync('bash', [SEED, root], { env: { ...process.env, OPENCODE_PLUGIN_TEMPLATE: template }, encoding: 'utf8' });

function template() {
  const t = tmpDir('oc-tpl-');
  mkdirSync(path.join(t, 'config', 'opencode', 'skills', 'gsd-x'), { recursive: true });
  mkdirSync(path.join(t, 'cache', 'opencode', 'packages'), { recursive: true });
  writeFileSync(path.join(t, 'config', 'opencode', 'opencode.json'), '{"permission":{"read":{"/state/.opencode-auth/config/opencode/gsd-core/*":"allow"}}}');
  writeFileSync(path.join(t, 'config', 'opencode', 'skills', 'gsd-x', 'SKILL.md'), 'see /state/.opencode-auth/config/opencode/gsd-core/ref.md');
  writeFileSync(path.join(t, 'cache', 'opencode', 'packages', 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
  return t;
}

test('seeds config + cache, rewrites the baked path for a mineral mounted elsewhere, leaves binaries alone', () => {
  const t = template(); const box = tmpDir('oc-box-'); const root = path.join(box, '.opencode-auth');
  seed(root, t);
  const cfg = readFileSync(path.join(root, 'config', 'opencode', 'opencode.json'), 'utf8');
  assert.ok(cfg.includes(`${root}/config/opencode/gsd-core/*`) && !cfg.includes('/state/.opencode-auth'));
  assert.ok(readFileSync(path.join(root, 'config', 'opencode', 'skills', 'gsd-x', 'SKILL.md'), 'utf8').includes(`${root}/config`));
  assert.deepEqual([...readFileSync(path.join(root, 'cache', 'opencode', 'packages', 'blob.bin'))], [0, 1, 2, 0, 255, 0]);
});

test('never seeds the sign-in or the headless config: unattended turns must find headless EMPTY', () => {
  const t = template(); const box = tmpDir('oc-box2-'); const root = path.join(box, '.opencode-auth');
  seed(root, t);
  assert.ok(!existsSync(path.join(root, 'data')));
  assert.ok(!existsSync(path.join(root, 'headless')));
});

test('idempotent: a second run does not clobber what the member changed; no template is a quiet no-op', () => {
  const t = template(); const box = tmpDir('oc-box3-'); const root = path.join(box, '.opencode-auth');
  seed(root, t);
  const mine = path.join(root, 'config', 'opencode', 'opencode.json'); writeFileSync(mine, '{"mine":true}');
  seed(root, t);
  assert.equal(readFileSync(mine, 'utf8'), '{"mine":true}');
  const bare = path.join(tmpDir('oc-box4-'), '.opencode-auth');
  seed(bare, path.join(t, 'does-not-exist'));
  assert.ok(!existsSync(bare));
});
