// net-reach.mjs: let Node's fetch reach far hosts from a server whose IPv6 is broken (trap 78).
//
// Node's fetch tries addresses in the order DNS returns them (IPv6 first for api.telegram.org)
// and, with autoSelectFamily on (the default), gives each attempt 250 ms before it moves on.
// From a Sydney server Telegram is about 300 ms away, so even the IPv4 attempt is abandoned
// before its handshake completes, and every request fails ETIMEDOUT after about 300 ms. On
// 2026-10-21 that left the Crads Telegram reader failing 4,794 polls in a row on the operator's
// own server while `curl -4` got through in 0.9 s. IPv4 first, and two seconds per attempt,
// fixes both halves; a box whose IPv6 works still reaches it, two seconds later at worst.
//
// Importing this module applies it process-wide, so import it FIRST in any entrypoint that
// talks to a far host.
import dns from 'node:dns';
import net from 'node:net';

export const ATTEMPT_TIMEOUT_MS = 2000;

export function preferReachableAddresses() {
  dns.setDefaultResultOrder('ipv4first');
  if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
    net.setDefaultAutoSelectFamilyAttemptTimeout(ATTEMPT_TIMEOUT_MS);
  }
}

preferReachableAddresses();
