// grants.mjs: who, besides the holder, may open this mineral.
//
// The mineral is the source of truth. Grants live in ownership.json on the box's
// own disk, the directory MIRRORS them, and grant-is-the-gate. That ordering is
// the whole point: a mineral that loses its network keeps knowing who it belongs
// to, and the platform can never grant somebody access by editing a record we
// hold. See docs/design-account-bound-access.md.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE.
//
// 1. A GRANT IS NOT MANAGEMENT. ownership.json's `managed_by` says who looks
//    after this box: status, skills, updates, teardown. A grant says who may
//    READ it. A rock manages its members and must never be able to open one, so
//    nothing here may write to managed_by and nothing there may add itself here.
//    Conflating them is how the member-privacy boundary would dissolve without
//    anyone noticing, which is exactly what walking the scenarios found.
//
// 2. A GRANT IS PENDING UNTIL THE MAILBOX IS PROVEN. Creating a grant does not
//    give access; it records an intent addressed to an email. It becomes live
//    only when someone signs in as that address (Sam's ruling: "yes proof"). So a
//    typo grants nobody anything, and an unclaimed invite is inert rather than
//    dangerous.
//
// The holder is deliberately NOT in this list. holder_email is its own field,
// written at birth, and it is the thing a grant can never make you. Ownership is
// a badge, access is the gate.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';

export const OWNERSHIP = (stateDir) => join(stateDir, 'ownership.json');

// Deliberately permissive on the local part (plus-addressing, dots and dashes are
// all legitimate and all in real use here) and strict about the things that would
// let a value escape a shell or a sed: whitespace, quotes, backslashes, | and &.
export const EMAIL_RE = /^[^\s|&"'\\@]+@[^\s|&"'\\@]+\.[^\s|&"'\\@]+$/;

export const ROLES = ['member', 'admin'];

export const normEmail = (e) => String(e ?? '').trim().toLowerCase();

export function readOwnership(stateDir) {
  const raw = readFileSync(OWNERSHIP(stateDir), 'utf8');
  const o = JSON.parse(raw);
  if (!Array.isArray(o.grants)) o.grants = [];
  // THE HOLDER IS WRITTEN NESTED AND WAS READ FLAT. Birth (claimOwner) records
  //   "holder": { "kind": "account", "account_id": "", "email": "..." }
  // while every reader in this file asks for o.holder_email. On a born rock that
  // is undefined, so the box believed it had NO holder:
  //   - `grants-cli who` answered {"who": []} on a mineral whose directory record
  //     names its holder;
  //   - the directory mirror omitted the owner from its rows entirely, pushing
  //     only the grantees;
  //   - and the "that address already holds this mineral" guard could never fire,
  //     so the holder could be granted a duplicate row against themselves.
  // Proven on qa-rock-a 2026-08-11. Normalised here, at the single read, rather
  // than at the eight call sites. The nested object stays the written shape; this
  // just stops the flat field being the only one anybody looked for.
  if (!o.holder_email && o.holder && typeof o.holder === 'object' && o.holder.email) {
    o.holder_email = String(o.holder.email);
  }
  return o;
}

// Atomic: a half-written ownership.json is a box that cannot say who owns it, and
// it is read on every boot. Write beside it and rename over, so a crash mid-write
// leaves the previous file intact rather than a truncated one.
export function writeOwnership(stateDir, o) {
  const p = OWNERSHIP(stateDir);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(o, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, p);
  return o;
}

export const listGrants = (stateDir) => readOwnership(stateDir).grants;

/**
 * Record an intent to give `email` access. Idempotent by address: granting the
 * same person twice updates the role rather than creating a second row, because
 * two rows for one address is a revoke that only half works.
 */
export function grant(stateDir, email, role = 'member', now = new Date().toISOString()) {
  const e = normEmail(email);
  if (!EMAIL_RE.test(e)) throw new Error(`that email address does not look right: ${email}`);
  if (!ROLES.includes(role)) throw new Error(`role must be one of: ${ROLES.join(', ')}`);
  const o = readOwnership(stateDir);
  // The holder already has everything a grant could give. Silently adding a row
  // for them would make the access list read as though their access came from a
  // grant, and a later revoke of it would look like it should work.
  if (normEmail(o.holder_email) && normEmail(o.holder_email) === e) {
    throw new Error('that address already holds this mineral; a holder needs no grant');
  }
  const existing = o.grants.find((g) => normEmail(g.email) === e);
  if (existing) {
    existing.role = role;
    existing.updated_at = now;
  } else {
    o.grants.push({ email: e, role, status: 'pending', added_at: now });
  }
  return writeOwnership(stateDir, o);
}

/**
 * The mailbox was proven, so the intent becomes access. Separate from grant() on
 * purpose: only something that has verified a session for this address may call
 * it, and keeping it its own verb means no code path can create a live grant in
 * one step by accident.
 */
export function activate(stateDir, email, now = new Date().toISOString()) {
  const e = normEmail(email);
  const o = readOwnership(stateDir);
  const g = o.grants.find((x) => normEmail(x.email) === e);
  if (!g) throw new Error(`no grant is waiting for ${e}`);
  g.status = 'active';
  g.activated_at = now;
  return writeOwnership(stateDir, o);
}

/**
 * Remove an account's access entirely. Returns the removed row so the caller can
 * cascade: every machine that account enrolled has to go with it, or revoking
 * access leaves working keys behind and means nothing.
 */
