// box-up-parity.test.mjs — the promoted rock keeps its owner's personal seat
// (promote ruling § 1, 2026-08-04), pinned structurally.
//
// Under BROKERED promotion the box never changes image or entrypoint: promotion
// flips /state/ownership.json to tier 'rock' and everything org-side arrives as
// data (registry, org-policy, org brain) operated over ssh by the panel, with
// rock MACHINERY running operator-side. That means the personal seat survives
// promotion exactly as long as box-up.sh stays INDIFFERENT to the tier — the
// morning ruling's hazard ("boot-rock never starts the cadence scheduler, the
// dashboard or the brain commit loop") only existed for the image-swap shape
// that brokering removed. These pins make the two halves of that argument
// break loudly if a future edit bends either one.
//   node --test engine/box-up-parity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'box-up.sh'), 'utf8');

// executable text only: whole-line comments and trailing comments stripped
const EXEC = SRC.split('\n')
  .map((l) => l.replace(/(^|\s)#.*$/, ''))
  .join('\n');

test('box-up.sh never branches on the box tier: promotion must not change what boots', () => {
  assert.ok(!/\btier\b/.test(EXEC), 'no executable reference to tier');
  assert.ok(!/\brock\b/.test(EXEC), 'no executable reference to rock');
  // the ownership record is seed-pages' business (idempotent backstop), never a
  // boot-time branch condition
  assert.ok(!/ownership\.json/.test(EXEC.replace(/seed-pages\.mjs[^\n]*/, '')), 'ownership.json must not gate boot flow');
});

test('the personal seat has three legs, and all three live in the member entrypoint', () => {
  assert.match(EXEC, /cron\/scheduler\.mjs/, 'cadence scheduler starts here');
  assert.match(EXEC, /commit_brain/, 'brain commit-on-exit loop lives here');
  assert.match(SRC, /cockpit \(background/, 'the live dashboard section exists');
});

test('the image wall stands: Dockerfile.member still bakes the no-factory guard', () => {
  const df = readFileSync(join(HERE, '..', 'Dockerfile.member'), 'utf8');
  // the wall is the baked RUN guard (build fails if the factory reappears), not
  // a blanket path ban: provisioning/host-updates/dist is a documented exception
  // (host self-update payload, not the factory)
  assert.match(df, /RUN test ! -e \/app\/provisioning && ! command -v jq/,
    'the build-time guard IS the member/factory boundary — brokered stamps keep it unnecessary even for rocks');
  const copies = df.split('\n').filter((l) => /^\s*COPY/i.test(l));
  assert.ok(!copies.some((l) => /\.\/provisioning\/?|\s\/app\/provisioning/.test(l)),
    'nothing may land AT /app/provisioning inside the image');
});
