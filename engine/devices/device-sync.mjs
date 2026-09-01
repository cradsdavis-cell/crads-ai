#!/usr/bin/env node
// device-sync.mjs: derive <state>/ssh/member/authorized_keys from the roster.
//
// THE SINGLE WRITER of that file. sshd on the host serves it per authentication
// attempt via AuthorizedKeysCommand (docs/state-managed-ssh-keys.md), so add and
// revoke are instant and need no reload and no host access.
//
// Two sources feed it, both of which the member owns and can see:
//   devices/*.yaml          the enrolled devices (git-tracked, auditable)
//   support/access.json     the current consent-gated Crads support grant, if live
// Before this module, support-access.mjs wrote the file itself, so any roster
// write would have silently dropped a live support grant (and vice versa).
//
//   node device-sync.mjs <stateDir>
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listDevices, writeDevice, fingerprintOf, PUBKEY_RE } from './roster.mjs';
import { resolveBrainRoot } from '../lib/brain-root.mjs';

// THE OPERATOR DOOR HAS TWO REGISTRIES, AND THIS FILE ONLY KNEW ONE.
//
// A rock's founder key is seeded at birth by cloud-init into BOTH
// /state/ssh/aios-op/authorized_keys AND <brain>/people/founder.yaml, because
// at that moment the container is not up and the people registry is the durable
// record. The device roster in /state/devices/ is a DIFFERENT registry, and it
// is empty on a newborn rock. So the first syncKeys() on a rock derived the
// operator door from the device roster alone and dropped the founder key.
//
// That is not a degraded door, it is a brick: cloud-init has already applied
// 61-aios-roster-only.conf (AuthorizedKeysFile none) precisely so the roster is
// the only authority, and these boxes carry NO root SSH at all. Proven live on
// test-rock-003-2 (2026-08-11): seed the founder key, run this file with an
// empty roster, authorized_keys goes 96 bytes -> 0.
//
// Sam hit it on his own rock the same day: "Waiting to be let in", with
// aios-op@... Permission denied, on a box whose key was correctly minted,
// correctly passed to cloud-init and correctly installed. An enrolment had
// completed (enroldone: in the directory KV), which is what called syncKeys.
/**
 * The door's OTHER two sources, named, for the account page (2026-08-12).
 *
 * A rock's door is derived from three registries and the account page showed
 * one. The birth key seeded by cloud-init lives in people/*.yaml, and the Crads
 * support grant lives in support/access.json; neither is a roster row, so
 * neither could ever appear. A Devices page that lists the computers people
 * added while staying silent about two other working keys is not a shorter
 * truth, it is a different one. Sam's ruling, 2026-08-12: show everything that
 * can open the box, and show support as an explicit off when no grant is live,
 * so its absence is never ambiguous.
 *
 * Names and dates only, same rule as the roster mirror: no key material, and
 * fingerprints only in salted machine_id form, which the caller derives.
 */
export function doorSources(stateDir) {
  return {
    founders: peopleEntries(stateDir).map((p) => ({ name: p.name, fingerprints: p.keys.map(fingerprintOf) })),
    support: supportGrant(stateDir),
  };
}

/** The live support grant as a fact, or an explicit off. */
export function supportGrant(stateDir) {
  try {
    const log = JSON.parse(readFileSync(join(stateDir, 'support', 'access.json'), 'utf8'));
    const g = log?.grant;
    if (!g || !g.key || new Date(g.expires_at) <= new Date()) return { active: false, expires_at: '' };
    return { active: true, expires_at: String(g.expires_at) };
  } catch { return { active: false, expires_at: '' }; }
}

