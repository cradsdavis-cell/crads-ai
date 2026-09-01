// engine/kernel/lib/runner-org-publish.test.mjs — runner dispatches org-publish like the packs.
// Run: node --test engine/kernel/lib/runner-org-publish.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runSkill } from './runner.mjs';
import { tmpDir } from '../../../tests/tmp-dir.mjs';

test('org-publish without config is a clean no-op through the runner', async () => {
  const state = tmpDir('obrun-');
  const r = await runSkill(state, { skill: 'org-publish', id: 'x', args: {} }, { dryRun: true });
  assert.equal(r.ok, true);
  assert.match(r.output, /not configured/);
});
