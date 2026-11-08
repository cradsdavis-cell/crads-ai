#!/usr/bin/env node
// support-access.mjs <boxDir> <verb>
//
//   grant <hours>          the one-button Crads AI support grant, 1 to 72 hours
//   revoke [id]            end one grant, or every grant when no id is given
//   status                 every live grant + recent events (JSON)
//   request-show           read a helper request code on stdin; print what it asks (REQUEST {...}) or ERROR
//   request-approve        read a code on stdin; approve it (writes the grant, re-derives the door)
//   request-decline        read a code on stdin; decline it (single-use, so it cannot come back)
//
// Consent-gated access, no standing key (three-layer model, L1 repair), now for
// NAMED helpers: spec docs/superpowers/specs/2026-11-08-helper-access-design.md.
// The record and the request checks live in grants.mjs; this file is the verb
// surface the app calls over the member's own SSH door. Every grant carries
// sshd's own expiry-time option, so access ends on time even if nothing here
// ever runs again. devices/device-sync.mjs is the single writer of
// authorized_keys and renders one line per live grant from access.json.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { syncKeys } from '../devices/device-sync.mjs';
import {
  readRecord, liveGrants, grantSupport, revoke, supportKey, publicGrant, hostRecords,
  checkRequest, approveRequest, declineRequest,
} from './grants.mjs';

const box = path.resolve(process.argv[2] || '/state');
const cmd = process.argv[3] || 'status';
const stdinCode = () => { try { return readFileSync(0, 'utf8').trim(); } catch { return ''; } };
const until = (iso) => iso.replace('T', ' ').slice(0, 16) + ' UTC';

if (cmd === 'grant') {
  const r = grantSupport(box, process.argv[4]);
  if (!r.ok) { console.log('ERROR: ' + r.reason); process.exit(1); }
  syncKeys(box);
  console.log(`OK: support access granted for ${r.grant.hours}h (until ${r.grant.expires_at}). Revoke any time.`);
} else if (cmd === 'revoke') {
  const id = String(process.argv[4] || '').trim();
  if (id && !/^(support|req_[0-9a-f]{16})$/.test(id)) { console.log('ERROR: that is not a grant id'); process.exit(1); }
  const r = revoke(box, id);
  syncKeys(box);
  if (!r.ended.length) console.log(id ? 'OK: that access had already ended; nothing to revoke.' : 'OK: nothing was granted; nothing to revoke.');
  else if (r.ended.length === 1 && r.ended[0].id === 'support') console.log('OK: support access revoked.');
  else console.log(`OK: access ended for ${r.ended.map((g) => g.helper?.name || g.id).join(', ')}.`);
} else if (cmd === 'request-show') {
  const c = checkRequest(box, stdinCode());
  if (!c.ok) { console.log('ERROR: ' + c.reason); process.exit(1); }
  console.log('REQUEST ' + JSON.stringify(c.view));
} else if (cmd === 'request-approve') {
  const r = approveRequest(box, stdinCode());
  if (!r.ok) { console.log('ERROR: ' + r.reason); process.exit(1); }
  syncKeys(box);
  console.log(`OK: ${r.grant.helper.name} can reach this mineral until ${until(r.grant.expires_at)}. End it any time on this page.`);
} else if (cmd === 'request-decline') {
  const r = declineRequest(box, stdinCode());
  if (!r.ok) { console.log('ERROR: ' + r.reason); process.exit(1); }
  console.log(`OK: declined. ${r.view.helper.name} has no access, and this request cannot be used again.`);
} else {
  const live = liveGrants(box);
  // `active` keeps the shape older apps read (truthy = a grant is live, and its
  // expiry): the support grant if there is one, else the grant that ends last.
  const head = live.find((g) => g.id === 'support')
    || live.slice().sort((a, b) => b.expires_at.localeCompare(a.expires_at))[0] || null;
  console.log(JSON.stringify({
    configured: !!supportKey(),
    active: head ? { granted_at: head.granted_at, expires_at: head.expires_at, hours: head.hours || null } : null,
    grants: live.map(publicGrant),
    host_records: hostRecords(),
    events: readRecord(box).events.slice(-20),
  }, null, 2));
}
