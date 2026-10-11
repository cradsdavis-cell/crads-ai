// engine/team/path-guard.test.mjs: the Slack turn reads the brain copy and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'path-guard.mjs');
const run = (root, payload) => spawnSync(process.execPath, [GUARD, root], { input: typeof payload === 'string' ? payload : JSON.stringify(payload) }).status;

test('inside the copy is allowed; anything outside, by path, glob, .. or symlink, is refused', () => {
  const state = tmpDir('guard-');
  const work = path.join(state, '.kernel', 'slack-work');
  mkdirSync(path.join(work, 'company'), { recursive: true });
  writeFileSync(path.join(work, 'company', 'policies.md'), 'x');
  mkdirSync(path.join(state, 'secrets', 'team'), { recursive: true });
  writeFileSync(path.join(state, 'secrets', 'team', 'brain'), 'PRIVATE KEY');
  symlinkSync(path.join(state, 'secrets'), path.join(work, 'sneaky'));
  const ok = (input, tool = 'Read') => run(work, { tool_name: tool, tool_input: input, cwd: work });
  assert.equal(ok({ file_path: path.join(work, 'company', 'policies.md') }), 0);
  assert.equal(ok({ file_path: 'company/policies.md' }), 0);
  assert.equal(ok({ pattern: '**/*.md' }, 'Glob'), 0);
  assert.equal(ok({ pattern: '/etc/.*', path: 'company' }, 'Grep'), 0, 'a Grep pattern is a regex, not a path');
  assert.equal(ok({ file_path: path.join(state, 'secrets', 'team', 'brain') }), 2);
  assert.equal(ok({ file_path: '../../secrets/team/brain' }), 2);
  assert.equal(ok({ pattern: '/state/**' }, 'Glob'), 2);
  assert.equal(ok({ path: '/' }, 'Grep'), 2);
  assert.equal(ok({ file_path: 'sneaky/team/brain' }), 2, 'a symlink inside the copy that points out is refused');
  assert.equal(run(work, 'not json'), 2, 'fails closed');
});
