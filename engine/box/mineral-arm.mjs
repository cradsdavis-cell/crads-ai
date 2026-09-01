// mineral-arm.mjs — give a PEBBLE the three facts its directory leg gates on.
//
// THE GAP THIS CLOSES (found 2026-08-12, from the operator's minerals table
// showing three rocks and no pebble). A mineral only appears in the directory
// because enrol-sync pushed it there, and enrol-sync is gated twice:
//
//   scheduler.mjs   [ -f <state>/secrets/box_directory_token ] || the leg never runs
//   enrol-sync.mjs  no token or no 64-hex owner_e            -> { skipped: true }
//   enrol-sync.mjs  identityFacts().holder falsy             -> the mirror is skipped
//
// Every one of those three was satisfied on a rock by boot-rock.sh and by
// NOTHING on a pebble. The pebble path (provision-pebble.sh -> cloud-init)
// writes no secrets at all, and seed-pages.mjs records the holder as the flat
// string `holder_email`, which is not the nested object identityFacts() reads.
// So a pebble came up healthy from the inside, with a working ssh door, and:
//
//   - no mineral: row in the directory, so /app/minerals was empty for its
//     owner and the operator's admin table could not see it existed;
//   - no way in by ACCOUNT, because grant-is-the-gate and the grant lives on
//     the mineral record that was never mirrored.
//
// That is finding 34 one tier down, and it failed the same silent way: the box
// logs nothing, because "not opted in" is a legitimate state for a box that
// genuinely has no directory.
//
// WHY IT LIVES IN THE IMAGE, not in cloud-init. Same reason as the machinery
// block in box-up.sh: a file written once into user-data freezes there, so a
// fix reaches new minerals only, and user-data is 85 bytes from its ceiling.
// Running here means the fix arrives with the nightly auto-update, and a
// pebble that was born before this heals on its next restart.
//
// TIER-BLIND on purpose. A brokered promotion never changes the entrypoint, so
// box-up.sh (and this) still run on a promoted rock. A rock is a box someone
// owns too, and arming it twice is a no-op: every write below is guarded.
//
//   node mineral-arm.mjs [stateDir]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readOwnership, claimOwner, emailHash } from '../lib/mineral-identity.mjs';

// | and & are refused rather than escaped, the same rule provision-pebble.sh
// applies to the same address: a value that could rewrite what carries it is a
// build to refuse, not a string to quote.
export const EMAIL_RE = /^[^\s@|&]+@[^\s@|&]+\.[^\s@|&]+$/;

// DOTTED, deliberately stricter than the directory's own HOST_RE
// (/^[a-z0-9][a-z0-9.-]{0,62}$/), which a docker id like 1c8db1bea6a3 passes
// happily. This name is not decoration: enrol-sync sends it as ssh.hostname and
// device-enrol.mjs writes it into the member's Host block, so a name that
// cannot be dialled is a device that cannot connect. A container id would also
// change on every recreate, minting a fresh directory row each time. Better to
// register nothing than to register a name that is wrong twice over.
export const REG_HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9-]{0,62})+$/;

const readTrim = (p) => { try { return readFileSync(p, 'utf8').trim(); } catch { return ''; } };

/**
 * Arm this mineral's directory leg. Idempotent, and safe to run on every boot.
 *
 * Returns { armed, reason?, claimed, host?, wrote[] } rather than throwing: a
 * box that cannot be armed yet is a normal state (holderless, or born before
 * its hostname was staged), and boot must not fail on it.
 */
