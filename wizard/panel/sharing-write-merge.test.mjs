// sharing-write-merge.test.mjs — R10 (panel iteration 2, 2026-08-23): saving
// the Sharing page must not turn the public brain off.
//
// sharing.json has two writers. The Sharing page posts the toggles it renders
// (activity, skill_engagement) through `sharing-write`; engine/ops/brain-public.mjs
// writes `public_brain` into the SAME file, and the scheduler's half-hourly
// brain-public-push reads that key as its gate. The verb used to `mv` the
// posted object over the file, so any save from the page dropped the key and
// the public brain stopped pushing without anyone being told.
//   node --test wizard/panel/sharing-write-merge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MEMBER_VERBS } from './panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

// run the built command against a temp cockpit dir instead of /state/cockpit
function write(dir, obj) {
  const spec = MEMBER_VERBS['sharing-write'].build({ content_b64: Buffer.from(JSON.stringify(obj)).toString('base64') });
  const cmd = spec.command.replaceAll('/state/cockpit', dir);
  return execFileSync('bash', ['-c', cmd], { input: spec.stdin, encoding: 'utf8' });
}
const read = (dir) => JSON.parse(readFileSync(join(dir, 'sharing.json'), 'utf8'));

test('an existing public_brain: true survives a save of the page toggles', () => {
  const dir = join(tmpDir('shw-'), 'cockpit');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sharing.json'), JSON.stringify({ public_brain: true, activity: true }, null, 2) + '\n');
  const out = write(dir, { activity: false });
  assert.match(out, /OK: sharing saved/);
  const after = read(dir);
  assert.equal(after.public_brain, true, 'the key the page never posts must not be dropped');
  assert.equal(after.activity, false, 'the posted key wins');
});

test('posted keys overwrite their old values and new keys are added', () => {
  const dir = join(tmpDir('shw-'), 'cockpit');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sharing.json'), JSON.stringify({ public_brain: false, skill_engagement: false }) + '\n');
  write(dir, { skill_engagement: true, activity: false });
  assert.deepEqual(read(dir), { public_brain: false, skill_engagement: true, activity: false });
});

test('a missing or corrupt file is treated as empty, not as a reason to refuse', () => {
  const dir = join(tmpDir('shw-'), 'cockpit');
  write(dir, { activity: false });
  assert.deepEqual(read(dir), { activity: false });
  writeFileSync(join(dir, 'sharing.json'), 'not json\n');
  write(dir, { activity: true });
  assert.deepEqual(read(dir), { activity: true });
});

test('a non-object payload is still refused and the file is left alone', () => {
  const dir = join(tmpDir('shw-'), 'cockpit');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sharing.json'), JSON.stringify({ public_brain: true }) + '\n');
  assert.throws(() => write(dir, [1, 2]), /nothing saved/);
  assert.deepEqual(read(dir), { public_brain: true });
  assert.ok(existsSync(join(dir, 'sharing.json')));
});
