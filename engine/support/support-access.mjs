#!/usr/bin/env node
// support-access.mjs <boxDir> grant <hours> | revoke | status
//
// Consent-gated support access (three-layer model, L1 repair). No standing
// vendor access: the member (or their org, with the member's say-so) GRANTS a
// time-boxed window in which the Crads AI support key can SSH into this box.
// Mechanics ride the existing member SSH door:
//   * sshd on the host reads /state/ssh/member/authorized_keys via
//     AuthorizedKeysCommand, so this container-side file IS the grant surface.
//   * The grant line carries sshd's own expiry-time option (UTC), so expiry is
//     enforced by sshd even if nothing ever runs here again.
//   * ForceCommand lands the session inside the container like any member
//     session: support never touches the bare host.
//   * revoke clears the grant and re-derives the keys immediately; status shows
//     the grant + full event history, all member-readable in
//     /state/support/access.json.
// This module owns the GRANT RECORD only. devices/device-sync.mjs is the single
// writer of authorized_keys and renders the grant line from access.json, so a
// device add or revoke can no longer drop a live grant (and vice versa).
// Known limit (documented, not hidden): per-command transcripts of a support
// session are not captured yet — that needs a host-side hook (the disarmed D55
// host-update channel is the sanctioned path). The audit trail today is the
// grant lifecycle: who enabled it, when, until when, and when it was revoked.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncKeys } from '../devices/device-sync.mjs';

const box = path.resolve(process.argv[2] || '/state');
const cmd = process.argv[3] || 'status';
const supDir = path.join(box, 'support');
const logFile = path.join(supDir, 'access.json');
const pubFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'crads-support.pub');

const readLog = () => { try { return JSON.parse(readFileSync(logFile, 'utf8')); } catch { return { grant: null, events: [] }; } };
const writeLog = (l) => { mkdirSync(supDir, { recursive: true }); writeFileSync(logFile, JSON.stringify(l, null, 2) + '\n'); };
const supportKey = () => {
  try { return readFileSync(pubFile, 'utf8').split('\n').find((l) => /^\s*(ssh|ecdsa)-/.test(l))?.trim() || null; }
  catch { return null; }
};
// The record is the truth now: the keys file is derived from it, so there is no
// second place for the two to disagree.
const activeGrant = (log) => {
  if (!log.grant) return null;
  return new Date(log.grant.expires_at) > new Date() ? log.grant : null;
};

if (cmd === 'grant') {
  const hours = Math.max(1, Math.min(72, parseInt(process.argv[4], 10) || 24));
  const key = supportKey();
  if (!key) { console.log('ERROR: support channel not configured (no key in engine/support/crads-support.pub)'); process.exit(1); }
  const exp = new Date(Date.now() + hours * 3600_000);
  const log = readLog();
  // The grant records the KEY as well as the window: device-sync renders the
  // authorized_keys line from this record, so there is exactly one writer.
  log.grant = { granted_at: new Date().toISOString(), expires_at: exp.toISOString(), hours, key };
  log.events = (log.events || []).concat({ at: log.grant.granted_at, event: 'granted', hours, expires_at: log.grant.expires_at });
  writeLog(log);
  syncKeys(box);
  console.log(`OK: support access granted for ${hours}h (until ${exp.toISOString()}). Revoke any time.`);
} else if (cmd === 'revoke') {
  const log = readLog();
  const had = !!log.grant;
  log.grant = null;
  log.events = (log.events || []).concat({ at: new Date().toISOString(), event: had ? 'revoked' : 'revoke (nothing active)' });
  writeLog(log);
  syncKeys(box);
  console.log(had ? 'OK: support access revoked.' : 'OK: nothing was granted; nothing to revoke.');
} else {
  const log = readLog();
  const g = activeGrant(log);
  console.log(JSON.stringify({
    configured: !!supportKey(),
    active: g,
    events: (log.events || []).slice(-20),
  }, null, 2));
}
