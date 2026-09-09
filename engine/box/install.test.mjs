// install.test.mjs — box machinery ships in the image and reaches boxes that
// already exist. Run: node --test engine/box/install.test.mjs
//
// Why this file exists. The six box-side scripts were baked into each member's
// cloud-init at stamp time, and that cost twice on 2026-08-05:
//
//  1. They FROZE. Nothing rewrites a file written once into user-data, so every
//     machinery fix reached new boxes only. A full day of fixes could never have
//     reached one box that already existed.
//  2. They FILLED THE PAYLOAD. Hetzner caps user-data at 32768 B; these scripts
//     are 31.5 KB of source. A routine stamp died at 31814 B and no new member
//     could be created on ANY rock until this changed.
//
// None of them carries per-member templating, so the image is where they belong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOXUP = join(HERE, '..', 'box-up.sh');
const SCRIPTS = readdirSync(HERE).filter((f) => f.endsWith('.sh'));

test('every box script is present and carries no per-member templating', () => {
  // org-sync, heartbeat-push, org-brain-wire; the three tie scripts left 2026-09-09
  assert.ok(SCRIPTS.length >= 3, `expected the three box scripts, saw ${SCRIPTS.length}`);
  for (const f of SCRIPTS) {
    const src = readFileSync(join(HERE, f), 'utf8');
    assert.doesNotMatch(src, /\{\{[A-Z_]+\}\}/, `${f} has a placeholder, so it is per-member and cannot ship in an image`);
  }
});

test('each one is valid shell', () => {
  for (const f of SCRIPTS) {
    assert.doesNotThrow(() => execFileSync('bash', ['-n', join(HERE, f)]), `${f} does not parse`);
  }
});

test('box-up installs them into the box, and refreshes a stale frozen copy', () => {
  const box = tmpDir('boxinst-');
  writeFileSync(join(box, 'org-sync.sh'), '#!/bin/sh\n# a copy frozen at stamp time, months old\nexit 0\n');
  // run just the installer, the way box-up does
  const fn = readFileSync(BOXUP, 'utf8').match(/install_box_scripts\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fn, 'box-up must carry an install_box_scripts function');
  execFileSync('bash', ['-c', `ENGINE=${JSON.stringify(HERE + '/..')}; BOX=${JSON.stringify(box)}; ${fn[0]}; install_box_scripts`],
    { stdio: 'ignore' });
  for (const f of SCRIPTS) {
    assert.ok(existsSync(join(box, f)), `${f} must land in the box`);
    assert.ok(statSync(join(box, f)).mode & 0o111, `${f} must be executable`);
  }
  assert.equal(readFileSync(join(box, 'org-sync.sh'), 'utf8'), readFileSync(join(HERE, 'org-sync.sh'), 'utf8'),
    'a frozen copy must be REPLACED — refusing to overwrite is what froze the fleet');
});

test('installing twice is a no-op, not churn', () => {
  const box = tmpDir('boxinst2-');
  const fn = readFileSync(BOXUP, 'utf8').match(/install_box_scripts\(\)\s*\{[\s\S]*?\n\}/)[0];
  const run = () => execFileSync('bash', ['-c', `ENGINE=${JSON.stringify(HERE + '/..')}; BOX=${JSON.stringify(box)}; ${fn}; install_box_scripts`], { stdio: 'ignore' });
  run();
  const first = statSync(join(box, 'org-sync.sh')).mtimeMs;
  run();
  assert.equal(statSync(join(box, 'org-sync.sh')).mtimeMs, first, 'an unchanged script must not be rewritten every boot');
});

test('the seed now fits the cloud-init cap with room to spare', () => {
  // The whole point: what a member starts with must be what is genuinely theirs.
  const tplBox = join(HERE, '..', '..', '..', 'brain-template', 'pebble-template');
  if (!existsSync(tplBox)) return;   // template not checked out beside us; the stamp-side test covers it
  const seed = execFileSync('bash', ['-c', `tar czf - --exclude=./box -C ${JSON.stringify(tplBox)} . | base64 | wc -c`], { encoding: 'utf8' }).trim();
  assert.ok(Number(seed) < 12000, `seed without box/ should be well under budget, got ${seed} B`);
});
