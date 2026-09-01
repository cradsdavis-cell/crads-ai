// vault.test.mjs: the box-side secret store.
//   node --test engine/vault/vault.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listSecrets, getHot, putHot, putCold, removeSecret, VALID_NAME } from './vault.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const state = () => tmpDir('vault-');
const ENVELOPE = {
  v: 1, alg: 'x25519-hkdf-sha256+aes-256-gcm',
  ciphertext: 'Y2lwaGVy', iv: 'aXZpdml2', tag: 'dGFndGFn',
  wraps: [{ fingerprint: 'laptop', epk: 'ZXBr', wrapped: 'd3JhcA==', wiv: 'd2l2', wtag: 'd3RhZw==' }],
};

test('an empty box has an empty vault, not an error', () => {
  assert.deepEqual(listSecrets(state()), []);
});

test('putHot then listSecrets: the entry is listed with its tier, never its value', () => {
  const dir = state();
  putHot(dir, 'gmail-token', 'ya29.SECRET-VALUE', { label: 'Gmail', usedBy: ['morning-brief'] });
  const [s] = listSecrets(dir);
  assert.equal(s.name, 'gmail-token');
  assert.equal(s.tier, 'hot');
  assert.equal(s.label, 'Gmail');
  assert.deepEqual(s.used_by, ['morning-brief']);
  assert.ok(s.updated, 'carries an updated stamp');
  assert.equal(s.value, undefined, 'listing NEVER carries values');
  assert.ok(!JSON.stringify(s).includes('ya29.SECRET-VALUE'), 'no value leaks into the listing');
});

test('getHot returns the value: hot means the box can read it, by definition', () => {
  const dir = state();
  putHot(dir, 'gmail-token', 'ya29.abc');
  assert.equal(getHot(dir, 'gmail-token'), 'ya29.abc');
});

test('putCold stores the envelope and NOTHING the box could open', () => {
  const dir = state();
  putCold(dir, 'bank-login', ENVELOPE, { label: 'Bank' });
  const [s] = listSecrets(dir);
  assert.equal(s.tier, 'cold');
  assert.equal(s.value, undefined);
  assert.equal(s.sealed_to.length, 1);
  assert.equal(s.sealed_to[0], 'laptop');
  // the raw file holds the envelope, and no plaintext field at all
  const raw = JSON.parse(readFileSync(join(dir, 'secrets', 'vault', 'bank-login.json'), 'utf8'));
  assert.equal(raw.value, undefined);
  assert.equal(raw.envelope.alg, ENVELOPE.alg);
});

test('getHot REFUSES a cold entry: the box has no path to that plaintext', () => {
  const dir = state();
  putCold(dir, 'bank-login', ENVELOPE);
  assert.throws(() => getHot(dir, 'bank-login'), /cold/i);
});

test('the cold envelope is readable for transport (the app opens it, the box moves it)', () => {
  const dir = state();
  putCold(dir, 'bank-login', ENVELOPE);
  const [s] = listSecrets(dir, { withEnvelopes: true });
  assert.equal(s.envelope.ciphertext, ENVELOPE.ciphertext);
});

test('putHot on an existing name replaces the value and bumps updated, keeping created', () => {
  const dir = state();
  putHot(dir, 'api-key', 'one', { created: '2026-01-01' });
  const first = listSecrets(dir)[0];
  putHot(dir, 'api-key', 'two');
  const second = listSecrets(dir)[0];
  assert.equal(getHot(dir, 'api-key'), 'two');
  assert.equal(second.created, first.created, 'created is preserved across a replace');
  assert.equal(listSecrets(dir).length, 1, 'still one entry');
});

test('a hot entry can be replaced by a cold one and the old value is gone', () => {
  const dir = state();
  putHot(dir, 'api-key', 'PLAINTEXT-WAS-HERE');
  putCold(dir, 'api-key', ENVELOPE);
  const [s] = listSecrets(dir);
  assert.equal(s.tier, 'cold');
  const raw = readFileSync(join(dir, 'secrets', 'vault', 'api-key.json'), 'utf8');
  assert.ok(!raw.includes('PLAINTEXT-WAS-HERE'), 'the old hot value does not survive the flip');
});

test('removeSecret deletes the file; removing what is not there is not an error', () => {
  const dir = state();
  putHot(dir, 'api-key', 'v');
  assert.equal(removeSecret(dir, 'api-key'), true);
  assert.deepEqual(listSecrets(dir), []);
  assert.equal(existsSync(join(dir, 'secrets', 'vault', 'api-key.json')), false);
  assert.equal(removeSecret(dir, 'api-key'), false);
});

test('names are constrained so a name can never escape the vault directory', () => {
  const dir = state();
  for (const bad of ['../escape', 'a/b', 'UPPER', '', '.hidden', 'x'.repeat(65)]) {
    assert.equal(VALID_NAME.test(bad), false, `${JSON.stringify(bad)} must be rejected`);
    assert.throws(() => putHot(dir, bad, 'v'), /name/i);
  }
  for (const good of ['gmail-token', 'a1', 'my-client-key-2']) assert.ok(VALID_NAME.test(good), good);
});

test('the vault lives beside the legacy secret files and does not disturb them', () => {
  const dir = state();
  writeFileSync(join(dir, 'legacy-marker'), 'x');   // stand-in for secrets/telegram_bot_token etc
  putHot(dir, 'api-key', 'v');
  assert.ok(existsSync(join(dir, 'secrets', 'vault', 'api-key.json')));
  assert.deepEqual(readdirSync(join(dir, 'secrets')), ['vault'], 'vault is a subdirectory, nothing else touched');
  assert.ok(existsSync(join(dir, 'legacy-marker')));
});

test('a corrupt entry is skipped, not fatal: one bad file cannot hide the rest', () => {
  const dir = state();
  putHot(dir, 'good', 'v');
  writeFileSync(join(dir, 'secrets', 'vault', 'broken.json'), '{not json');
  const names = listSecrets(dir).map((s) => s.name);
  assert.deepEqual(names, ['good']);
});
