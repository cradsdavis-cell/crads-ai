// known-hosts-hashed.test.mjs — the stale-key clear must find HASHED entries.
// Run: node --test wizard/panel/known-hosts-hashed.test.mjs
//
// Why this file exists. forgetHost() and pinHostForUser() decide whether a
// known_hosts line belongs to a host by reading the line's first field and
// splitting it on commas. That only ever matches a PLAINTEXT entry — the shape
// this app writes itself. OpenSSH defaults to `HashKnownHosts yes` on Debian
// and Ubuntu, so every entry ssh wrote looks like
//
//   |1|<base64 salt>|<base64 HMAC-SHA1(salt, host)> ecdsa-sha2-nistp256 AAAA...
//
// and survived the clear untouched. That is precisely the recycled-IP lockout
// the clear exists to prevent: Hetzner hands a deleted box's IP to a new one,
// the user's ssh already has a hashed key for that address, and the connect
// dies with the MITM banner. Reproduced live on 2026-08-04 — promo-lab was
// deleted, qa-wren was given its IP minutes later, and two stale hashed
// entries (rsa + ecdsa) outlived the install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { forgetHost } from './ssh-bridge.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

// Build a hashed known_hosts line exactly as OpenSSH does.
function hashedLine(host, keyType = 'ecdsa-sha2-nistp256', blob = 'AAAAstale') {
  const salt = randomBytes(20);
  const hash = createHmac('sha1', salt).update(host).digest('base64');
  return `|1|${salt.toString('base64')}|${hash} ${keyType} ${blob}`;
}

test('forgetHost clears a hashed entry for the host', () => {
  const dir = tmpDir('kh-');
  const f = join(dir, 'known_hosts');
  writeFileSync(f, [
    hashedLine('46.225.88.43', 'ecdsa-sha2-nistp256'),
    hashedLine('46.225.88.43', 'ssh-rsa'),
    hashedLine('10.0.0.9'),                       // a different host: must survive
    '203.0.113.7 ssh-ed25519 AAAAkeep',            // plaintext other host: must survive
    '46.225.88.43 ssh-ed25519 AAAAstaleplain',     // plaintext same host: already cleared today
  ].join('\n') + '\n');
  forgetHost('46.225.88.43', f);
  const left = readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.equal(left.length, 2, `expected only the two other hosts to survive, got:\n${left.join('\n')}`);
  assert.ok(left.some((l) => l.includes('AAAAkeep')));
});

test('forgetHost still clears plaintext entries, including comma lists', () => {
  const dir = tmpDir('kh-');
  const f = join(dir, 'known_hosts');
  writeFileSync(f, [
    'box.example.com,46.225.88.43 ssh-ed25519 AAAAstale',
    'other.example.com ssh-ed25519 AAAAkeep',
  ].join('\n') + '\n');
  forgetHost('46.225.88.43', f);
  const left = readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(left, ['other.example.com ssh-ed25519 AAAAkeep']);
});

test('a malformed hashed line is left alone rather than throwing', () => {
  const dir = tmpDir('kh-');
  const f = join(dir, 'known_hosts');
  writeFileSync(f, '|1|not-valid-base64!!! ssh-ed25519 AAAAweird\n');
  forgetHost('46.225.88.43', f);
  assert.match(readFileSync(f, 'utf8'), /AAAAweird/);
});
