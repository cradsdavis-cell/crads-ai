// net-reach.test.mjs: the Telegram bridge must reach Telegram from a far server with broken
// IPv6 (trap 78). Run: node --test engine/lib/net-reach.test.mjs
//
// On 2026-10-21 the Crads Telegram reader on the operator's own server failed 4,794 polls in a
// row (fetch ETIMEDOUT after ~300 ms) while `curl -4` reached Telegram in 0.9 s: fetch tried the
// AAAA address first and gave each attempt 250 ms, less than one round trip from Sydney.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ATTEMPT_TIMEOUT_MS } from './net-reach.mjs';

test('importing net-reach makes IPv4 first and gives each connect attempt 2 s', () => {
  assert.equal(dns.getDefaultResultOrder(), 'ipv4first');
  assert.equal(ATTEMPT_TIMEOUT_MS, 2000);
  if (typeof net.getDefaultAutoSelectFamilyAttemptTimeout === 'function') {
    assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), ATTEMPT_TIMEOUT_MS);
  }
});

// Structural: the module only helps if it is evaluated before the entrypoint's first fetch,
// so it must be the FIRST import of every file that talks to the Bot API.
for (const rel of ['../comms/telegram.mjs', '../comms/telegram-link.mjs']) {
  test(`${path.basename(rel)} imports net-reach first (trap 78)`, () => {
    const src = readFileSync(path.join(import.meta.dirname, rel), 'utf8');
    const firstImport = src.split('\n').find((l) => l.startsWith('import '));
    assert.match(firstImport, /^import '\.\.\/lib\/net-reach\.mjs';/);
  });
}