export function armMineral(stateDir, {
  env = process.env,
  // 32 random bytes, base64, non-alphanumerics dropped — the same shape
  // boot-rock.sh mints. The directory refuses anything under 24 chars.
  mint = () => randomBytes(32).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 40),
} = {}) {
  const secrets = path.join(stateDir, 'secrets');
  const at = (f) => path.join(secrets, f);
  const rec = readOwnership(stateDir);
  const holder = rec.holder && typeof rec.holder === 'object' ? rec.holder : null;

  // An org-HELD mineral is the rock's to enrol: its owner is a company, not an
  // account, and owner_e has no honest value here. (Org-MANAGED member pebbles
  // are the normal Practice Partner shape and are held by the member, so they
  // arm like any other.)
  if (holder && holder.kind === 'org') {
    return { armed: false, claimed: false, wrote: [], reason: 'org-held: enrolment rides the rock path' };
  }

  // WHOSE mineral this is. The nested holder wins; then the flat field
  // seed-pages wrote at birth; then what the ANCHORING ROCK pushed down when the
  // member claimed; then what provisioning staged in the env. All of them name
  // the same person when they are present at all.
  //
  // THE ROCK-PUSHED SOURCE IS WHY A CLAIMED PEBBLE CAN ARM AT ALL (finding 100,
  // 2026-08-13). A brokered pebble is born with no address: provisioning stages
  // none, and seed-pages has nobody to name yet. The comment below has always
  // said "Claiming it in the app arms it", and claiming did every other part of
  // the job (device key minted, ssh door open, rock's registry flipped to
  // active) while never telling the BOX whose it was. So this returned
  // holderless forever, no registration secrets were written, and the member's
  // own /app/minerals stayed empty for good.
  //
  // orchestrator/push-member-key.mjs on the rock now writes the address into the
  // member's inbox on every approval, and the pebble clones that inbox, so this
  // reads it off disk with no new channel, no new credential and no new trust
  // direction. Rock-pushed ranks BELOW anything already on the box: a box that
  // already names a holder is never re-attributed from outside.
  const pushedHolder = readTrim(path.join(stateDir, 'org-inbox', 'identity', 'holder_email'));
  const email = String(
    (holder && holder.email) || rec.holder_email || pushedHolder
      || env.AIOS_OWNER_EMAIL || env.AIOS_OPERATOR_EMAIL || '',
  ).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    // Honest, not broken: a box whose birth staged no address is holderless
    // rather than falsely attributed. Claiming it in the app arms it.
    return { armed: false, claimed: false, wrote: [], reason: 'holderless: no account address on this mineral yet' };
  }

  // Upgrade the flat record to the shape identityFacts() reads. claimOwner also
  // mints the serial and gives the holder their owner grant, so this is what
  // turns holder_email from a note into access. First claim wins, so a mineral
  // that already names someone else is never quietly re-owned here.
  let claimed = false;
  if (!holder) {
    const r = claimOwner(stateDir, { kind: 'account', email });
    if (!r.ok) return { armed: false, claimed: false, wrote: [], reason: r.reason };
    claimed = true;
  }

  // The durable, dialable name. An already-written file wins (an operator may
  // have set it by hand on a box born before this), then what provisioning
  // staged. NO DOMAIN FALLBACK, the same rule boot-rock.sh states: this is
  // product code in a generic image, and defaulting to any one operator's
  // domain would make every box of every deployment claim a name under it.
  const existingHost = readTrim(at('box_reg_host')).toLowerCase();
  const host = existingHost || String(env.AIOS_BOX_HOST || '').trim().toLowerCase();
  if (!REG_HOST_RE.test(host)) {
    return {
      armed: false, claimed, wrote: [],
      reason: 'no dialable hostname: this box was staged without AIOS_BOX_HOST, so it cannot register a name',
    };
  }

  mkdirSync(secrets, { recursive: true });
  const wrote = [];
  if (!existingHost) { writeFileSync(at('box_reg_host'), host, { mode: 0o600 }); wrote.push('box_reg_host'); }
  if (!/^[0-9a-f]{64}$/.test(readTrim(at('owner_e')))) {
    // A HASH, never the address: the directory only needs to know whether the
    // account asking is the same one, and the platform holds no list of who
    // owns what.
    writeFileSync(at('owner_e'), emailHash(email), { mode: 0o600 });
    wrote.push('owner_e');
  }
  // THE TOKEN IS WRITTEN LAST, and the order is the point. It is what the
  // scheduler's guard tests, so writing it first would let the leg run against
  // a half-armed box: enrol-sync would find no owner_e and report "skipped"
  // forever, which reads exactly like a box that opted out.
  if (!readTrim(at('box_directory_token'))) {
    const tok = mint();
    if (String(tok).length < 24) throw new Error('minted directory token is too short; the directory refuses under 24 chars');
    writeFileSync(at('box_directory_token'), tok, { mode: 0o600 });
    wrote.push('box_directory_token');
  }
  return { armed: true, claimed, host, wrote };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stateDir = path.resolve(process.argv[2] || process.env.AIOS_STATE_DIR || '/state');
  let r;
  try { r = armMineral(stateDir); } catch (e) { console.log(`mineral-arm: ${String(e.message || e)}`); process.exit(0); }
  if (r.armed) {
    console.log(`mineral-arm: registered as ${r.host}`
      + (r.wrote.length ? ` (wrote ${r.wrote.join(', ')})` : ' (already armed)')
      + (r.claimed ? ' · holder recorded' : ''));
  } else {
    // Said out loud. The whole class of bug above was silent.
    console.log(`mineral-arm: not registering: ${r.reason}`);
  }
}
