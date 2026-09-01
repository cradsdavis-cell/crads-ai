// org-sync-page-seed-log.test.mjs: I1 (fix wave, 2026-08-25). seed_pages() in
// org-sync.sh used to discard the org-page seeder's exit status entirely
// (`2>/dev/null || true`), so if engine/appshell/seed-org-pages.mjs went
// missing, was unreadable, or threw at load, org-sync still printed its
// normal "synced." line for that inbox with no signal that page seeding had
// silently stopped. Fixed to capture the exit status and log a line naming
// the failure, while staying fail-soft: the inbox's other legs (heartbeat,
// membership, the "synced." summary) must still run and the script must
// still exit 0.
//   node --test engine/box/org-sync-page-seed-log.test.mjs
//
// Runs the real org-sync.sh in bash against a temp state dir, joined-rock
// path (org-inbox.d/<owner>.conf), with a `git` stub on PATH that no-ops
// every call to 0 (the inbox is pre-seeded with a .git dir, so the script
// takes the `pull`, not `clone`, branch). AIOS_DIR points at a tree with no
// engine/appshell/seed-org-pages.mjs at all, so `node` fails to even find the
// module - the sharpest version of "absent, unreadable, or throws at load".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SYNC = path.join(HERE, 'org-sync.sh');

const GIT_STUB = '#!/usr/bin/env bash\nexit 0\n';

function rig() {
  const root = tmpDir('orgsync-seedlog-');
  const state = path.join(root, 'state');
  const bin = path.join(root, 'bin');
  const emptyEngineRoot = path.join(root, 'no-engine-here');
  mkdirSync(path.join(state, 'org-inbox.d', 'acme'), { recursive: true });
  mkdirSync(path.join(state, 'org-inbox.d', 'acme', '.git'), { recursive: true }); // pre-seeded: takes the pull branch
  mkdirSync(path.join(state, 'org-inbox.d', 'acme', 'pages', 'pack1'), { recursive: true });
  mkdirSync(path.join(state, 'secrets'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(emptyEngineRoot, { recursive: true });
  writeFileSync(path.join(bin, 'git'), GIT_STUB, { mode: 0o755 });
  writeFileSync(path.join(state, 'org-inbox.d', 'acme.conf'), 'SLUG=acme-slug\nORG=acme-org\n');
  writeFileSync(path.join(state, 'secrets', 'org_inbox_deploy_key.acme'), 'dummy-key\n');
  writeFileSync(path.join(state, 'org-inbox.d', 'acme', 'pages', 'pack1', 'hello.html'), '<h2>hi</h2>');
  const run = () => {
    let out = '', code = 0;
    try {
      out = execFileSync('bash', [SYNC], {
        encoding: 'utf8', cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STATE_DIR: state, AIOS_DIR: emptyEngineRoot },
      });
    } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = e.status; }
    return { out, code };
  };
  return { root, run, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('a missing seed-org-pages.mjs is logged by name, not swallowed silently (I1)', () => {
  const b = rig();
  try {
    const { out, code } = b.run();
    assert.equal(code, 0, `org-sync.sh must still exit 0 (fail-soft): ${out}`);
    assert.match(out, /page seeding did not run/, `expected a named failure line, got: ${out}`);
    assert.match(out, /acme/, 'the failure names the inbox it happened for');
  } finally {
    b.done();
  }
});

test('the inbox still completes its other legs after a page-seeding failure (fail-soft, I1)', () => {
  const b = rig();
  try {
    const { out, code } = b.run();
    assert.equal(code, 0, out);
    // The "synced." summary line is the very last thing this inbox's leg
    // prints; seeing it proves the seeding failure did not abort the leg.
    assert.match(out, /acme: synced\./, `expected the leg to complete past the seeding failure, got: ${out}`);
  } finally {
    b.done();
  }
});
