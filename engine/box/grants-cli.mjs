#!/usr/bin/env node
// grants-cli.mjs: the box-side command surface for who may open this mineral.
// The panel's access verbs shell out to exactly this, the same way the device
// verbs shell out to roster-cli, so the rules live in ONE place and somebody
// editing ownership.json by hand gets them too.
//
//   node grants-cli.mjs <stateDir> list
//   node grants-cli.mjs <stateDir> grant <email> [member|admin]
//   node grants-cli.mjs <stateDir> activate <email>
//   node grants-cli.mjs <stateDir> revoke <email>
//   node grants-cli.mjs <stateDir> claim <email>
//   node grants-cli.mjs <stateDir> who
//
// `activate` is separate from `grant` on purpose: a grant is an intent addressed
// to a mailbox, and turning it into access is a deliberate second act. Keeping
// it its own verb means nothing can mint live access in a single step by
// accident. See docs/design-account-bound-access.md.
//
// LOCAL ONLY (self-host strip, 2026-09-01). The `accept-proofs` and `mirror`
// verbs are gone: both spoke to the central directory / account system, which
// is deleted. Nothing here touches the network any more; ownership.json is the
// whole truth and this CLI is its only pen.
import { grant, activate, revoke, claim, listGrants, whoCanOpen, revokeWithCascade } from './grants.mjs';

const die = (msg) => { console.error(msg); process.exit(1); };
const out = (o) => console.log(JSON.stringify(o, null, 2));

const stateDir = process.argv[2] || '/state';
const cmd = process.argv[3] || 'list';
const [arg1, arg2] = process.argv.slice(4);

// Errors reach a person, so they are plain words, not stack traces. The verbs
// throw with a sentence already fit to show; anything else is a real fault and
// keeps its message rather than being flattened into "something went wrong".
const run = (fn) => { try { return fn(); } catch (e) { die(`ERROR: ${e && e.message ? e.message : e}`); } };

if (cmd === 'list') {
  out({ grants: run(() => listGrants(stateDir)) });
} else if (cmd === 'who') {
  out({ who: run(() => whoCanOpen(stateDir)) });
} else if (cmd === 'grant') {
  if (!arg1) die('ERROR: give the email address of the person you are granting access to.');
  run(() => grant(stateDir, arg1, arg2 || 'member'));
  // (The invite letter went with the central account system, 2026-09-01: the
  // link it carried pointed at crads-ai.com/access, and the sign-in that proved
  // the mailbox lived there too. Activation is the local `activate` verb now,
  // run by whoever administers this box once they trust the address.)
  out({ ok: true, granted: String(arg1).trim().toLowerCase(), status: 'pending',
    note: 'Pending until you run: grants-cli activate <email>. There is no central sign-in any more; activating is your say-so.' });
} else if (cmd === 'activate') {
  if (!arg1) die('ERROR: give the email address you are activating.');
  run(() => activate(stateDir, arg1));
  out({ ok: true, active: String(arg1).trim().toLowerCase() });
} else if (cmd === 'revoke') {
  if (!arg1) die('ERROR: give the email address you are removing.');
  let cascade;
  try { cascade = await revokeWithCascade(stateDir, arg1); }
  catch (e) { die(`ERROR: ${e && e.message ? e.message : e}`); }
  const removed = cascade.removed;
  // The caller has to strip that account's machines next. Saying so here rather
  // than assuming it: access that is revoked while its keys still work is not
  // revoked, and this is the one place that knows the revoke happened.
  // Say what was actually cut AND what could not be accounted for. "Revoked"
  // over a box that still has three unattributed keys open is the comfortable
  // lie; the honest answer is the one a person can act on.
  out({ ok: true, revoked: removed.email, machines_cut: cascade.cut,
    ...(cascade.unattributed
      ? { warning: `${cascade.unattributed} machine(s) on this mineral name no account, so they were left alone. They were added before account-bound access; check them by hand.` }
      : {}),
    ...(cascade.error ? { error: cascade.error } : {}) });
} else if (cmd === 'claim') {
  // For minerals built before birth wrote a holder. Refuses on an already-held
  // box: changing a holder is a transfer, with consent on both sides, and a claim
  // that could overwrite would be a way to take a box by being second.
  if (!arg1) die('ERROR: give the email address claiming this mineral.');
  run(() => claim(stateDir, arg1));
  out({ ok: true, holder: String(arg1).trim().toLowerCase() });
} else {
  die(`ERROR: unknown command "${cmd}". Try: list, who, grant, activate, revoke, claim.`);
}
