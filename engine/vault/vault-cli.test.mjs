// vault-cli.test.mjs: the command surface the secrets panel verbs shell out to.
//   node --test engine/vault/vault-cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), 'vault-cli.mjs');
const state = () => tmpDir('vcli-');
const cli = (dir, args, input) => execFileSync('node', [CLI, dir, ...args], { encoding: 'utf8', input });

const ENVELOPE = JSON.stringify({
  v: 1, alg: 'x25519-hkdf-sha256+aes-256-gcm',
  ciphertext: 'Y2lwaGVy', iv: 'aXZpdml2', tag: 'dGFndGFn',
  wraps: [{ fingerprint: 'laptop', epk: 'ZXBr', wrapped: 'd3JhcA==', wiv: 'd2l2', wtag: 'd3RhZw==' }],
});

test('put-hot reads the value from STDIN, never from argv', () => {
  const dir = state();
  const out = cli(dir, ['put-hot', 'gmail-token', 'Gmail'], 'ya29.the-actual-token\n');
  assert.match(out, /^OK: /m);
  const list = JSON.parse(cli(dir, ['list']));
  assert.equal(list.secrets[0].name, 'gmail-token');
  assert.equal(list.secrets[0].tier, 'hot');
  assert.equal(list.secrets[0].value, undefined, 'list never carries values');
});

test('a value with newlines and spaces survives STDIN intact', () => {
  const dir = state();
  const value = '-----BEGIN KEY-----\nline two with spaces\n-----END KEY-----';
  cli(dir, ['put-hot', 'deploy-key', 'Deploy key'], value);
  assert.equal(cli(dir, ['get-hot', 'deploy-key']).replace(/\n$/, ''), value);
});

test('put-cold takes an envelope on STDIN and stores it opaquely', () => {
  const dir = state();
  cli(dir, ['put-cold', 'bank-login', 'Bank'], ENVELOPE);
  const list = JSON.parse(cli(dir, ['list']));
  assert.equal(list.secrets[0].tier, 'cold');
  assert.deepEqual(list.secrets[0].sealed_to, ['laptop']);
});

test('get-hot on a cold secret refuses with an explanation', () => {
  const dir = state();
  cli(dir, ['put-cold', 'bank-login', 'Bank'], ENVELOPE);
  assert.throws(() => cli(dir, ['get-hot', 'bank-login']), /cold/i);
});

test('envelopes: the transport listing the app uses to open cold secrets', () => {
  const dir = state();
  cli(dir, ['put-cold', 'bank-login', 'Bank'], ENVELOPE);
  const list = JSON.parse(cli(dir, ['envelopes']));
  assert.equal(list.secrets[0].envelope.ciphertext, 'Y2lwaGVy');
});

test('remove deletes; removing what is absent says so without failing', () => {
  const dir = state();
  cli(dir, ['put-hot', 'gmail-token', 'Gmail'], 'v');
  assert.match(cli(dir, ['remove', 'gmail-token']), /OK: /);
  assert.equal(JSON.parse(cli(dir, ['list'])).secrets.length, 0);
  assert.match(cli(dir, ['remove', 'gmail-token']), /nothing/i);
});

test('a bad name is refused before anything is written', () => {
  const dir = state();
  assert.throws(() => cli(dir, ['put-hot', '../escape', 'L'], 'v'), /name/i);
  assert.equal(JSON.parse(cli(dir, ['list'])).secrets.length, 0);
});

test('an empty value is refused: a blank secret is a mistake, not an intention', () => {
  const dir = state();
  assert.throws(() => cli(dir, ['put-hot', 'gmail-token', 'Gmail'], ''), /empty/i);
});

test('malformed cold JSON is refused, nothing is written', () => {
  const dir = state();
  assert.throws(() => cli(dir, ['put-cold', 'bank-login', 'Bank'], '{not json'), /sealed|malformed/i);
  assert.equal(JSON.parse(cli(dir, ['list'])).secrets.length, 0);
});
