// cli-pipe.test.mjs: the move-in tools answer IN FULL through a pipe.
//   node --test engine/move-in/cli-pipe.test.mjs
// Found in the adopt rehearsal (T4, 2026-10-18): apply.mjs wrote its answer and
// then called process.exit(), and on a pipe (which is what ssh is) stdout is
// asynchronous, so every answer stopped at exactly 64 KB. A real server's plan
// is about 190 KB, so `show` reached the app cut in half and the Move in page
// said "Could not read the plan from your mineral just now".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { makeBrain, inventory } from './test-fixture.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);

function bigInventory() {
  const inv = inventory();
  // Enough skills that the plan is well past one pipe buffer, the size a real
  // brain reaches on its own (the rehearsal's had 55 skills and 39 jobs).
  for (let i = 0; i < 400; i++) inv.lazy_skills.push(`placeholder-skill-number-${i}`);
  return inv;
}

// Read everything the child writes to a PIPE, the way ssh hands it over, and read
// it SLOWLY: ssh and docker exec drain more slowly than the child writes, so the
// 64 KB pipe fills, the rest of the write is queued, and an exit at that moment
// drops it. A reader that keeps up never sees the bug, which is how it shipped.
function runPiped(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    p.stdout.pause();
    setTimeout(() => p.stdout.resume(), 800);
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('close', (code) => resolve({ code, out: Buffer.concat(chunks).toString('utf8') }));
  });
}

test('show answers a plan bigger than one pipe buffer in full, and it parses', async () => {
  const d = makeBrain(tmpDir('move-in-pipe-'), { inv: bigInventory() });
  const planned = spawnSync(process.execPath, [path.join(HERE, 'plan.mjs'), d], { encoding: 'utf8' });
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);

  const r = await runPiped([path.join(HERE, 'apply.mjs'), d, 'show']);
  assert.equal(r.code, 0);
  assert.ok(r.out.length > 65536, `the answer is ${r.out.length} bytes; the test needs more than one pipe buffer`);
  const m = r.out.match(/MOVEIN_STATE (.*)/);
  assert.ok(m, 'the state line arrived');
  const st = JSON.parse(m[1]);
  assert.equal(st.moving_in, true);
  assert.ok(st.plan && st.plan.steps.length > 0, 'the whole plan came through');
});

test('a failing command still exits non-zero (exitCode, not exit, keeps the status)', async () => {
  const d = makeBrain(tmpDir('move-in-pipe-'));
  const r = await runPiped([path.join(HERE, 'apply.mjs'), d, 'apply', 'no-such-step']);
  assert.notEqual(r.code, 0);
});

// The behaviour above cannot fail on a developer machine: a pipe node spawns
// itself blocks, so nothing is ever lost. The pipe docker exec gives a box is
// non-blocking, and that is where the 64 KB cut happened (measured on the
// rehearsal server: 65536 or 131072 bytes of a 144244-byte answer, varying run to
// run; with the fix, 144244 every time). So also pin the shape: no tool the app
// reads over ssh may exit before its output has drained.
test('the CLIs the app reads over ssh never exit before stdout drains', () => {
  for (const rel of ['apply.mjs', 'plan.mjs']) {
    const src = readFileSync(path.join(HERE, rel), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /process\.exit\(/, `${rel} calls process.exit(); set process.exitCode instead`);
  }
  const scripts = readFileSync(path.join(HERE, '..', 'cron', 'scripts.mjs'), 'utf8');
  assert.match(scripts, /process\.stdout\.write\('', \(\) => process\.exit\(code\)\)/, 'scripts.mjs exits only once stdout has drained');
});