export function revoke(stateDir, email) {
  const e = normEmail(email);
  const o = readOwnership(stateDir);
  const i = o.grants.findIndex((g) => normEmail(g.email) === e);
  if (i === -1) throw new Error(`${e} has no grant on this mineral`);
  const [removed] = o.grants.splice(i, 1);
  writeOwnership(stateDir, o);
  return removed;
}

/**
 * Take an UNHELD mineral. Every box built before birth-writes-the-holder came up
 * with no holder_email at all, which leaves it invisible to the account pages and
 * impossible to grant from, forever, because grant-is-the-gate and there is
 * nothing to gate on. Verified live on a real rock 2026-08-11:
 * `holder_email: None  grants: None`.
 *
 * Deliberately NOT an inference. Reading an address out of deployment.yaml is
 * right in the ordinary case and catastrophic in the unusual one: it would hand a
 * mineral to whoever the guess named, silently and permanently. So the general
 * mechanism is a claim by someone who has PROVEN that mailbox, and the refusal
 * below is the whole safety property.
 *
 * REFUSES on an already-held mineral. Not "updates", not "reassigns": changing a
 * holder is a transfer, which needs consent from both sides and is its own verb
 * elsewhere. A claim that could overwrite would be a way to steal a box by being
 * second.
 */
export function claim(stateDir, email, now = new Date().toISOString()) {
  const e = normEmail(email);
  if (!EMAIL_RE.test(e)) throw new Error(`that email address does not look right: ${email}`);
  const o = readOwnership(stateDir);
  const held = normEmail(o.holder_email);
  if (held && held !== e) {
    throw new Error(`this mineral is already held by ${held}; changing that is a transfer, not a claim`);
  }
  if (held === e) return o;   // idempotent: claiming what you already hold is a no-op, not an error
  o.holder_email = e;
  o.claimed_at = now;         // says the holder arrived by claim rather than at birth
  return writeOwnership(stateDir, o);
}

/** Everyone who may open this mineral right now, holder first. */
export function whoCanOpen(stateDir) {
  const o = readOwnership(stateDir);
  const holder = normEmail(o.holder_email);
  return [
    ...(holder ? [{ email: holder, role: 'holder', status: 'active' }] : []),
    ...o.grants.filter((g) => g.status === 'active'),
  ];
}

// ---- the directory mirror is GONE (self-host strip, 2026-09-01) -------------
//
// The central directory at directory.crads-ai.com is deleted, along with the
// whole account system. Everything in this section that used to push there —
// mirrorToDirectory (removed 2026-08-20 for conflating access with membership),
// mirrorNow's /mineral-register relay (enrol-sync's, retired with enrol-sync),
// and drainProofs (the /grant-proofs poll that turned a site sign-in into an
// activated grant) — has no far end any more and was removed rather than left
// to error. The functions are gone rather than emptied so nothing can call
// them back into life by accident.
//
// What remains is the on-disk truth this file always owned: ownership.json is
// the ONE record of who may open this mineral, and activation happens locally
// (the `activate` verb), driven by whatever surface the box trusts — never by
// a platform record, because there is no platform record.

/**
 * THIS MINERAL'S ORG HANDLE, or '' if it has none (2026-08-13). The handle and
 * the host are INDEPENDENT: provision-rock defaults ORG_HANDLE to the slug but
 * lets them differ, so nothing may derive the handle by chopping the host.
 * Kept after the mirror went: it is the one honest reader of the handle a
 * local surface can call.
 */
export function orgHandle(brainRoot = '/state/brain') {
  try {
    const policy = readFileSync(join(brainRoot, 'org-policy.yaml'), 'utf8');
    return (policy.match(/^\s*name:\s*"?([^"\n#]+)"?/m) || [])[1]?.trim() || '';
  } catch { return ''; }
}

/**
 * Revoking access has to reach the keys, or it means nothing: a machine keeps
 * opening the box long after the account that enrolled it was removed. Sam's
 * scenario 3, and the reason revoke() returns the row rather than a boolean.
 *
 * ONLY machines that NAME the account are touched. Devices enrolled before
 * account-bound access carry no account at all, and cutting those would be a
 * guess that locks somebody else out. They are counted and REPORTED instead, so
 * the caller can say "three other machines can still open this, and I cannot
 * tell whose they are" rather than implying a clean sweep.
 */
export async function revokeWithCascade(stateDir, email, opts = {}) {
  const e = normEmail(email);
  const removed = revoke(stateDir, e);                       // throws if there is no grant: nothing to cascade from
  const roster = opts.roster || await import('../devices/roster.mjs');
  let cut = [];
  let unattributed = 0;
  try {
    const devices = roster.listDevices(stateDir).filter((d) => d.status !== 'revoked');
    for (const d of devices) {
      if (normEmail(d.account) === e) { roster.revokeDevice(stateDir, d.slug); cut.push(d.slug); }
      else if (!normEmail(d.account)) unattributed += 1;
    }
  } catch (err) {
    return { removed, cut, unattributed, error: `the grant is gone but the roster could not be read (${err.message})` };
  }
  return { removed, cut, unattributed };
}

// WHAT THIS FILE DELIBERATELY DOES NOT DO (updated 2026-09-01).
//
// It speaks to no service at all. It once left registration and the mineral
// record to enrol-sync (the one-mouth rule, 2026-08-11); since the self-host
// strip there is no directory and no mouth. Grants, ownership and access live
// on this disk and nowhere else.
