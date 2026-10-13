// box-account.test.mjs: the account guard names no built-in operator.
//   node --test engine/ops/box-account.test.mjs
//
// 2026-10-13: the guard defaulted AIOS_OPERATOR_EMAIL to one person's own
// address, so every public image carried it, and a self-hosted mineral (where
// the owner IS the right account) could be flagged as "the operator". The
// check now runs only when provisioning sets the variable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'box-account.mjs');

function box(email) {
  const d = tmpDir('boxacct-');
  mkdirSync(join(d, '.claude-auth'), { recursive: true });
  writeFileSync(join(d, '.claude-auth', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: 1 } }));
  writeFileSync(join(d, '.claude-auth', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }));
  return d;
}
const run = (d, env) => {
  try { return { out: execFileSync('node', [GUARD, d], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }).trim(), code: 0 }; }
  catch (e) { return { out: String(e.stdout || '').trim(), code: e.status }; }
};

test('no operator configured: any signed-in account is just OK', () => {
  const r = run(box('owner@example.com'), {});
  assert.equal(r.out, 'OK:owner@example.com');
  assert.equal(r.code, 0);
});

test('an operator configured by provisioning is still caught', () => {
  const r = run(box('ops@example.com'), { AIOS_OPERATOR_EMAIL: 'Ops@Example.com' });
  assert.equal(r.out, 'OPERATOR:ops@example.com');
  assert.equal(r.code, 3);
});

test('the shipped guard carries no personal address', () => {
  assert.doesNotMatch(readFileSync(GUARD, 'utf8'), /@gmail\.com/);
});
