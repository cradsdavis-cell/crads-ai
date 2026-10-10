// net-defaults.mjs: widen node's happy-eyeballs attempt window (trap 65).
//
// Node (20+, so the app's node 22 too) tries a host's addresses ONE AT A TIME,
// alternating families, and abandons every attempt but the last after
// net.getDefaultAutoSelectFamilyAttemptTimeout(): 250 ms. When the first
// family's TCP handshake takes longer than that and the other family fails
// fast (IPv6 handed out but unroutable, which is ENETUNREACH in microseconds),
// the connect dies with ETIMEDOUT although the host was reachable all along.
// Found live 2026-10-10 on the operator box: api.hetzner.cloud is ~330 ms away
// over IPv4, IPv6 is unroutable there, and every fetch failed while curl -4
// answered in a second. Slow mobile and rural links (Thai mobile to Germany)
// sit in the same band, so the desktop app widens the window at startup.
//
// Only the abandoned-attempt case pays for the wider window: a first family
// that is blackholed (SYNs dropped, no error) now costs up to this long before
// the next family is tried, instead of 250 ms. A working first family is not
// slowed at all, and the last attempt never had a timeout.
import net from 'node:net';

// One SYN retransmit (1 s initial RTO) plus a long round trip still fits.
export const MIN_ATTEMPT_TIMEOUT_MS = 2500;

// Raise, never lower: a larger value from NODE_OPTIONS
// (--network-family-autoselection-attempt-timeout) wins. Idempotent; never throws.
export function applyNetDefaults() {
  try {
    if (net.getDefaultAutoSelectFamilyAttemptTimeout() < MIN_ATTEMPT_TIMEOUT_MS) {
      net.setDefaultAutoSelectFamilyAttemptTimeout(MIN_ATTEMPT_TIMEOUT_MS);
    }
    return net.getDefaultAutoSelectFamilyAttemptTimeout();
  } catch {
    return null; // a node without the knob: nothing to widen
  }
}
