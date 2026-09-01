// fingerprint.mjs — the 6-char device safety code (D51 admin-first invites).
//
// The security graft that closes the bearer-invite-link showstopper: on enrolment the
// MEMBER's app shows this code; the ADMIN confirms it out-of-band against what the member
// reads, then approves. An interceptor who substitutes their own key produces a DIFFERENT
// code, so the compare fails and the admin denies. Same function on both sides is what makes
// the re-verify meaningful — the rock RE-COMPUTES from the received public key rather than
// trusting a code the app claims (a lying app can't fake a matching key). WhatsApp/Signal
// safety-number pattern, shortened to 6 base32 chars for a human read-back.
import { createHash } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648, no padding

// Derive the code from the KEY MATERIAL only (the base64 blob), never the comment, so it is
// stable regardless of how the device is labelled. Returns 6 uppercase base32 chars.
export function deviceFingerprint(pubkeyLine) {
  const parts = String(pubkeyLine ?? '').trim().split(/\s+/);
  const blob = parts.length >= 2 ? parts[1] : parts[0]; // "ssh-ed25519 <blob> [comment]"
  if (!blob) return '';
  const digest = createHash('sha256').update(blob).digest();
  let bits = 0, val = 0, out = '';
  for (const byte of digest) {
    val = (val << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; if (out.length === 6) return out; }
  }
  return out;
}
