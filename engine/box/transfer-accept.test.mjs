// transfer-accept.sh — the script is the mechanical leg; the receipt is the gate.
// Run: node --test engine/box/transfer-accept.test.mjs
//
// Harriet's audit, 2026-08-19, point 3: this script ran as whoever was on the box.
// It now refuses, before any mutation, unless handed the 32-hex receipt the app
// obtains from the directory with the member's own sign-in. These pin that a
// bare run (the support-session shape) changes nothing, that garbage receipts
// are treated as none, and that the receipt rides in accepted.json so the org
// side can tie the marker to the record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'transfer-accept.sh');

const box = () => {
  const d = tmpDir('xfer-');
  mkdirSync(join(d, 'org-inbox', 'transfer'), { recursive: true });
  mkdirSync(join(d, 'secrets'));
  writeFileSync(join(d, 'org-inbox', 'transfer', 'to-org.json'), JSON.stringify({ invited: '2026-08-19', repo: 'ic/jane01-brain', org_slug: 'acme-collab' }));
  writeFileSync(join(d, 'ownership.json'), JSON.stringify({ owner: 'member', anchor: 'acme-collab' }));
  writeFileSync(join(d, 'heartbeat.conf'), 'x\n');
  writeFileSync(join(d, 'secrets', 'heartbeat_deploy_key'), 'x\n');
  writeFileSync(join(d, 'org-inbox.conf'), 'ORG_GH_OWNER=ic\nSLUG=jane01\n');
  return d;
};
const run = (d, args = [], env = {}) => spawnSync('bash', [SCRIPT, d, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const owner = (d) => JSON.parse(readFileSync(join(d, 'ownership.json'), 'utf8')).owner;

test('no receipt: refused before any mutation (the support-session shape)', () => {
  const d = box();
  const r = run(d);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /REFUSED: accepting a transfer needs your own sign-in/);
  assert.match(r.stdout, /from a support session, is not consent/);
  assert.equal(owner(d), 'member', 'ownership untouched');
  assert.ok(!existsSync(join(d, 'secrets', 'org_brain_deploy_key')), 'no key minted');
  assert.ok(!existsSync(join(d, 'org-brain.conf')), 'no wiring staged');
});

test('a malformed receipt is no receipt', () => {
  for (const bad of ['abc', 'g'.repeat(32), '$(id)', 'a'.repeat(31), 'a'.repeat(33)]) {
    const d = box();
    const r = run(d, [bad]);
    assert.equal(r.status, 1, `refused: ${bad}`);
    assert.equal(owner(d), 'member');
  }
});

test('with a receipt the guard passes and the receipt is what accepted.json carries', () => {
  // We cannot push to a heartbeat repo here, so run to the first network step
  // and confirm the guard is behind us: the key gets minted, wiring is staged.
  const d = box();
  writeFileSync(join(d, 'org-inbox', 'transfer', 'org-brain-wire.sh'), '#!/bin/sh\n');
  const r = run(d, ['ab'.repeat(16)], { HEARTBEAT_REMOTE_URL: join(d, 'no-such-repo.git') });
  assert.doesNotMatch(r.stdout, /REFUSED/);
  assert.ok(existsSync(join(d, 'secrets', 'org_brain_deploy_key')), 'the guard was passed: the key was minted');
  assert.equal(owner(d), 'member', 'and the flip still waits on the publish step (a failed push means no flip)');
  // the marker format names the receipt
  const src = readFileSync(SCRIPT, 'utf8');
  assert.match(src, /"consent":"%s"/, 'accepted.json carries the consent receipt');
});

test('no invitation at all is still a quiet no-op, receipt or not', () => {
  const d = box();
  unlinkSync(join(d, 'org-inbox', 'transfer', 'to-org.json'));
  const r = run(d);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no transfer invitation/);
});
