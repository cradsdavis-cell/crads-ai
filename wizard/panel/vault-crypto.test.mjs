// vault-crypto.test.mjs: the cold tier's sealing, which runs on the MEMBER's machine.
//   node --test wizard/panel/vault-crypto.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintVaultKeypair, seal, open, vaultFingerprint } from './vault-crypto.mjs';

test('mintVaultKeypair: a public half that travels as base64, a private half that does not', () => {
  const kp = mintVaultKeypair();
  assert.match(kp.publicKey, /^[A-Za-z0-9+/]+=*$/);
  assert.match(kp.privateKey, /^[A-Za-z0-9+/]+=*$/);
  assert.notEqual(kp.publicKey, kp.privateKey);
  assert.match(vaultFingerprint(kp.publicKey), /^VK:[A-Za-z0-9+/]{22}$/);
});

test('seal then open: a value round-trips for the device it was sealed to', () => {
  const kp = mintVaultKeypair();
  const env = seal('hunter2', [{ fingerprint: 'dev-a', vaultkey: kp.publicKey }]);
  assert.equal(open(env, kp.privateKey), 'hunter2');
});

test('seal: the envelope never contains the plaintext', () => {
  const kp = mintVaultKeypair();
  const env = seal('super-secret-value', [{ fingerprint: 'dev-a', vaultkey: kp.publicKey }]);
  assert.ok(!JSON.stringify(env).includes('super-secret-value'), 'plaintext absent from the envelope');
});

test('seal to several devices: any one of them can open it', () => {
  const a = mintVaultKeypair(); const b = mintVaultKeypair(); const c = mintVaultKeypair();
  const env = seal('shared', [
    { fingerprint: 'a', vaultkey: a.publicKey },
    { fingerprint: 'b', vaultkey: b.publicKey },
    { fingerprint: 'c', vaultkey: c.publicKey },
  ]);
  assert.equal(env.wraps.length, 3);
  assert.equal(open(env, a.privateKey), 'shared');
  assert.equal(open(env, b.privateKey), 'shared');
  assert.equal(open(env, c.privateKey), 'shared');
});

test('a device that was NOT sealed to cannot open it', () => {
  const mine = mintVaultKeypair(); const stranger = mintVaultKeypair();
  const env = seal('mine only', [{ fingerprint: 'mine', vaultkey: mine.publicKey }]);
  assert.throws(() => open(env, stranger.privateKey), /cannot open/i);
});

test('a tampered ciphertext is refused, not silently mis-decrypted', () => {
  const kp = mintVaultKeypair();
  const env = seal('value', [{ fingerprint: 'a', vaultkey: kp.publicKey }]);
  const buf = Buffer.from(env.ciphertext, 'base64');
  buf[0] ^= 0xff;
  const tampered = { ...env, ciphertext: buf.toString('base64') };
  assert.throws(() => open(tampered, kp.privateKey), /./);
});

test('a tampered wrap is refused', () => {
  const kp = mintVaultKeypair();
  const env = seal('value', [{ fingerprint: 'a', vaultkey: kp.publicKey }]);
  const w = Buffer.from(env.wraps[0].wrapped, 'base64');
  w[0] ^= 0xff;
  const tampered = { ...env, wraps: [{ ...env.wraps[0], wrapped: w.toString('base64') }] };
  assert.throws(() => open(tampered, kp.privateKey), /./);
});

test('sealing the same value twice produces different bytes (fresh DEK and nonce)', () => {
  const kp = mintVaultKeypair();
  const one = seal('same', [{ fingerprint: 'a', vaultkey: kp.publicKey }]);
  const two = seal('same', [{ fingerprint: 'a', vaultkey: kp.publicKey }]);
  assert.notEqual(one.ciphertext, two.ciphertext);
  assert.equal(open(one, kp.privateKey), open(two, kp.privateKey));
});

test('seal refuses an empty device list: an unopenable secret is a bug, not a feature', () => {
  assert.throws(() => seal('v', []), /at least one device/i);
});

test('unicode and long values survive the round trip', () => {
  const kp = mintVaultKeypair();
  const value = 'pa55 word with spaces, emoji and Welsh: Eryri, Ffestiniog. ' + 'x'.repeat(5000);
  const env = seal(value, [{ fingerprint: 'a', vaultkey: kp.publicKey }]);
  assert.equal(open(env, kp.privateKey), value);
});

test('a public key or junk offered as a private key gets a human error, not an OpenSSL dump', () => {
  const kp = mintVaultKeypair();
  const env = seal('v', [{ fingerprint: 'a', vaultkey: kp.publicKey }]);
  assert.throws(() => open(env, kp.publicKey), /not a usable vault key/i);
  assert.throws(() => open(env, 'not-base64-at-all'), /not a usable vault key/i);
});

test('THE PROPERTY: nothing the box stores can open a cold secret', () => {
  const dev = mintVaultKeypair();
  const env = seal('client-bank-login', [{ fingerprint: 'laptop', vaultkey: dev.publicKey }]);
  // everything a box holds: the envelope, and the roster's PUBLIC vault keys
  const boxHeld = [dev.publicKey, ...env.wraps.map((w) => w.epk)];
  assert.ok(!JSON.stringify(env).includes('client-bank-login'), 'no plaintext in the envelope');
  for (const k of boxHeld) assert.throws(() => open(env, k), /./, 'box-held key must not open it');
  // only the private half, which never leaves the member's machine, works
  assert.equal(open(env, dev.privateKey), 'client-bank-login');
});
