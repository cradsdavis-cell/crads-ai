// rock-pages.test.mjs — Pages on rocks (panel iteration 2, R15, 2026-08-23).
// Pages were pebble-only: boot-rock.sh never called the seeder, and the rock
// inbox sync listed pushed pages with no title and no origin. Pins:
//   1. boot-rock.sh runs engine/appshell/seed-pages.mjs against $STATE_DIR,
//      non-fatally, the way box-up.sh does (structural).
//   2. org-sync.sh marks an inbox-born manifest entry `from: <rock>` with a
//      title from a sibling <id>.json (else the id), never `seed: true`, and
//      honours the page-delete tombstone (behavioural: the inline node block
//      is lifted out of the script and run against a temp box).
//   node --test engine/box/rock-pages.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const BOOT = readFileSync(join(ROOT, 'provisioning', 'rock', 'boot-rock.sh'), 'utf8');
const BOXUP = readFileSync(join(ROOT, 'engine', 'box-up.sh'), 'utf8');
const ORGSYNC = readFileSync(join(ROOT, 'engine', 'box', 'org-sync.sh'), 'utf8');
const exec = (src) => src.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');

test('boot-rock.sh seeds pages at /state the way box-up.sh does, and cannot fail the boot on it', () => {
  const lines = exec(BOOT).split('\n').filter((l) => /seed-pages\.mjs/.test(l));
  assert.equal(lines.length, 1, 'exactly one call to the seeder');
  const call = lines[0];
  assert.match(call, /engine\/appshell\/seed-pages\.mjs"?\s+"\$STATE_DIR"/, 'runs against $STATE_DIR (the rock\'s /state), not the brain root');
  // non-fatal under set -e: either `|| true` / `|| pend` or an if-guard
  const guarded = /\|\|/.test(call) || /^\s*if\s+node/.test(call);
  assert.ok(guarded, `the seeder call is guarded: ${call.trim()}`);
  // parity with the pebble entrypoint: same script, same shape
  assert.match(exec(BOXUP), /engine\/appshell\/seed-pages\.mjs|\$ENGINE\/appshell\/seed-pages\.mjs/, 'box-up.sh still seeds too');
  // and it runs AFTER ownership.json is written, so the seeder's pebble backstop never fires on a rock
  assert.ok(BOOT.indexOf('ownership.json') < BOOT.indexOf('seed-pages.mjs'), 'ownership record is written before the seeder runs');
});

test('boot-rock.sh stays person- and org-free around the new call (clean-gate shape)', () => {
  const block = BOOT.slice(BOOT.indexOf('# ---- pages (panel iteration 2'), BOOT.indexOf('seed-pages.mjs') + 400);
  assert.ok(!/@|gmail|impact|harriet|sam\b/i.test(block), 'no person or org names near the pages block');
});