/** people/*.yaml as { name, keys[] }, ACTIVE only. peopleKeys is the flat view. */
function peopleEntries(stateDir) {
  // brain root from the shared resolver (engine/lib/brain-root.mjs) — the
  // same answer the scheduler and every verb get, member-born leg included,
  // so a box that moved its brain OR a promoted rock whose brain is the box
  // root is still read correctly.
  const brain = resolveBrainRoot(stateDir);
  let files = [];
  try { files = readdirSync(join(brain, 'people')).filter((f) => /\.ya?ml$/.test(f) && !f.startsWith('_')); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    let t = '';
    try { t = readFileSync(join(brain, 'people', f), 'utf8'); } catch { continue; }
    // Only ACTIVE people open doors. A revoked founder must stay revoked, which
    // is the whole point of people-revoke having a last-active-Admin guard.
    if (!/^status:\s*"?active"?\s*$/m.test(t)) continue;
    const block = t.split(/^pubkeys:\s*$/m)[1];
    if (!block) continue;
    const keys = [];
    for (const line of block.split('\n')) {
      if (/^\s*-\s/.test(line)) {
        const k = line.replace(/^\s*-\s*/, '').trim().replace(/^"(.*)"$/, '$1');
        if (/^ssh-/.test(k)) keys.push(k);
      } else if (line.trim() && !/^\s/.test(line)) break;   // next top-level key
    }
    if (!keys.length) continue;
    const name = (t.match(/^name:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim() || f.replace(/\.ya?ml$/, '');
    out.push({ name, keys });
  }
  return out;
}

/** Every key a person registry contributes to the door, flat. */
function peopleKeys(stateDir) {
  return peopleEntries(stateDir).flatMap((p) => p.keys);
}

/**
 * Would revoking `slug` leave sshd with no key at all?
 *
 * ASK THIS BEFORE WRITING THE ROSTER, NOT AFTER (2026-08-12). syncKeys already
 * refuses to write an empty door, which is right: these boxes have no root SSH,
 * so a zero-byte authorized_keys is unrecoverable except through provider
 * rescue. But that refusal happens AFTER the caller has already stamped the row
 * revoked, and it is silent. The staged web revoke (enrol-sync's revoke leg)
 * hit exactly that: the roster said revoked, the directory mirrored revoked,
 * the account page reported the machine gone, and the key was still in the
 * door. A page that says a machine has lost access while it can still open the
 * box is worse than either honest outcome, so the revoke is refused up front
 * instead.
 *
 * Counts the two PERMANENT sources. A live support grant is deliberately not
 * counted: it carries an sshd expiry, so a box left standing on it alone is a
 * box that locks itself out when the grant runs out.
 *
 * roster-cli's own revoke keeps its stricter last-device guard: it counts
 * devices only, so on a rock it refuses a little earlier than this does. Being
 * conservative in the expert CLI costs nothing, and its error says what to do.
 */
export function revokeWouldEmptyDoor(stateDir, slug) {
  const others = listDevices(stateDir).filter((d) => d.slug !== slug
    && d.status === 'active' && PUBKEY_RE.test(String(d.pubkey ?? '')));
  if (others.length) return false;
  return peopleKeys(stateDir).length === 0;
}

// sshd expiry-time, UTC (trailing Z): YYYYMMDDHHMM. Same format support-access.mjs used.
const stamp = (iso) => new Date(iso).toISOString().replace(/[-:T]/g, '').slice(0, 12) + 'Z';

export function supportLine(stateDir) {
  try {
    const log = JSON.parse(readFileSync(join(stateDir, 'support', 'access.json'), 'utf8'));
    const g = log?.grant;
    if (!g || !g.key || new Date(g.expires_at) <= new Date()) return '';
    return `expiry-time="${stamp(g.expires_at)}" ${g.key}`;
  } catch { return ''; }
}

// The derived ssh dir must never be committed to the member's brain repo (which
// may be pushed to their own remote). Idempotent, and never rewrites the file.
function ensureIgnored(stateDir) {
  const p = join(stateDir, '.gitignore');
  try {
    const cur = existsSync(p) ? readFileSync(p, 'utf8') : '';
    if (/^ssh\/$/m.test(cur)) return;
    appendFileSync(p, (cur && !cur.endsWith('\n') ? '\n' : '') + 'ssh/\n');
  } catch { /* a read-only or absent brain root is not a reason to fail a key sync */ }
}

// The ORG's half of the door, as a GATE rather than a key source.
//
// An org-anchored box has two authorities over one file, and they used to fight:
// this module derives the door from the member's roster, and org-sync.sh rewrote
// the SAME file every two minutes from the org's approved-key list. Proven live
// 2026-08-04: enrolling a device locked the member out immediately (this module
// dropped the org-installed key), and sixty seconds later org-sync handed access
// back and dropped the device that had just been added. The dangerous direction
// is revoke: a member revokes a stolen laptop, this module removes it, and the
// next even minute org-sync restores it from the org's list. Revoke did not
// revoke. It also silently killed any live support grant, which is the exact
// failure device-sync was created to end.
//
// Resolution, matching who owns what: the MEMBER owns which of their devices are
// enrolled, and the ORG owns whether the door is open at all (pause, leave,
// revoke, all of which push an EMPTY key file into the inbox). So the org's file
// is read here only as a gate, never as a key list.
export function orgDoorShut(stateDir) {
  const membership = join(stateDir, 'org-inbox', 'MEMBERSHIP.yaml');
  if (!existsSync(membership)) return false;          // not org-anchored: the member decides alone
  try {
    const y = readFileSync(membership, 'utf8');
    const status = (y.match(/^status:\s*"?([a-z]+)"?/m) || [, 'active'])[1];
    if (status !== 'active') return true;             // paused / left / revoked
  } catch { /* unreadable membership is not a reason to shut a working door */ }
  // An org that has shut the door pushes an EMPTY keys file; absent means the org
  // has not spoken yet (a fresh box mid-enrolment), which must not lock anyone out.
  const orgKeys = join(stateDir, 'org-inbox', 'keys', 'member.authorized_keys');
  if (!existsSync(orgKeys)) return false;
  try { return readFileSync(orgKeys, 'utf8').trim() === ''; } catch { return false; }
}

// The org's approved keys, ADOPTED onto the roster once each.
//
// Separating the two writers (above) fixed revoke and broke first-run, because it
// left the roster as the only key source and a brand-new member has no roster.
// Their one device arrives the admin-first way: they redeem an invite, the admin
// confirms the 6-char code, and the rock writes that public key into the inbox.
// Read purely as a gate, that key opened nothing, so the door derived empty and
// the member was locked out of their own box forever while the panel promised
// them "installs on the next box sync (~2 min)". Every member added by a rock
// hit this. Found by being one.
//
// Adoption, not mirroring, is what keeps revoke fixed. A key is adopted ONCE:
// the roster row is then the member's, and if they revoke that laptop the row
// stays (status revoked) and is never adopted again. So the org can open the
// door for a new device, and only the member can close it on one of theirs.
// Mirroring every sync is exactly the race that locked people out.
function adoptOrgApprovedKeys(stateDir, today) {
  const src = join(stateDir, 'org-inbox', 'keys', 'member.authorized_keys');
  if (!existsSync(src)) return 0;
  let lines;
  try { lines = readFileSync(src, 'utf8').split('\n'); } catch { return 0; }
  // Every fingerprint the roster has EVER held, whatever its status: a revoked
  // row must block re-adoption, or revoke would undo itself on the next sync.
  const known = new Set(listDevices(stateDir).map((d) => d.fingerprint).filter(Boolean));
  const slugs = new Set(listDevices(stateDir).map((d) => d.slug));
  // WHAT THE MEMBER CALLS EACH MACHINE (finding 116, 2026-08-13). Pushed down
  // beside the keys by the rock, FINGERPRINT<TAB>NAME per line. Absent for a
  // rock that has not been updated yet, and for every device approved before
  // this shipped, so the status phrase below stays as the fallback — but it is
  // now a fallback rather than the only answer. Read once, not per key.
  const pushedNames = (() => {
    const m = new Map();
    try {
      for (const line of readFileSync(join(stateDir, 'org-inbox', 'keys', 'member.device_names'), 'utf8').split('\n')) {
        const i = line.indexOf('\t');
        if (i <= 0) continue;
        const fp = line.slice(0, i).trim(); const nm = line.slice(i + 1).replace(/[^\x20-\x7E]/g, '').trim().slice(0, 60);
        if (fp && nm) m.set(fp, nm);
      }
    } catch { /* no names file: the fallback below is correct */ }
    return m;
  })();
  // WHOSE MACHINE THIS IS (QA finding 146's third lane, 2026-08-17). Rows adopted
  // here landed with account "", so revokeWithCascade in engine/box/grants.mjs
  // could never cut one and every rock-approved machine counted `unattributed`.
  // enrol-sync's comment said this lane "genuinely cannot know whose key it is",
  // and that was wrong: the rock pushes the member's own address into this same
  // inbox, in the same commit as the keys, as identity/holder_email. One member,
  // one inbox repo, one registry row, so every key in member.authorized_keys is
  // that member's by construction rather than by inference. mineral-arm.mjs has
  // read this file since it was written, which is what makes it a fact this box
  // already holds rather than a signal somebody would have to add.
  //
  // Verified live on the qa-r2-gmail rock, 2026-08-17: its own
  // orchestrator/push-member-key.mjs writes the file (lines 108-109), so this
  // works on rocks in the field with no brain-template change and no template
  // propagation, which for an existing rock does not exist.
  //
  // Read at ADOPTION time and never re-stamped: the row records who enrolled the
  // machine, not who holds the box today, so a later transfer must not rewrite it.
  const pushedAccount = (() => {
    let v = '';
    try { v = readFileSync(join(stateDir, 'org-inbox', 'identity', 'holder_email'), 'utf8').trim().toLowerCase(); }
    catch { return ''; }
    // Shape-checked, because an unreadable value silently stored here is worse
    // than none: the cascade would compare against noise and cut nothing while
    // reporting a clean sweep.
    return /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/.test(v) ? v : '';
  })();
  let adopted = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // The org's file can also carry an expiry-time support grant; that is not a
    // member device and must never become a roster row.
    if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( \S.*)?$/.test(line)) continue;
    const fp = fingerprintOf(line);
    if (!fp || known.has(fp)) continue;
    // The row becomes a FILENAME, and a base64 fingerprint carries '/' and ':'
    // (caught by the existing gate test, which crashed device-sync outright and
    // would have taken the whole door down on any real key that hashed with a
    // slash). Reduce it to something a filesystem accepts, keeping enough of the
    // fingerprint to stay unique and greppable against the roster.
    const named = pushedNames.get(fp) || '';
    // The name makes the slug too, matching the self-serve path (enrol-sync
    // derives its slug from device_name), so the roster reads the same however
    // the device arrived. Fall back to the fingerprint slug when unnamed.
    let slug = named
      ? (named.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'this-computer')
      : 'approved-' + fp.replace(/^sha256:/i, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
    while (slugs.has(slug)) slug += 'x';
    writeDevice(stateDir, {
      // An UNNAMED row still has to be tellable apart from the next unnamed row:
      // "Approved by your rock" on every one of them is what made the revoke
      // list unusable in the first place, so the safety code rides the label.
      slug, label: named || ('Approved by your rock · ' + fp.replace(/^sha256:/i, '').toUpperCase().slice(0, 6)),
      status: 'active',
      added: today, revoked: '', last_seen: '', vaultkey: '', pubkey: line,
      account: pushedAccount,
    });
    known.add(fp); slugs.add(slug); adopted += 1;
  }
  return adopted;
}

export function syncKeys(stateDir) {
  const shut = orgDoorShut(stateDir);
  // Adopt before deriving, so a key approved this minute opens the door this
  // minute. Never while the org has the door shut: a paused or removed member
  // must not gain a roster row out of a stale file.
  const adopted = shut ? 0 : adoptOrgApprovedKeys(stateDir, new Date().toISOString().slice(0, 10));
  const active = shut ? [] : listDevices(stateDir).filter((d) => d.status === 'active' && d.pubkey);
  const sup = shut ? '' : supportLine(stateDir);
  // The people registry is the OTHER half of the door (see peopleKeys above).
  // Union, de-duplicated: a founder who later enrols the same key as a device
  // must not appear twice.
  const people = shut ? [] : peopleKeys(stateDir);
  const lines = [...new Set(active.map((d) => d.pubkey).concat(people).concat(sup ? [sup] : []))];
  // WHICH DOOR THIS ROSTER OPENS DEPENDS ON THE TIER. sshd serves
  // /state/ssh/<login>/authorized_keys, and a rock's login is aios-op while a
  // pebble's is member. This derived the member file unconditionally, so a
  // device enrolled on a ROCK landed in a file sshd never reads for that login:
  // enrol-sync said "ADDED ... the new device can connect" and the machine still
  // could not. Found live on a real rock 2026-08-11, admitting the operator's own laptop
  // to his own rock.
  //
  // Read from ownership.json rather than guessed from the slug, because the box
  // is the authority on what it is (the promote ruling), and a promoted box must
  // follow its record rather than its name.
  const tier = (() => {
    try { return JSON.parse(readFileSync(join(stateDir, 'ownership.json'), 'utf8')).tier || ''; }
    catch { return ''; }
  })();
  const login = tier === 'rock' ? 'aios-op' : 'member';
  const dir = join(stateDir, 'ssh', login);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'authorized_keys');
  const next = lines.length ? lines.join('\n') + '\n' : '';
  // NEVER EMPTY A DOOR THAT CURRENTLY OPENS. sshd is pointed at this file and
  // nothing else (AuthorizedKeysFile none), and these boxes have no root SSH,
  // so a zero-byte write here is unrecoverable except through provider rescue
  // mode. Every legitimate reason to reach zero (the org shut the door, the last
  // device revoked) is better served by leaving the last key in place and being
  // loud about it than by bricking the box: a door with one stale key is a
  // problem you can still fix from inside, a brick is not.
  //
  // This is the same instinct as the last-active-Admin guard on people-revoke,
  // applied at the point the file is actually written rather than at one of the
  // callers, because the callers keep multiplying.
  let prev = '';
  try { prev = readFileSync(path, 'utf8'); } catch { /* first write */ }
  if (!next.trim() && prev.trim()) {
    ensureIgnored(stateDir);
    return { devices: active.length, support: !!sup, path, adopted,
      refused: 'refused to empty the door: kept the existing keys' };
  }
  writeFileSync(path, next);
  ensureIgnored(stateDir);
  return { devices: active.length, support: !!sup, path, adopted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = syncKeys(process.argv[2] || '/state');
  console.log(`device-sync: ${r.devices} device key(s)${r.support ? ' + a live support grant' : ''}`
    + `${r.adopted ? ` (adopted ${r.adopted} approved by the rock)` : ''}`
    + `${r.refused ? `; ${r.refused}` : ''}`);
}
